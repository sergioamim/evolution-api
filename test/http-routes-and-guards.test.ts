import assert from 'node:assert/strict';
import { before, afterEach, describe, it } from 'node:test';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import axios from 'axios';

import { RouterBroker } from '@api/abstract/abstract.router';
import { createAuthGuard } from '@api/guards/auth.guard';
import { createInstanceGuards } from '@api/guards/instance.guard';
import { EventController } from '@api/integrations/event/event.controller';
import { WebhookController } from '@api/integrations/event/webhook/webhook.controller';
import { InstanceRouter } from '@api/routes/instance.router';
import { MessageRouter } from '@api/routes/sendMessage.router';
import { WebhookRouter } from '@api/integrations/event/webhook/webhook.router';
import { Auth, configService } from '@config/env.config';

type FakeRequest = Partial<Request> & {
  headers: Record<string, string>;
};

const apiKey = configService.get<Auth>('AUTHENTICATION').API_KEY.KEY;

const prismaStub = {
  instance: {
    findUnique: async () => null,
    findFirst: async () => null,
    findMany: async () => [],
  },
};
const monitorStub = { waInstances: {} as Record<string, any> };
const cacheStub = { has: async () => false };
const authGuard = createAuthGuard({ configService, prismaRepository: prismaStub as any });
const { instanceExistsGuard, instanceLoggedGuard } = createInstanceGuards({
  cache: cacheStub as any,
  configService,
  prismaRepository: prismaStub as any,
  waMonitor: monitorStub as any,
});

const fakeRequest = (url: string, options: Partial<FakeRequest> = {}) => {
  const headers = options.headers ?? {};

  return {
    originalUrl: url,
    params: options.params ?? {},
    body: options.body ?? {},
    query: options.query ?? {},
    headers,
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as Request;
};

const expectGuardError = async (guard: Function, req: Request, status: number) => {
  await assert.rejects(
    () => guard(req, {} as Response, (() => undefined) as NextFunction),
    (error: any) => error?.status === status,
  );
};

const createHttpApp = (instanceController: any, sendMessageController: any, webhookController: any) => {
  const app = express();
  app.use(express.json());
  app.use('/instance', new InstanceRouter(configService, instanceController, authGuard.apikey).router);
  app.use('/message', new MessageRouter(sendMessageController, authGuard.apikey).router);
  app.use('/webhook', new WebhookRouter(configService, webhookController, authGuard.apikey).router);
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error?.status ?? 500).json({
      status: error?.status ?? 500,
      error: error?.error ?? 'Internal Server Error',
      message: error?.message ?? 'Internal Server Error',
    });
  });
  return app;
};

