import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { advancedOperatorsSearch } from '../src/utils/advancedOperatorsSearch';
import { createJid } from '../src/utils/createJid';
import { findBotByTrigger } from '../src/utils/findBotByTrigger';
import { getConversationMessage } from '../src/utils/getConversationMessage';

describe('utilitários centrais', () => {
  describe('createJid', () => {
    it('preserva JIDs já canônicos e o broadcast', () => {
      assert.equal(createJid('5511999999999@s.whatsapp.net'), '5511999999999@s.whatsapp.net');
      assert.equal(createJid('120363000000000000@g.us'), '120363000000000000@g.us');
      assert.equal(createJid('status@broadcast'), 'status@broadcast');
    });

    it('normaliza telefone brasileiro, mexicano e argentino', () => {
      assert.equal(createJid('+55 (21) 99876-5432:1'), '5521998765432@s.whatsapp.net');
      assert.equal(createJid('5215512345678'), '525512345678@s.whatsapp.net');
      assert.equal(createJid('5491123456789'), '541123456789@s.whatsapp.net');
    });

    it('converte identificadores longos em JID de grupo', () => {
      assert.equal(createJid('120363000000000000'), '120363000000000000@g.us');
      assert.equal(createJid('120363000000000000-123456'), '120363000000000000-123456@g.us');
    });
  });

  describe('advancedOperatorsSearch', () => {
    it('compara sem diferenciar maiúsculas ou acentos', () => {
      assert.equal(advancedOperatorsSearch('Olá, João', 'contains:joao'), true);
      assert.equal(advancedOperatorsSearch('Olá, João', 'exact:ola'), false);
      assert.equal(advancedOperatorsSearch('Olá, João', 'notcontains:maria'), true);
    });

    it('aplica os operadores de início, fim e múltiplos valores', () => {
      assert.equal(advancedOperatorsSearch('pedido confirmado', 'startswith:pedido endswith:confirmado'), true);
      assert.equal(advancedOperatorsSearch('pedido confirmado', 'contains:pedido,confirmado'), true);
      assert.equal(advancedOperatorsSearch('pedido confirmado', 'unknown:pedido'), false);
    });
  });

  describe('getConversationMessage', () => {
    it('extrai texto simples e devolve vazio para mensagem desconhecida', () => {
      assert.equal(getConversationMessage({ message: { conversation: 'olá' } }), 'olá');
      assert.equal(getConversationMessage({ key: { id: 'message-id' } }), '');
    });

    it('preserva identificador e legenda de mídia', () => {
      assert.equal(
        getConversationMessage({
          key: { id: 'media-id' },
          message: { imageMessage: { caption: 'comprovante' } },
        }),
        'imageMessage|media-id|comprovante',
      );
      assert.equal(
        getConversationMessage({
          key: { id: 'audio-id' },
          message: { audioMessage: {} },
        }),
        'audioMessage|audio-id',
      );
    });

    it('anexa o texto de anúncio externo ao conteúdo principal', () => {
      assert.equal(
        getConversationMessage({
          message: {
            extendedTextMessage: {
              text: 'Confira',
              contextInfo: { externalAdReply: { body: 'Oferta especial' } },
            },
          },
        }),
        'Confira\nexternalAdReplyBody|Oferta especial',
      );
    });
  });

  describe('findBotByTrigger', () => {
    it('prioriza gatilho global e não consulta regras de palavra para conteúdo vazio', async () => {
      const findFirstCalls: unknown[] = [];
      const findManyCalls: unknown[] = [];
      const repository = {
        findFirst: async (args: unknown) => {
          findFirstCalls.push(args);
          return { id: 'global-bot' };
        },
        findMany: async (args: unknown) => {
          findManyCalls.push(args);
          return [];
        },
      };

      const result = await findBotByTrigger(repository, '   ', 'instance-id');

      assert.deepEqual(result, { id: 'global-bot' });
      assert.equal(findFirstCalls.length, 1);
      assert.equal(findManyCalls.length, 0);
    });

    it('retorna o primeiro gatilho avançado compatível antes do fallback por palavra-chave', async () => {
      const calls: string[] = [];
      const advanced = { id: 'advanced-bot', triggerValue: 'contains:suporte' };
      const repository = {
        findFirst: async ({ where }: { where: { triggerType?: string; triggerOperator?: string } }) => {
          calls.push(`first:${where.triggerOperator ?? 'global'}`);
          return null;
        },
        findMany: async ({ where }: { where: { triggerType: string } }) => {
          calls.push(`many:${where.triggerType}`);
          return where.triggerType === 'advanced' ? [advanced] : [];
        },
      };

      const result = await findBotByTrigger(repository, 'preciso de suporte', 'instance-id');

      assert.equal(result, advanced);
      assert.deepEqual(calls, ['first:global', 'many:advanced']);
    });

    it('aplica gatilhos por regex, prefixo e sufixo', async () => {
      const findByOperator = async (operator: string, triggerValue: string, content: string) => {
        const bot = { id: `${operator}-bot`, triggerValue };
        const repository = {
          findFirst: async () => null,
          findMany: async ({ where }: { where: { triggerType: string; triggerOperator?: string } }) => {
            if (where.triggerType === 'advanced') return [];
            return where.triggerOperator === operator ? [bot] : [];
          },
        };

        return findBotByTrigger(repository, content, 'instance-id');
      };

      assert.deepEqual(await findByOperator('regex', '^pedido', 'pedido confirmado'), {
        id: 'regex-bot',
        triggerValue: '^pedido',
      });
      assert.deepEqual(await findByOperator('startsWith', 'pedido', 'pedido confirmado'), {
        id: 'startsWith-bot',
        triggerValue: 'pedido',
      });
      assert.deepEqual(await findByOperator('endsWith', 'confirmado', 'pedido confirmado'), {
        id: 'endsWith-bot',
        triggerValue: 'confirmado',
      });
    });

    it('percorre os fallbacks até encontrar contém e retorna nulo quando não encontra', async () => {
      const returnedByOperator: Record<string, unknown> = {
        contains: { id: 'contains-bot', triggerValue: 'suporte' },
      };
      const repository = {
        findFirst: async () => null,
        findMany: async ({ where }: { where: { triggerType: string; triggerOperator?: string } }) => {
          if (where.triggerType === 'advanced') return [];
          const operator = where.triggerOperator ?? '';
          return returnedByOperator[operator] ? [returnedByOperator[operator]] : [];
        },
      };

      assert.deepEqual(
        await findBotByTrigger(repository, 'preciso de suporte', 'instance-id'),
        returnedByOperator.contains,
      );
      assert.equal(
        await findBotByTrigger({ findFirst: async () => null, findMany: async () => [] }, 'sem regra', 'instance-id'),
        null,
      );
    });
  });
});
