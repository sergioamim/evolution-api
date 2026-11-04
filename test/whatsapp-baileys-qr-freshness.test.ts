import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import ts from 'typescript';

import {
  BaileysConnectionLifecycle,
  resetBaileysQrLifecycle,
} from '../src/api/integrations/channel/whatsapp/baileys-session-lifecycle';

// Execute the owning production methods without starting server/database clients.
function extract(path: string, className: string, names: string[]) {
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(__dirname, '..', path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const owner = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === className,
  )!;
  const members = owner.members.filter(
    (node) =>
      (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && names.includes(node.name.getText(source)),
  );
  assert.equal(members.length, names.length);
  return ts.transpileModule(`class Harness { ${members.map((node) => node.getText(source)).join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const serviceCode = extract(
  'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts',
  'BaileysStartupService',
  ['qrCode', 'connectionStatus', 'connectionUpdate', 'logoutInstance'],
);
const controllerCode = extract('src/api/controllers/instance.controller.ts', 'InstanceController', [
  'connectToWhatsapp',
]);
const Events = new Proxy({}, { get: (_target, key) => String(key) });
const DisconnectReason = { loggedOut: 401, forbidden: 403, connectionReplaced: 440, timedOut: 408 };
const delay = async () => undefined;
const Controller = new Function('delay', `${controllerCode}; return Harness;`)(delay);
const staleQr = () => ({ count: 3, code: 'expired-ref', base64: 'expired-image', pairingCode: 'expired-pairing' });
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

function setup(name = 'meringuava', authenticated = true) {
  const callbacks: Array<(error: unknown, base64: string) => void> = [];
  const Harness = new Function(
    'Events',
    'DisconnectReason',
    'resetBaileysQrLifecycle',
    'delay',
    'qrcode',
    'qrcodeTerminal',
    `${serviceCode}; return Harness;`,
  )(
    Events,
    DisconnectReason,
    resetBaileysQrLifecycle,
    delay,
    { toDataURL: (_qr: string, _opts: unknown, callback: (typeof callbacks)[number]) => callbacks.push(callback) },
    { generate: () => undefined },
  );
  const handler = new Harness();
  const sends: unknown[] = [];
  const webhooks: unknown[][] = [];
  const writes: any[] = [];
  handler.connectionLifecycle = new BaileysConnectionLifecycle();
  const generation = handler.connectionLifecycle.beginConnection();
  handler.connectionUpdateRevision = 0;
  handler.instanceId = name;
  handler.instanceName = name;
  handler.instance = { id: name, name, wuid: 'historical@s.whatsapp.net', qrcode: staleQr() };
  handler.client = {
    user: { id: `${name}:1@s.whatsapp.net` },
    authState: { creds: authenticated ? { me: { id: `${name}@s.whatsapp.net` } } : {} },
    logout: async () => undefined,
    ws: { close: () => undefined },
    end: () => undefined,
    sendMessage: (...args: unknown[]) => sends.push(args),
    requestPairingCode: async () => 'new-pairing',
  };
  handler.logger = Object.fromEntries(['info', 'debug', 'warn', 'log', 'error'].map((key) => [key, () => undefined]));
  handler.configService = {
    get: (key: string) =>
      ({
        QRCODE: { LIMIT: 30, COLOR: '#000000' },
        CHATWOOT: { ENABLED: false },
        DATABASE: { SAVE_DATA: { INSTANCE: false } },
        CACHE: { REDIS: { ENABLED: false } },
        PROVIDER: { ENABLED: false },
      })[key],
  };
  handler.sendDataWebhook = (...args: unknown[]) => webhooks.push(args);
  handler.profilePicture = async () => ({ profilePictureUrl: 'current-image' });
  handler.getProfileName = async () => 'current-name';
  handler.messageProcessor = { onDestroy: () => undefined };
  handler.prismaRepository = {
    instance: { update: async (data: unknown) => writes.push(data) },
    session: { findFirst: async () => null },
  };
  handler.stateConnection = { state: 'connecting' };
  const controller = new Controller();
  controller.waMonitor = { waInstances: { [name]: handler } };
  controller.logger = handler.logger;
  const update = (data: unknown, client = handler.client, gen = generation) =>
    handler.connectionUpdate(data, client, gen);
  return { handler, controller, update, generation, callbacks, sends, webhooks, writes };
}

function assertNoQr(result: any) {
  assert.equal(result.base64, undefined);
  assert.equal(result.code, undefined);
  assert.equal(result.pairingCode, undefined);
  assert.equal(result.count, 0);
}

// Execute the installed provider function: rc14 sets creds.me before linking completes.
function useProviderPairingRequest(
  handler: any,
  sendNode: (node: unknown) => Promise<unknown> = async () => undefined,
) {
  handler.client.authState.creds.noiseKey = { public: Buffer.from('synthetic-noise-key') };
  const source = readFileSync('node_modules/baileys/lib/Socket/socket.js', 'utf8');
  const start = source.indexOf('    const requestPairingCode =');
  const end = source.indexOf('    async function generatePairingKey()', start);
  assert.ok(start >= 0 && end > start);
  handler.client.requestPairingCode = new Function(
    'authState',
    'ev',
    'sendNode',
    'jidEncode',
    'bytesToCrockford',
    'randomBytes',
    'S_WHATSAPP_NET',
    'generateMessageTag',
    'generatePairingKey',
    'getCompanionPlatformId',
    'browser',
    `${source.slice(start, end)}; return requestPairingCode;`,
  )(
    handler.client.authState,
    { emit() {} },
    sendNode,
    (phone: string, server: string) => `${phone}@${server}`,
    () => 'NEWCODE8',
    randomBytes,
    's.whatsapp.net',
    () => 'synthetic-request',
    async () => Buffer.from('synthetic-key'),
    () => '1',
    ['Baileys', 'Chrome', '1'],
  );
}

describe('fresh QR only for the current unauthenticated Baileys client', () => {
  it('suppresses cached QR and pairing on authenticated reconnect through the actual controller', async () => {
    const h = setup();
    h.handler.phoneNumber = 'synthetic-number';
    h.handler.client.authState.creds.pairingCode = 'expired-pairing';
    assertNoQr(h.handler.qrCode);
    assertNoQr(await h.controller.connectToWhatsapp({ instanceName: 'meringuava' }));
    assert.deepEqual(h.handler.instance.qrcode, staleQr()); // Getter does not mutate a different lifecycle.
    assert.deepEqual(h.sends, []);
  });

  it('returns a real newly generated QR even with a historical owner', async () => {
    const h = setup('meringuava', false);
    await h.update({ qr: 'new-ref' });
    h.callbacks[0](null, 'new-image');
    assert.deepEqual(await h.controller.connectToWhatsapp({ instanceName: 'meringuava' }), {
      count: 4,
      code: 'new-ref',
      base64: 'new-image',
      pairingCode: null,
    });
    assert.equal(h.webhooks.filter(([event]) => event === 'QRCODE_UPDATED').length, 1);
    assert.deepEqual(h.sends, []);
  });

  it('returns only the current pending numeric code after the provider sets creds.me', async () => {
    const h = setup('meringuava', false);
    const sending = deferred();
    h.handler.phoneNumber = 'synthetic-number';
    useProviderPairingRequest(h.handler, () => sending.promise);
    const pairing = h.update({ qr: 'current-ref' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.handler.client.authState.creds.me.id, 'synthetic-number@s.whatsapp.net');
    assertNoQr(h.handler.qrCode); // No code is exposed before requestPairingCode resolves.
    sending.resolve();
    await pairing;
    h.callbacks[0](null, 'current-image');
    assert.deepEqual(await h.controller.connectToWhatsapp({ instanceName: 'meringuava' }), {
      count: 0,
      pairingCode: 'NEWCODE8',
    });
    assert.deepEqual(h.sends, []);
  });

  it('hides a pending numeric code after close, open, logout, or client/generation replacement', async () => {
    for (const transition of ['close', 'open', 'logout', 'client', 'generation']) {
      const h = setup('meringuava', false);
      const other = setup('austin');
      h.handler.phoneNumber = 'synthetic-number';
      useProviderPairingRequest(h.handler);
      await h.update({ qr: 'current-ref' });
      assert.equal(h.handler.qrCode.pairingCode, 'NEWCODE8');
      if (transition === 'close') {
        h.handler.isDeleting = true; // Avoid reconnect IO in this lifecycle-only test.
        await h.update({ connection: 'close' });
        h.handler.isDeleting = false;
      }
      if (transition === 'open') await h.update({ connection: 'open' });
      if (transition === 'logout') await h.handler.logoutInstance();
      if (transition === 'client') h.handler.client = { ...h.handler.client };
      if (transition === 'generation') h.handler.connectionLifecycle.beginConnection();
      assertNoQr(h.handler.qrCode);
      if (transition === 'close') {
        h.handler.stateConnection = { state: 'connecting' };
        assertNoQr(h.handler.qrCode);
        assert.equal(h.handler.pendingPairingCode, undefined);
      }
      assertNoQr(other.handler.qrCode);
      assert.deepEqual(h.sends, []);
      assert.deepEqual(other.sends, []);
      if (transition === 'open' || transition === 'logout') assert.equal(h.handler.pendingPairingCode, undefined);
    }
  });

  it('does not publish a numeric code from a request superseded while the provider is sending', async () => {
    const h = setup('meringuava', false);
    const sending = deferred();
    h.handler.phoneNumber = 'synthetic-number';
    useProviderPairingRequest(h.handler, () => sending.promise);
    const pairing = h.update({ qr: 'superseded-ref' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    h.handler.connectionLifecycle.beginConnection();
    sending.resolve();
    await pairing;
    assertNoQr(h.handler.qrCode);
    assert.equal(h.handler.pendingPairingCode, undefined);
    assert.deepEqual(h.sends, []);
  });

  it('does not expose a code when the provider request fails after setting creds.me', async () => {
    const h = setup('meringuava', false);
    h.handler.phoneNumber = 'synthetic-number';
    useProviderPairingRequest(h.handler, async () => {
      throw new Error('synthetic transport failure');
    });
    await assert.rejects(h.update({ qr: 'failed-ref' }), /synthetic transport failure/);
    assert.equal(h.handler.client.authState.creds.me.id, 'synthetic-number@s.whatsapp.net');
    assertNoQr(h.handler.qrCode);
    assert.equal(h.handler.pendingPairingCode, undefined);
    assert.deepEqual(h.sends, []);
  });

  it('clears QR synchronously on successful open before a slow profile call', async () => {
    const h = setup();
    const profile = deferred<{ profilePictureUrl: string }>();
    h.handler.profilePicture = () => profile.promise;
    const opening = h.update({ connection: 'open' });
    assert.deepEqual(h.handler.instance.qrcode, { count: 0 });
    profile.resolve({ profilePictureUrl: 'current-image' });
    await opening;
    assert.equal(h.handler.stateConnection.state, 'open');
    assert.deepEqual(h.handler.instance.qrcode, { count: 0 });
    assert.deepEqual(h.sends, []);
  });

  it('does not clear QR for an invalid open or a superseded client', async () => {
    const h = setup('meringuava', false);
    const oldClient = h.handler.client;
    h.handler.client = { ...oldClient, user: undefined };
    await h.update({ connection: 'open' });
    assert.deepEqual(h.handler.instance.qrcode, staleQr());
    await h.update({ connection: 'open' }, oldClient);
    assert.deepEqual(h.handler.instance.qrcode, staleQr());
  });

  it('an open invalidates pending QR encoding without restoring the old QR', async () => {
    const h = setup('meringuava', false);
    await h.update({ qr: 'old-pending-ref' });
    h.handler.client.authState.creds.me = { id: 'current@s.whatsapp.net' };
    await h.update({ connection: 'open' });
    h.callbacks[0](null, 'old-pending-image');
    assert.deepEqual(h.handler.instance.qrcode, { count: 0 });
    assert.equal(h.webhooks.filter(([event]) => event === 'QRCODE_UPDATED').length, 0);
    assert.deepEqual(h.sends, []);
  });

  it('logout resets cached QR and a new unauthenticated client can expose its QR', async () => {
    const h = setup();
    await h.handler.logoutInstance();
    assert.deepEqual(h.handler.instance.qrcode, { count: 0 });
    assert.equal(h.handler.connectionStatus.state, 'close');
    h.handler.client = { ...h.handler.client, authState: { creds: {} } };
    const nextGeneration = h.handler.connectionLifecycle.beginConnection();
    await h.update({ qr: 'after-logout-ref' }, h.handler.client, nextGeneration);
    h.callbacks[0](null, 'after-logout-image');
    assert.equal(h.handler.qrCode.base64, 'after-logout-image');
    assert.equal(h.handler.qrCode.code, 'after-logout-ref');
    assert.equal(h.handler.qrCode.count, 1);
    assert.deepEqual(h.sends, []);
  });

  it('a delayed open profile cannot clear the next generation QR or change another instance', async () => {
    const h = setup();
    const other = setup('austin', false);
    const profile = deferred<{ profilePictureUrl: string }>();
    h.handler.profilePicture = () => profile.promise;
    const opening = h.update({ connection: 'open' });
    h.handler.client = { ...h.handler.client, authState: { creds: {} } };
    const nextGeneration = h.handler.connectionLifecycle.beginConnection();
    await h.update({ qr: 'next-ref' }, h.handler.client, nextGeneration);
    h.callbacks[0](null, 'next-image');
    profile.resolve({ profilePictureUrl: 'stale-profile' });
    await opening;
    assert.equal(h.handler.qrCode.base64, 'next-image');
    assert.equal(h.handler.instance.profilePictureUrl, undefined);
    assert.deepEqual(other.handler.instance.qrcode, staleQr());
    assert.deepEqual(h.sends, []);
    assert.deepEqual(other.sends, []);
  });
});