describe('guards de autenticação e existência da instância', () => {
  it('aceita a chave global e rejeita chave ausente ou inválida', async () => {
    const nextCalls: unknown[] = [];
    const next = () => nextCalls.push(true);

    await authGuard.apikey(
      fakeRequest('/message/sendText/instance', { headers: { apikey: apiKey } }),
      {} as Response,
      next,
    );
    assert.equal(nextCalls.length, 1);

    await expectGuardError(authGuard.apikey, fakeRequest('/message/sendText/instance'), 401);
    await expectGuardError(
      authGuard.apikey,
      fakeRequest('/message/sendText/instance', { headers: { apikey: 'invalid-key' } }),
      401,
    );
  });

  it('aceita o token da instância sem consultar outra instância', async () => {
    const originalFindUnique = prismaStub.instance.findUnique;
    const calls: unknown[] = [];

    prismaStub.instance.findUnique = (async (args: unknown) => {
      calls.push(args);
      return { token: 'instance-token' };
    }) as typeof prismaStub.instance.findUnique;

    try {
      const nextCalls: unknown[] = [];
      await authGuard.apikey(
        fakeRequest('/message/sendText/instance-token-name', {
          headers: { apikey: 'instance-token' },
          params: { instanceName: 'instance-token-name' },
        }),
        {} as Response,
        () => nextCalls.push(true),
      );

      assert.equal(nextCalls.length, 1);
      assert.equal(calls.length, 1);
    } finally {
      prismaStub.instance.findUnique = originalFindUnique;
    }
  });

  it('ignora existência para criar ou listar e protege operações sem instanceName', async () => {
    const nextCalls: unknown[] = [];

    await instanceExistsGuard(
      fakeRequest('/instance/create', { body: { instanceName: 'new-instance' } }),
      {} as Response,
      () => nextCalls.push('create'),
    );
    await instanceExistsGuard(fakeRequest('/instance/fetchInstances'), {} as Response, () => nextCalls.push('fetch'));
    assert.deepEqual(nextCalls, ['create', 'fetch']);

    await expectGuardError(instanceExistsGuard, fakeRequest('/message/sendText'), 400);
  });

  it('encontra uma instância ativa e rejeita uma inexistente ou duplicada', async () => {
    const existingName = 'guard-existing-instance';
    const missingName = 'guard-missing-instance';
    const originalFindMany = prismaStub.instance.findMany;
    const originalExisting = monitorStub.waInstances[existingName];

    monitorStub.waInstances[existingName] = { instanceName: existingName } as any;
    prismaStub.instance.findMany = (async () => []) as typeof prismaStub.instance.findMany;

    try {
      const nextCalls: unknown[] = [];
      await instanceExistsGuard(
        fakeRequest(`/message/sendText/${existingName}`, { params: { instanceName: existingName } }),
        {} as Response,
        () => nextCalls.push(true),
      );
      assert.equal(nextCalls.length, 1);

      await expectGuardError(
        instanceExistsGuard,
        fakeRequest(`/message/sendText/${missingName}`, { params: { instanceName: missingName } }),
        404,
      );

      await expectGuardError(
        instanceLoggedGuard,
        fakeRequest('/instance/create', {
          body: { instanceName: existingName },
        }),
        403,
      );
    } finally {
      prismaStub.instance.findMany = originalFindMany;
      if (originalExisting) monitorStub.waInstances[existingName] = originalExisting;
      else delete monitorStub.waInstances[existingName];
    }
  });
});

