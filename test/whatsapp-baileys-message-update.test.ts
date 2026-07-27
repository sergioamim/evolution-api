import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBaileysMessageUpdateCacheKey,
  dispatchBaileysInboundWebhookBeforeSideEffects,
  dispatchBaileysMessageUpdate,
  normalizeBaileysInboundMessageRemoteJid,
  resolveBaileysMessageUpdateRemoteJid,
  shouldAdvanceBaileysMessageStatus,
} from '../src/api/integrations/channel/whatsapp/baileys-message-update';

describe('atualizações de status de mensagem do Baileys', () => {
  it('avança o status persistido sem regredir ACKs já confirmados', () => {
    assert.equal(shouldAdvanceBaileysMessageStatus('PENDING', 'SERVER_ACK'), true);
    assert.equal(shouldAdvanceBaileysMessageStatus('SERVER_ACK', 'DELIVERY_ACK'), true);
    assert.equal(shouldAdvanceBaileysMessageStatus('DELIVERY_ACK', 'READ'), true);
    assert.equal(shouldAdvanceBaileysMessageStatus('READ', 'SERVER_ACK'), false);
    assert.equal(shouldAdvanceBaileysMessageStatus('READ', 'ERROR'), false);
    assert.equal(shouldAdvanceBaileysMessageStatus('ERROR', 'SERVER_ACK'), true);
    assert.equal(shouldAdvanceBaileysMessageStatus('ERROR', 'PENDING'), false);
    assert.equal(shouldAdvanceBaileysMessageStatus('READ', 'READ'), false);
  });

  it('usa o JID canônico salvo para ACK recebido por LID', () => {
    assert.equal(
      resolveBaileysMessageUpdateRemoteJid('144710433824832@lid', '5521983424242@s.whatsapp.net'),
      '5521983424242@s.whatsapp.net',
    );
    assert.equal(resolveBaileysMessageUpdateRemoteJid('144710433824832@lid', null), '144710433824832@lid');
  });

  it('não cria chave de deduplicação com status undefined', () => {
    assert.equal(
      buildBaileysMessageUpdateCacheKey('instance-id', 'message-id', undefined, null),
      'instance-id_message-id_DELETED',
    );
    assert.equal(
      buildBaileysMessageUpdateCacheKey('instance-id', 'message-id', undefined, { conversation: 'oi' }),
      'instance-id_message-id_CONTENT',
    );
  });

  it('normaliza o JID LID inbound antes de publicar o callback', () => {
    const payload = {
      key: {
        remoteJid: '144710433824832@lid',
        remoteJidAlt: '5521983424242@s.whatsapp.net',
        addressingMode: 'lid',
      },
      message: { conversation: 'oi' },
    };

    normalizeBaileysInboundMessageRemoteJid(payload);

    assert.deepEqual(payload.key, {
      remoteJid: '5521983424242@s.whatsapp.net',
      remoteJidAlt: '144710433824832@lid',
      addressingMode: 'pn',
    });
  });

  it('publica texto inbound antes de efeitos locais que possam falhar', async () => {
    const webhooks: unknown[] = [];
    const payload = {
      key: {
        remoteJid: '5521983424242@s.whatsapp.net',
      },
      message: { conversation: 'oi' },
    };

    const result = await dispatchBaileysInboundWebhookBeforeSideEffects({
      payload,
      requiresEnrichment: false,
      sendWebhook: (event) => webhooks.push(event),
    });

    await assert.rejects(async () => {
      throw new Error('database unavailable');
    });

    assert.deepEqual(webhooks, [payload]);
    assert.equal(result.dispatched, true);
  });

  it('adia somente callback que depende de enriquecimento de mídia', async () => {
    const webhooks: unknown[] = [];
    const payload = {
      key: {
        remoteJid: '5521983424242@s.whatsapp.net',
      },
      message: { imageMessage: { url: 'encrypted-media' } },
    };

    const result = await dispatchBaileysInboundWebhookBeforeSideEffects({
      payload,
      requiresEnrichment: true,
      sendWebhook: (event) => webhooks.push(event),
    });

    assert.deepEqual(webhooks, []);
    assert.equal(result.dispatched, false);
  });

  it('publica o webhook mesmo quando a mensagem não existe no banco local', async () => {
    const webhooks: unknown[] = [];
    const persisted: unknown[] = [];
    const payload = {
      keyId: 'provider-message-id',
      remoteJid: '5521983424242@s.whatsapp.net',
      fromMe: true,
      status: 'DELIVERY_ACK',
      instanceId: 'instance-id',
    };

    const result = await dispatchBaileysMessageUpdate({
      payload,
      persist: true,
      sendWebhook: (event) => webhooks.push(event),
      persistUpdate: async (event) => {
        persisted.push(event);
      },
    });

    assert.deepEqual(webhooks, [payload]);
    assert.deepEqual(persisted, []);
    assert.equal(result.persisted, false);
  });

  it('persiste o ACK relacionado sem gravar o conteúdo transitório da mensagem', async () => {
    const webhooks: unknown[] = [];
    const persisted: Record<string, unknown>[] = [];
    const payload = {
      messageId: 'local-message-id',
      keyId: 'provider-message-id',
      remoteJid: '5521983424242@s.whatsapp.net',
      fromMe: true,
      status: 'READ',
      instanceId: 'instance-id',
      message: { conversation: 'conteúdo transitório' },
    };

    const result = await dispatchBaileysMessageUpdate({
      payload,
      persist: true,
      sendWebhook: (event) => webhooks.push(event),
      persistUpdate: async (event) => {
        persisted.push(event);
      },
    });

    assert.deepEqual(webhooks, [payload]);
    assert.deepEqual(persisted, [
      {
        messageId: 'local-message-id',
        keyId: 'provider-message-id',
        remoteJid: '5521983424242@s.whatsapp.net',
        fromMe: true,
        status: 'READ',
        instanceId: 'instance-id',
      },
    ]);
    assert.equal(result.persisted, true);
  });
});
