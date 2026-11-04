import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import { Boom } from '@hapi/boom';
import ts from 'typescript';

// Exercise installed, patched rc14 code; replace transport/timers only. Never connect to WhatsApp.
const read = (name: string) => readFileSync(`node_modules/baileys/lib/${name}.js`, 'utf8');
function loadUtils(source: string, dependencies: Record<string, unknown> = {}) {
  const exports = {} as any;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name in dependencies) return dependencies[name];
      if (name === 'crypto') return require('node:crypto');
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return exports;
}
const getBinaryNodeChild = (node: any, tag: string) => node?.content?.find((child: any) => child.tag === tag);
const utils = loadUtils(read('Utils/companion-reg-client-utils'), { '../WABinary/index.js': { getBinaryNodeChild } });
const { buildAckStanza } = loadUtils(read('Utils/stanza-ack'));
const notification = (child = 'companion_reg_refresh') => ({
  tag: 'notification',
  attrs: { from: 's.whatsapp.net', id: 'synthetic-id', type: 'companion_reg_refresh' },
  content: [{ tag: child, attrs: {}, content: 'sensitive-payload-not-for-logs' }],
});
const pairDevice = () => ({
  tag: 'iq',
  attrs: { id: 'synthetic-pair' },
  content: [
    {
      tag: 'pair-device',
      attrs: {},
      content: ['ref-1', 'ref-2'].map((ref) => ({ tag: 'ref', attrs: {}, content: Buffer.from(ref) })),
    },
  ],
});
const fields = (qr: string) => qr.split('#')[1].split(',');
function harness(me?: object) {
  const ws = new EventEmitter() as EventEmitter & { isOpen: boolean };
  ws.isOpen = true;
  const ev = new EventEmitter();
  const creds: any = {
    me,
    noiseKey: { public: Buffer.from('noise') },
    signedIdentityKey: { public: Buffer.from('identity') },
    advSecretKey: 'old-secret',
  };
  const qrs: string[] = [],
    updates: any[] = [],
    sent: any[] = [],
    ended: any[] = [],
    logs: any[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  ev.on('connection.update', ({ qr }) => qrs.push(qr));
  ev.on('creds.update', (update) => updates.push(update));
  const source = read('Socket/socket');
  const start = source.indexOf('    // QR gen');
  const end = source.indexOf('    // device paired for the first time', start);
  assert.ok(start >= 0 && end > start);
  runInNewContext(source.slice(start, end), {
    ...utils,
    ws,
    ev,
    creds,
    Buffer,
    Boom,
    S_WHATSAPP_NET: 's.whatsapp.net',
    browser: ['Baileys', 'Chrome', '1'],
    qrTimeout: undefined,
    qrTimer: undefined,
    getBinaryNodeChild,
    getBinaryNodeChildren: (node: any, tag: string) => node.content.filter((child: any) => child.tag === tag),
    sendNode: async (node: any) => sent.push(node),
    end: (error: unknown) => ended.push(error),
    DisconnectReason: { timedOut: 408 },
    setTimeout: (callback: () => void, delay: number) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    logger: Object.fromEntries(['info', 'warn', 'debug'].map((key) => [key, (...args: any[]) => logs.push(args)])),
  });
  // Execute the actual notification ACK function with the actual pure ACK builder.
  const recv = read('Socket/messages-recv');
  const ackStart = recv.indexOf('    const sendMessageAck =');
  const ackEnd = recv.indexOf('    const rejectCall =', ackStart);
  assert.ok(ackStart >= 0 && ackEnd > ackStart);
  const ack = runInNewContext(`${recv.slice(ackStart, ackEnd)}; sendMessageAck;`, {
    authState: { creds },
    buildAckStanza,
    Boom,
    sendNode: async (node: any) => sent.push(node),
    logger: { debug() {} },
  });
  const startPairing = async () => {
    ws.emit('CB:iq,type:set,pair-device', pairDevice());
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const refresh = (child = 'companion_reg_refresh') =>
    ws.emit('CB:notification,type:companion_reg_refresh', notification(child));
  return { ws, creds, qrs, updates, sent, ended, timers, logs, ack, startPairing, refresh };
}

describe('Baileys rc14 companion registration refresh selective upstream patch', () => {
  for (const child of ['companion_reg_refresh', 'pair-device-rotate-qr']) {
    it(`routes ${child}, persists a fresh 32-byte secret and re-renders the current ref`, async () => {
      const h = harness();
      await h.startPairing();
      h.refresh(child);
      assert.equal(h.qrs.length, 2);
      assert.equal(fields(h.qrs[0])[0], fields(h.qrs[1])[0]);
      assert.equal(fields(h.qrs[1])[0], 'ref-1');
      assert.notEqual(h.creds.advSecretKey, 'old-secret');
      assert.equal(Buffer.from(h.creds.advSecretKey, 'base64').length, 32);
      assert.equal(fields(h.qrs[1])[3], h.creds.advSecretKey);
      assert.equal(h.updates[0].advSecretKey, h.creds.advSecretKey);
      assert.equal(h.timers.length, 1);
      assert.equal(h.sent.length, 1); // Only the original pair-device ACK, no new wire command.
    });
  }
  it('preserves ref order and timeout cadence without refresh notifications', async () => {
    const h = harness();
    await h.startPairing();
    assert.equal(fields(h.qrs[0])[0], 'ref-1');
    assert.equal(h.timers[0].delay, 60000);
    h.timers[0].callback();
    assert.equal(fields(h.qrs[1])[0], 'ref-2');
    assert.equal(h.timers[1].delay, 20000);
    h.timers[1].callback();
    assert.equal(h.ended.length, 1);
    assert.match(h.ended[0].message, /QR refs attempts ended/);
  });
  it('50 refreshes do not consume refs or reschedule the QR expiry timer', async () => {
    const h = harness();
    await h.startPairing();
    const secrets = new Set<string>();
    for (let i = 0; i < 50; i++) {
      h.refresh();
      secrets.add(h.creds.advSecretKey);
    }
    assert.equal(secrets.size, 50);
    assert.equal(h.timers.length, 1);
    assert.ok(h.qrs.every((qr) => fields(qr)[0] === 'ref-1'));
    h.timers[0].callback();
    assert.equal(fields(h.qrs.at(-1)!)[0], 'ref-2');
    assert.equal(h.ended.length, 0);
  });
  it('does not render a QR before pair-device and uses the latest secret when it arrives', async () => {
    const h = harness();
    h.refresh();
    assert.equal(h.qrs.length, 0);
    assert.equal(h.timers.length, 0);
    await h.startPairing();
    assert.equal(fields(h.qrs[0])[3], h.creds.advSecretKey);
  });
  it('ignores malformed children without logging any stanza contents', async () => {
    const h = harness();
    await h.startPairing();
    h.refresh('unexpected');
    assert.equal(h.creds.advSecretKey, 'old-secret');
    assert.equal(h.updates.length, 0);
    assert.equal(h.qrs.length, 1);
    assert.equal(h.logs.length, 1);
    assert.doesNotMatch(JSON.stringify(h.logs), /sensitive-payload|synthetic-id|old-secret|ref-1/);
  });
  for (const me of [{ id: 'authenticated@s.whatsapp.net' }, {}]) {
    it(`preserves registered and pending pairing-code credentials ${JSON.stringify(me)}`, async () => {
      const h = harness(me);
      await h.startPairing();
      h.refresh();
      assert.equal(h.creds.advSecretKey, 'old-secret');
      assert.equal(h.updates.length, 0);
      assert.equal(h.qrs.length, 1);
    });
  }
  it('rotating one client does not change an authenticated or unpaired second client', async () => {
    const h = harness(),
      other = harness({ id: 'austin@s.whatsapp.net' }),
      third = harness();
    await Promise.all([h.startPairing(), other.startPairing(), third.startPairing()]);
    h.refresh();
    assert.equal(other.creds.advSecretKey, 'old-secret');
    assert.equal(third.creds.advSecretKey, 'old-secret');
    assert.equal(other.qrs.length, 1);
    assert.equal(third.qrs.length, 1);
  });
  it('ACKs a notification before identity exists, with original addressing and type', async () => {
    const h = harness();
    await h.ack(notification());
    assert.equal(h.sent.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.sent[0])), {
      tag: 'ack',
      attrs: { id: 'synthetic-id', to: 's.whatsapp.net', class: 'notification', type: 'companion_reg_refresh' },
    });
  });
  it('refuses message ACKs before identity and writes no stanza', async () => {
    const h = harness();
    await assert.rejects(
      h.ack({ tag: 'message', attrs: { id: 'message', from: 'sender@s.whatsapp.net' } }),
      /cannot ack a message before creds.me is set/,
    );
    assert.equal(h.sent.length, 0);
  });
  it('preserves authenticated message ACK identity', async () => {
    const h = harness({ id: 'austin@s.whatsapp.net' });
    await h.ack({ tag: 'message', attrs: { id: 'message', from: 'sender@s.whatsapp.net', type: 'text' } });
    assert.equal(h.sent[0].attrs.from, 'austin@s.whatsapp.net');
    assert.equal(h.sent[0].attrs.to, 'sender@s.whatsapp.net');
  });
});