describe('rotas HTTP de instância, mensagem e webhook', () => {
  const instanceControllerStub: any = {};
  const sendMessageControllerStub: any = {};
  const webhookControllerStub: any = {};
  const app = createHttpApp(instanceControllerStub, sendMessageControllerStub, webhookControllerStub);

  before(() => {
    instanceControllerStub.createInstance = async () => undefined;
    sendMessageControllerStub.sendText = async () => undefined;
    webhookControllerStub.set = async () => undefined;
    webhookControllerStub.get = async () => undefined;
  });

  afterEach(() => {
    instanceControllerStub.createInstance = async () => undefined;
    sendMessageControllerStub.sendText = async () => undefined;
    webhookControllerStub.set = async () => undefined;
    webhookControllerStub.get = async () => undefined;
  });

  it('cria instância após autenticação e validação do payload', async () => {
    let received: any;
    instanceControllerStub.createInstance = async (data: any) => {
      received = data;
      return { instance: { instanceName: data.instanceName, status: 'created' } };
    };

    const response = await request(app)
      .post('/instance/create')
      .set('apikey', apiKey)
      .send({ instanceName: 'http-created-instance', token: 'instance-secret' });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, {
      instance: { instanceName: 'http-created-instance', status: 'created' },
    });
    assert.equal(received.instanceName, 'http-created-instance');
    assert.equal(received.token, 'instance-secret');

    const invalidResponse = await request(app)
      .post('/instance/create')
      .set('apikey', apiKey)
      .send({ instanceName: '' });

    assert.equal(invalidResponse.status, 400);
  });

  it('envia texto pelo endpoint e bloqueia requisição sem apikey', async () => {
    let received: { instanceName: string; data: unknown } | undefined;
    sendMessageControllerStub.sendText = async (instance: any, data: unknown) => {
      received = { instanceName: instance.instanceName, data };
      return { key: { id: 'sent-message-id' }, status: 'PENDING' };
    };

    const response = await request(app)
      .post('/message/sendText/http-message-instance')
      .set('apikey', apiKey)
      .send({ number: '5511999999999', text: 'mensagem funcional' });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { key: { id: 'sent-message-id' }, status: 'PENDING' });
    assert.equal(received?.instanceName, 'http-message-instance');
    assert.deepEqual({ ...received?.data }, { number: '5511999999999', text: 'mensagem funcional' });

    const unauthorizedResponse = await request(app)
      .post('/message/sendText/http-message-instance')
      .send({ number: '5511999999999', text: 'sem chave' });

    assert.equal(unauthorizedResponse.status, 401);
  });

  it('expõe as operações de ciclo de vida da instância com os status HTTP corretos', async () => {
    const operations = [
      ['restart', 'restartInstance', 'post', { instanceName: 'http-instance' }],
      ['connect', 'connectToWhatsapp', 'get'],
      ['connectionState', 'connectionState', 'get'],
      ['setPresence', 'setPresence', 'post', { presence: 'available' }],
      ['logout', 'logout', 'delete'],
      ['delete', 'deleteInstance', 'delete'],
    ] as const;

    for (const [path, methodName, method, body] of operations) {
      instanceControllerStub[methodName] = async (instance: any, data: unknown, key?: string) => ({
        operation: methodName,
        instanceName: instance.instanceName,
        data,
        key,
      });

      let response = request(app)[method](`/instance/${path}/http-instance`).set('apikey', apiKey);
      if (body) response = response.send(body);
      else response = response.send();

      const result = await response;
      assert.equal(result.status, path === 'setPresence' ? 201 : 200);
      assert.equal(result.body.operation, methodName);
    }

    instanceControllerStub.fetchInstances = async (_instance: any, key: string) => ({ key });
    const fetchResponse = await request(app).get('/instance/fetchInstances').set('apikey', apiKey);
    assert.equal(fetchResponse.status, 200);
    assert.equal(fetchResponse.body.key, apiKey);
  });

  it('encaminha as modalidades de mensagem pelos endpoints correspondentes', async () => {
    const cases = [
      ['sendTemplate', 'sendTemplate', { name: 'template', language: 'pt_BR' }],
      [
        'sendMedia',
        'sendMedia',
        { number: '5511999999999', mediatype: 'image', media: 'https://example.test/image.jpg' },
      ],
      ['sendPtv', 'sendPtv', { number: '5511999999999', video: 'https://example.test/video.mp4' }],
      ['sendWhatsAppAudio', 'sendWhatsAppAudio', { number: '5511999999999', audio: 'https://example.test/audio.ogg' }],
      ['sendStatus', 'sendStatus', { type: 'text', content: 'status' }],
      ['sendSticker', 'sendSticker', { number: '5511999999999', sticker: 'https://example.test/sticker.webp' }],
      [
        'sendLocation',
        'sendLocation',
        { number: '5511999999999', latitude: -23.55, longitude: -46.63, name: 'Academia', address: 'Rua A' },
      ],
      [
        'sendContact',
        'sendContact',
        { number: '5511999999999', contact: [{ fullName: 'Contato', phoneNumber: '5511888888888' }] },
      ],
      [
        'sendReaction',
        'sendReaction',
        { key: { id: 'message-id', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false }, reaction: '👍' },
      ],
      ['sendPoll', 'sendPoll', { number: '5511999999999', name: 'Escolha', selectableCount: 1, values: ['A', 'B'] }],
      [
        'sendList',
        'sendList',
        {
          number: '5511999999999',
          title: 'Opções',
          footerText: 'Rodapé',
          buttonText: 'Escolher',
          sections: [{ title: 'Principal', rows: [{ title: 'A', rowId: 'a' }] }],
        },
      ],
      ['sendButtons', 'sendButtons', { number: '5511999999999' }],
      [
        'sendCarousel',
        'sendCarousel',
        { number: '5511999999999', body: 'Escolha', cards: [{ body: 'Card', buttons: [{ type: 'reply' }] }] },
      ],
    ] as const;

    for (const [path, methodName, body] of cases) {
      sendMessageControllerStub[methodName] = async (instance: any, data: unknown) => ({
        operation: methodName,
        instanceName: instance.instanceName,
        data,
      });

      const response = await request(app)
        .post(`/message/${path}/http-message-instance`)
        .set('apikey', apiKey)
        .send(body);

      assert.equal(response.status, 201, `${path}: ${JSON.stringify(response.body)}`);
      assert.equal(response.body.operation, methodName);
    }
  });

  it('configura e consulta webhook preservando o instanceName e os dados validados', async () => {
    let setReceived: { instanceName: string; data: unknown } | undefined;
    webhookControllerStub.set = async (instanceName: string, data: any) => {
      setReceived = { instanceName, data };
      return { instanceId: 'webhook-instance-id', enabled: data.webhook?.enabled, events: data.webhook?.events } as any;
    };
    webhookControllerStub.get = async (instanceName: string) => ({
      instanceId: 'webhook-instance-id',
      instanceName,
      enabled: true,
      url: 'https://hooks.example.test/evolution',
    });

    const setResponse = await request(app)
      .post('/webhook/set/webhook-instance')
      .set('apikey', apiKey)
      .send({
        webhook: {
          enabled: true,
          url: 'https://hooks.example.test/evolution',
          events: ['MESSAGES_UPSERT'],
        },
      });

    assert.equal(setResponse.status, 201);
    assert.equal(setResponse.body.instanceId, 'webhook-instance-id');
    assert.equal(setReceived?.instanceName, 'webhook-instance');
    assert.deepEqual(
      { ...setReceived?.data },
      {
        webhook: {
          enabled: true,
          url: 'https://hooks.example.test/evolution',
          events: ['MESSAGES_UPSERT'],
        },
      },
    );

    const findResponse = await request(app).get('/webhook/find/webhook-instance').set('apikey', apiKey);

    assert.equal(findResponse.status, 200, JSON.stringify(findResponse.body));
    assert.equal(findResponse.body.instanceName, 'webhook-instance');

    const invalidResponse = await request(app)
      .post('/webhook/set/webhook-instance')
      .set('apikey', apiKey)
      .send({ webhook: { enabled: true } });

    assert.equal(invalidResponse.status, 400);
  });
});

