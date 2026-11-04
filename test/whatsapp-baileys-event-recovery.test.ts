import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import ts from 'typescript';

import {
  BaileysConnectionLifecycle,
  resetBaileysQrLifecycle,
} from '../src/api/integrations/channel/whatsapp/baileys-session-lifecycle';

// Compile the production methods, without importing the server module (which opens DB/network clients).
// All handlers below are the actual service implementation; only their IO dependencies are replaced.
const source = ts.createSourceFile(
  'whatsapp.baileys.service.ts',
  readFileSync(resolve(__dirname, '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const service = source.statements.find(
  (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'BaileysStartupService',
)!;
const methods = service.members
  .filter(
    (node) => ts.isMethodDeclaration(node) && ['eventHandler', 'connectionUpdate'].includes(node.name.getText(source)),
  )
  .map((node) => node.getText(source))
  .join('\n');
assert.equal(
  service.members.filter((node) => ts.isMethodDeclaration(node) && methods.includes(node.getText(source))).length,
  2,
);
const compiled = ts.transpileModule(`class EventHarness { ${methods} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const events = new Proxy({}, { get: (_target, key) => String(key) });
const disconnectReason = {
  timedOut: 408,
  loggedOut: 401,
  forbidden: 403,
  connectionReplaced: 440,
  connectionClosed: 428,
};
const Harness = new Function(
  'Events',
  'DisconnectReason',
  'resetBaileysQrLifecycle',
  `${compiled}; return EventHarness;`,
)(events, disconnectReason, resetBaileysQrLifecycle);

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const lifecycles = new Set<BaileysConnectionLifecycle>();
afterEach(() => {
  for (const lifecycle of lifecycles) lifecycle.cancelReconnect();
  lifecycles.clear();
});

function setup(name = 'meringuava') {
  const handler = new Harness();
  const processed: string[] = [];
  const webhooks: unknown[][] = [];
  const saved: string[] = [];
  const errors: unknown[] = [];
  const warnings: unknown[] = [];
  const writes: unknown[] = [];
  const sends: string[] = [];
  let callback!: (events: any) => Promise<void>;
  let clientIndex = 0;
  handler.connectionLifecycle = new BaileysConnectionLifecycle();
  lifecycles.add(handler.connectionLifecycle);
  handler.connectionUpdateRevision = 0;
  handler.eventProcessingQueue = Promise.resolve(); // Also lets the pre-fix implementation run in this harness.
  handler.endSession = false;
  handler.isDeleting = false;
  handler.stateConnection = { state: 'close' };
  handler.instanceId = name;
  handler.instance = { name, wuid: `${name}@s.whatsapp.net`, qrcode: { count: 0 } };
  handler.logger = Object.fromEntries(
    ['info', 'debug', 'warn', 'log', 'error'].map((key) => [
      key,
      key === 'error'
        ? (error: unknown) => errors.push(error)
        : key === 'warn'
          ? (warning: unknown) => warnings.push(warning)
          : () => undefined,
    ]),
  );
  handler.configService = { get: () => ({ ENABLED: false, SAVE_DATA: {} }) };
  handler.findSettings = async () => ({});
  handler.sendDataWebhook = (...args: unknown[]) => webhooks.push(args);
  handler.prismaRepository = { instance: { update: async (data: unknown) => writes.push(data) } };
  handler.profilePicture = async () => ({ profilePictureUrl: 'current-profile' });
  handler.getProfileName = async () => 'current-name';
  handler.eventEmitter = { emit: () => undefined };
  handler.messageHandle = Object.fromEntries(
    ['messages.upsert', 'messages.update', 'messaging-history.set'].map((event) => [
      event,
      async (payload: { id: string }) => processed.push(payload.id),
    ]),
  );
  const connect = () => {
    const id = `${name}-${++clientIndex}`;
    const client = {
      ws: new EventEmitter(),
      authState: { creds: {} as { me?: object } },
      user: { id: `${name}@s.whatsapp.net` },
      ev: {
        process: (fn: typeof callback) => {
          callback = fn;
        },
        emit: () => sends.push(`emit:${id}`),
      },
      sendMessage: async () => {
        sends.push(`send:${id}`);
        return { key: { id: 'outbound' } };
      },
      rejectCall: async () => undefined,
      signalRepository: { lidMapping: { getPNForLID: async () => 'caller@s.whatsapp.net' } },
    };
    handler.instance.authState = {
      saveCreds: async () => {
        saved.push(id);
      },
    };
    handler.client = client;
    const generation = handler.connectionLifecycle.beginConnection();
    handler.eventHandler(client, generation);
    return { client, emit: callback, generation };
  };
  return { handler, connect, processed, webhooks, saved, errors, warnings, writes, sends };
}

describe('recuperação da fila de eventos Baileys sem replay', () => {
  it('logs only a sanitized current unauthenticated registration-refresh marker', () => {
    const h = setup();
    const old = h.connect();
    const current = h.connect();
    old.client.ws.emit('CB:notification,type:companion_reg_refresh', { secret: 'never-log' });
    assert.deepEqual(h.warnings, []);
    current.client.ws.emit('CB:notification,type:companion_reg_refresh', { secret: 'never-log' });
    assert.deepEqual(h.warnings, [
      {
        message: 'Baileys companion registration refresh received',
        notificationType: 'companion_reg_refresh',
        instanceName: 'meringuava',
      },
    ]);
    current.client.authState.creds.me = {};
    current.client.ws.emit('CB:notification,type:companion_reg_refresh', { secret: 'never-log' });
    assert.equal(h.warnings.length, 1);
    assert.deepEqual(h.sends, []);
  });

  it('processa conexão e credenciais sem consultar configurações e sem enviar mensagens', async () => {
    const h = setup();
    let settingsReads = 0;
    h.handler.findSettings = () => {
      settingsReads++;
      return new Promise(() => undefined);
    };
    const socket = h.connect();
    await socket.emit({ 'connection.update': { connection: 'connecting' }, 'creds.update': {} });
    await flush();
    assert.equal(h.handler.stateConnection.state, 'connecting');
    assert.equal(settingsReads, 0);
    assert.deepEqual(h.saved, ['meringuava-1']);
    assert.equal(h.webhooks.length, 1);
    assert.deepEqual(h.sends, []);
  });

  it('agenda reconexão apesar de findSettings nunca resolver, sem reiniciar outra unidade', async () => {
    const h = setup();
    const other = setup('austin');
    const socket = h.connect();
    const austin = other.connect();
    h.handler.findSettings = () => new Promise(() => undefined);
    await socket.emit({ 'messages.upsert': { id: 'blocked' } });
    await flush();
    const reconnect = deferred();
    let attempts = 0;
    h.handler.connectionLifecycle.reconnectDelay = () => 0;
    h.handler.connectToWhatsapp = async () => {
      attempts++;
      h.connect();
      reconnect.resolve();
    };
    await socket.emit({
      'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } },
    });
    // A deterministic bound prevents a broken implementation leaving this test hanging indefinitely.
    await Promise.race([
      reconnect.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect blocked')), 100)),
    ]);
    assert.equal(attempts, 1);
    await austin.emit({ 'messages.upsert': { id: 'austin-inbound' } });
    await flush();
    assert.deepEqual(other.processed, ['austin-inbound']);
    assert.equal(other.handler.client, austin.client);
    assert.deepEqual(h.sends, []);
    assert.deepEqual(other.sends, []);
  });

  it('a nova conexão não herda o evento pendurado e descarta batches antigos sem replay', async () => {
    const h = setup();
    const blocked = deferred<any>();
    h.handler.findSettings = () => blocked.promise;
    const old = h.connect();
    await old.emit({ 'messages.upsert': { id: 'old-running' } });
    await old.emit({ 'messages.upsert': { id: 'old-queued' }, 'creds.update': {} });
    await flush();
    h.handler.findSettings = async () => ({});
    const current = h.connect();
    await current.emit({ 'messages.upsert': { id: 'new-inbound' } });
    await flush();
    assert.deepEqual(h.processed, ['new-inbound']);
    const savedBeforeRelease = [...h.saved];
    blocked.resolve({});
    await flush();
    await old.emit({ 'messages.upsert': { id: 'old-late' }, 'creds.update': {} });
    await flush();
    assert.deepEqual(h.processed, ['new-inbound']);
    assert.deepEqual(h.saved, savedBeforeRelease);
    assert.deepEqual(h.sends, []);
  });

  it('não avança o resto de um batch após um handler já iniciado terminar em geração antiga', async () => {
    const h = setup();
    const blocked = deferred();
    h.handler.messageHandle['messaging-history.set'] = async () => blocked.promise;
    const old = h.connect();
    await old.emit({ 'messaging-history.set': {}, 'messages.upsert': { id: 'stale-after-history' } });
    await flush();
    const current = h.connect();
    await current.emit({ 'messages.upsert': { id: 'new' } });
    await flush();
    blocked.resolve();
    await flush();
    assert.deepEqual(h.processed, ['new']);
  });

  it('mantém a ordem e não libera handlers concorrentes de dados na mesma conexão', async () => {
    const h = setup();
    const blocked = deferred();
    h.handler.messageHandle['messages.upsert'] = async (payload: { id: string }) => {
      h.processed.push(`start:${payload.id}`);
      if (payload.id === 'first') await blocked.promise;
      h.processed.push(`end:${payload.id}`);
    };
    const socket = h.connect();
    await socket.emit({ 'messages.upsert': { id: 'first' } });
    await socket.emit({ 'messages.upsert': { id: 'second' } });
    await flush();
    assert.deepEqual(h.processed, ['start:first']);
    blocked.resolve();
    await flush();
    assert.deepEqual(h.processed, ['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('continua após rejeição de dados sem repetir o evento que falhou', async () => {
    const h = setup();
    h.handler.messageHandle['messages.upsert'] = async (payload: { id: string }) => {
      h.processed.push(payload.id);
      if (payload.id === 'poison') throw new Error('malformed event');
    };
    const socket = h.connect();
    await socket.emit({ 'messages.upsert': { id: 'poison' } });
    await socket.emit({ 'messages.upsert': { id: 'next' } });
    await flush();
    assert.deepEqual(h.processed, ['poison', 'next']);
    assert.equal(h.errors.length, 1);
    assert.deepEqual(h.sends, []);
  });

  it('não salva credenciais da nova sessão para evento obsoleto antes da microtask', async () => {
    const h = setup();
    const old = h.connect();
    const dispatched = old.emit({ 'creds.update': {} });
    h.connect();
    await dispatched;
    await flush();
    assert.deepEqual(h.saved, []);
  });

  it('uma consulta LID antiga não envia a resposta de chamada na sessão nova', async () => {
    const h = setup();
    const lid = deferred<string>();
    h.handler.findSettings = async () => ({ msgCall: 'configured-call-reply' });
    const old = h.connect();
    old.client.signalRepository.lidMapping.getPNForLID = () => lid.promise;
    await old.emit({ call: [{ id: 'call', from: 'caller@lid', status: 'offer' }] });
    await flush();
    h.connect();
    lid.resolve('caller@s.whatsapp.net');
    await flush();
    assert.deepEqual(h.sends, []);
    assert.deepEqual(h.webhooks, []);
  });

  it('open pendurado em perfil não impede close e não publica estado de sessão obsoleta', async () => {
    const h = setup();
    const profile = deferred<{ profilePictureUrl: string }>();
    h.handler.profilePicture = () => profile.promise;
    const old = h.connect();
    const opening = old.emit({ 'connection.update': { connection: 'open' } });
    await flush();
    const reconnect = deferred();
    h.handler.connectionLifecycle.reconnectDelay = () => 0;
    h.handler.connectToWhatsapp = async () => {
      h.connect();
      reconnect.resolve();
    };
    await old.emit({
      'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } },
    });
    await Promise.race([
      reconnect.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect blocked by profile')), 100)),
    ]);
    profile.resolve({ profilePictureUrl: 'stale' });
    await opening;
    await flush();
    assert.notEqual(h.handler.instance.profilePictureUrl, 'stale');
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.webhooks, []);
    assert.deepEqual(h.sends, []);
  });

  it('descarta o perfil de open após close mesmo antes de começar a próxima geração', async () => {
    const h = setup();
    const profile = deferred<{ profilePictureUrl: string }>();
    h.handler.profilePicture = () => profile.promise;
    const socket = h.connect();
    const opening = socket.emit({ 'connection.update': { connection: 'open' } });
    await flush();
    await socket.emit({
      'connection.update': { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } },
    });
    h.handler.connectionLifecycle.cancelReconnect();
    profile.resolve({ profilePictureUrl: 'stale' });
    await opening;
    await flush();
    assert.equal(h.handler.stateConnection.state, 'close');
    assert.notEqual(h.handler.instance.profilePictureUrl, 'stale');
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.webhooks, []);
  });
});
