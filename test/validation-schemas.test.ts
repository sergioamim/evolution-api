import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validate } from 'jsonschema';

import { createGroupSchema } from '../src/validate/group.schema';
import { mediaMessageSchema, textMessageSchema } from '../src/validate/message.schema';
import { proxySchema } from '../src/validate/proxy.schema';
import { settingsSchema } from '../src/validate/settings.schema';

const isValid = (value: unknown, schema: Parameters<typeof validate>[1]) => validate(value, schema).valid;

describe('contratos de validação dos payloads', () => {
  it('aceita texto válido e rejeita campos obrigatórios ausentes ou inválidos', () => {
    assert.equal(isValid({ number: '5511999999999', text: 'Olá' }, textMessageSchema), true);
    assert.equal(isValid({ number: '5511999999999' }, textMessageSchema), false);
    assert.equal(
      isValid({ number: '5511999999999', text: 'Olá', mentioned: ['não-numérico'] }, textMessageSchema),
      false,
    );
  });

  it('aplica o enum de mídia e mantém opções válidas de reprodução', () => {
    assert.equal(
      isValid(
        {
          number: '5511999999999',
          mediatype: 'image',
          media: 'https://example.test/image.jpg',
          gifPlayback: false,
        },
        mediaMessageSchema,
      ),
      true,
    );
    assert.equal(
      isValid({ number: '5511999999999', mediatype: 'spreadsheet', media: 'file' }, mediaMessageSchema),
      false,
    );
  });

  it('exige configuração mínima de proxy e grupo', () => {
    assert.equal(
      isValid({ enabled: true, host: 'proxy.example.test', port: '8080', protocol: 'http' }, proxySchema),
      true,
    );
    assert.equal(isValid({ enabled: true, host: 'proxy.example.test' }, proxySchema), false);
    assert.equal(isValid({ subject: 'Equipe', participants: ['5511999999999'] }, createGroupSchema), true);
    assert.equal(isValid({ subject: 'Equipe' }, createGroupSchema), false);
  });

  it('aceita apenas configurações de instância completas e booleanas', () => {
    const validSettings = {
      rejectCall: false,
      groupsIgnore: false,
      alwaysOnline: true,
      readMessages: true,
      readStatus: false,
      syncFullHistory: false,
    };

    assert.equal(isValid(validSettings, settingsSchema), true);
    assert.equal(isValid({ ...validSettings, readStatus: 'false' }, settingsSchema), false);
    assert.equal(isValid({ ...validSettings, syncFullHistory: undefined }, settingsSchema), false);
  });
});