describe('serviço de webhook', () => {
  it('persiste eventos padrão quando o webhook é habilitado sem lista explícita', async () => {
    let upsertArgs: any;
    const controller = new WebhookController(
      { webhook: { upsert: async (args: unknown) => (upsertArgs = args) && { id: 'webhook-id' } } } as any,
      { waInstances: { instance: { instanceId: 'instance-id' } } } as any,
    );

    const data: any = { webhook: { enabled: true, url: 'https://hooks.example.test', events: [] } };
    const result = await controller.set('instance', data);

    assert.deepEqual(result, { id: 'webhook-id' });
    assert.equal(upsertArgs.where.instanceId, 'instance-id');
    assert.deepEqual(upsertArgs.create.events, EventController.events);
    assert.equal(data.webhook.events.length, EventController.events.length);
  });

  it('limpa eventos quando o webhook é desabilitado', async () => {
    let upsertArgs: any;
    const controller = new WebhookController(
      { webhook: { upsert: async (args: unknown) => (upsertArgs = args) && { id: 'webhook-id' } } } as any,
      { waInstances: { instance: { instanceId: 'instance-id' } } } as any,
    );
    const data: any = { webhook: { enabled: false, url: 'https://hooks.example.test', events: ['MESSAGES_UPSERT'] } };

    await controller.set('instance', data);

    assert.deepEqual(upsertArgs.update.events, []);
    assert.deepEqual(data.webhook.events, []);
  });

  it('envia webhook local com URL por evento e autenticação JWT nos headers', async () => {
    const posts: Array<{ options: any; data: any }> = [];
    let activeWebhookConfig: any = {
      GLOBAL: { ENABLED: false, URL: '', WEBHOOK_BY_EVENTS: false },
      EVENTS: { MESSAGES_UPSERT: false },
      REQUEST: { TIMEOUT_MS: 1000 },
      RETRY: { MAX_ATTEMPTS: 1, INITIAL_DELAY_SECONDS: 0 },
    };
    const originalCreate = axios.create;
    const originalGet = configService.get;
    const controller = new WebhookController(
      {
        webhook: {
          findUnique: async () => ({
            enabled: true,
            events: ['MESSAGES_UPSERT'],
            url: 'https://hooks.example.test/evolution',
            headers: { jwt_key: 'secret' },
            webhookByEvents: true,
          }),
        },
      } as any,
      { waInstances: { instance: { instanceId: 'instance-id' } } } as any,
    );

    (axios as any).create = (options: any) => ({
      post: async (_path: string, data: unknown) => posts.push({ options, data }),
    });
    (configService as any).get = (key: string) => {
      if (key === 'WEBHOOK') return activeWebhookConfig;
      if (key === 'LOG') return { LEVEL: [] };
      return originalGet.call(configService, key);
    };

    try {
      await controller.emit({
        instanceName: 'instance',
        origin: 'test',
        event: 'messages.upsert',
        data: { id: 'message-id' },
        serverUrl: 'https://api.example.test',
        dateTime: '2026-09-06T00:00:00.000Z',
        sender: 'sender',
        apiKey: 'api-key',
        local: true,
      });

      assert.equal(posts.length, 1);
      assert.equal(posts[0].options.baseURL, 'https://hooks.example.test/evolution/messages-upsert');
      assert.match(posts[0].options.headers.Authorization, /^Bearer /);
      assert.equal(posts[0].options.headers.jwt_key, undefined);
      assert.equal(posts[0].data.event, 'messages.upsert');

      activeWebhookConfig = {
        ...activeWebhookConfig,
        GLOBAL: { ENABLED: true, URL: 'https://global.example.test/hooks', WEBHOOK_BY_EVENTS: true },
        EVENTS: { MESSAGES_UPSERT: true },
      };
      await controller.emit({
        instanceName: 'instance',
        origin: 'test',
        event: 'messages.upsert',
        data: { id: 'message-id' },
        serverUrl: 'https://api.example.test',
        dateTime: '2026-09-06T00:00:00.000Z',
        sender: 'sender',
        local: false,
      });

      assert.equal(posts.length, 2);
      assert.equal(posts[1].options.baseURL, 'https://global.example.test/hooks/messages-upsert');
    } finally {
      axios.create = originalCreate;
      configService.get = originalGet;
    }
  });

  it('executa retry com sucesso após falha transitória e interrompe erro não recuperável', async () => {
    const controller = new WebhookController({} as any, { waInstances: {} } as any);
    let attempts = 0;
    const httpService = {
      post: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary failure');
      },
    };

    await (controller as any).retryWebhookRequest(
      httpService,
      {},
      'test',
      'https://hooks.example.test',
      'http://api',
      2,
      0,
    );
    assert.equal(attempts, 2);

    let nonRetryableAttempts = 0;
    await assert.rejects(
      () =>
        (controller as any).retryWebhookRequest(
          {
            post: async () => {
              nonRetryableAttempts += 1;
              throw { response: { status: 404 }, message: 'not found' };
            },
          },
          {},
          'test',
          'https://hooks.example.test',
          'http://api',
          3,
          0,
        ),
      (error: any) => error?.response?.status === 404,
    );
    assert.equal(nonRetryableAttempts, 1);
  });
});

describe('RouterBroker e validação de operações compostas', () => {
  class TestRouter extends RouterBroker {}
  class Payload {
    value?: string;
    groupJid?: string;
    inviteCode?: string;
    getParticipants?: string;
  }

  const schema = {
    type: 'object',
    properties: {
      value: { type: 'string' },
      groupJid: { type: 'string' },
      inviteCode: { type: 'string' },
      getParticipants: { type: 'string' },
    },
    required: ['value'],
  } as any;

  const req = (body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) =>
    ({ originalUrl: '/test', body, query, params: { instanceName: 'instance' } }) as Request;

  it('valida payloads comuns, query params e normalização de groupJid', async () => {
    const router = new TestRouter();
    assert.equal(router.routerPath('send'), '/send/:instanceName');
    assert.equal(router.routerPath('fetch', false), '/fetch');

    const common = await router.dataValidate({
      request: req({ value: 'ok' }, { value: 'from-query' }),
      schema,
      ClassRef: Payload,
      execute: async (instance, data) => ({ instance, data }),
    });
    assert.equal(common.instance.value, 'from-query');
    assert.equal(common.data.value, 'ok');

    const create = await router.dataValidate({
      request: { ...req({ value: 'from-create' }), originalUrl: '/instance/create' } as Request,
      schema,
      ClassRef: Payload,
      execute: async (instance, data) => ({ instance, data }),
    });
    assert.equal(create.instance.value, 'from-create');

    const grouped = await router.groupValidate({
      request: req({ groupJid: '120363000000000000' }),
      schema: { type: 'object', properties: { groupJid: { type: 'string' } }, required: ['groupJid'] } as any,
      ClassRef: Payload,
      execute: async (_instance, data) => data,
    });
    assert.equal(grouped.groupJid, '120363000000000000@g.us');

    const groupedFromQuery = await router.groupValidate({
      request: req({}, { groupJid: '120363000000000001@g.us' }),
      schema: { type: 'object', properties: { groupJid: { type: 'string' } }, required: ['groupJid'] } as any,
      ClassRef: Payload,
      execute: async (_instance, data) => data,
    });
    assert.equal(groupedFromQuery.groupJid, '120363000000000001@g.us');
  });

  it('valida operações de convite e participantes e rejeita payload inválido', async () => {
    const router = new TestRouter();
    const invite = await router.inviteCodeValidate({
      request: req({}, { inviteCode: 'invite-code' }),
      schema: { type: 'object', properties: { inviteCode: { type: 'string' } }, required: ['inviteCode'] } as any,
      ClassRef: Payload,
      execute: async (_instance, data) => data,
    });
    assert.equal(invite.inviteCode, 'invite-code');

    const participants = await router.getParticipantsValidate({
      request: req({}, { getParticipants: 'true' }),
      schema: {
        type: 'object',
        properties: { getParticipants: { type: 'string' } },
        required: ['getParticipants'],
      } as any,
      ClassRef: Payload,
      execute: async (_instance, data) => data,
    });
    assert.equal(participants.getParticipants, 'true');

    await assert.rejects(
      () =>
        router.dataValidate({
          request: req({}),
          schema,
          ClassRef: Payload,
          execute: async () => undefined,
        }),
      (error: any) => error?.status === 400,
    );
    await assert.rejects(
      () =>
        router.groupNoValidate({
          request: req({}),
          schema,
          ClassRef: Payload,
          execute: async () => undefined,
        }),
      (error: any) => error?.status === 400,
    );
    await assert.rejects(
      () =>
        router.groupValidate({
          request: req({}),
          schema,
          ClassRef: Payload,
          execute: async () => undefined,
        }),
      (error: any) => error?.status === 400,
    );
    await assert.rejects(
      () =>
        router.inviteCodeValidate({
          request: req(),
          schema,
          ClassRef: Payload,
          execute: async () => undefined,
        }),
      (error: any) => error?.status === 400,
    );
    await assert.rejects(
      () =>
        router.getParticipantsValidate({
          request: req(),
          schema,
          ClassRef: Payload,
          execute: async () => undefined,
        }),
      (error: any) => error?.status === 400,
    );
  });
});
