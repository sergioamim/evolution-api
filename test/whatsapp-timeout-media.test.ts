import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import { Boom } from '@hapi/boom';
import ts from 'typescript';

import { BaileysConnectionLifecycle } from '../src/api/integrations/channel/whatsapp/baileys-session-lifecycle';
import { InternalServerErrorException } from '../src/exceptions/500.exception';

// Execute the owning methods without bootstrapping databases or a WhatsApp socket.
function serviceMethods(names: string[], dependencies: Record<string, unknown> = {}) {
  const file = 'src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts';
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const owner = source.statements.find(
    (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'BaileysStartupService',
  )!;
  const methods = names.map((name) => {
    const method = owner.members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
    assert.ok(method, `method ${name} exists`);
    return method.getText(source);
  });
  const compiled = ts.transpileModule(`class Subject { ${methods.join('\n')} }; Subject.prototype;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return runInNewContext(compiled, {
    DisconnectReason: { loggedOut: 401, forbidden: 403, connectionReplaced: 440 },
    Events: { STATUS_INSTANCE: 'status.instance', CONNECTION_UPDATE: 'connection.update' },
    BadRequestException: Error,
    InternalServerErrorException,
    ...dependencies,
  });
}

function connectionHarness() {
  const recorded = { reconnects: [] as number[], events: [] as string[], writes: [] as unknown[] };
  const subject = Object.create(serviceMethods(['connectionUpdate']));
  subject.instance = { name: 'test-instance', wuid: 'test-user', qrcode: { count: 0 } };
  subject.client = { ws: { close() {} }, end() {} };
  subject.logger = { info() {}, debug() {}, warn() {} };
  subject.connectionLifecycle = new BaileysConnectionLifecycle();
  subject.connectionLifecycle.scheduleReconnect = (_generation: number, _operation: unknown, delay: number) => {
    recorded.reconnects.push(delay);
    return true;
  };
  subject.sendDataWebhook = () => {};
  subject.configService = { get: () => ({ ENABLED: false }) };
  subject.prismaRepository = { instance: { update: async (data: unknown) => recorded.writes.push(data) } };
  subject.eventEmitter = { emit: (event: string) => recorded.events.push(event) };
  return { subject, recorded };
}

function mediaHarness(query: () => Promise<unknown>) {
  const source = readFileSync('node_modules/baileys/lib/Socket/messages-send.js', 'utf8');
  const start = source.indexOf('    const refreshMediaConn =');
  const end = source.indexOf('    const sendReceipt =', start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(`let mediaConn; let mediaHost; ${source.slice(start, end)}; refreshMediaConn;`, {
    query,
    Boom,
    DisconnectReason: { timedOut: 408 },
    S_WHATSAPP_NET: 's.whatsapp.net',
    getBinaryNodeChild: (node: any, tag: string) => node?.content?.find((child: any) => child.tag === tag),
    getBinaryNodeChildren: (node: any, tag: string) => node?.content?.filter((child: any) => child.tag === tag) ?? [],
    logger: { debug() {} },
    Date,
  });
}

const validMediaResponse = {
  content: [
    {
      tag: 'media_conn',
      attrs: { auth: 'test-auth', ttl: '3600' },
      content: [{ tag: 'host', attrs: { hostname: 'media.example', maxContentLengthBytes: '10000' } }],
    },
  ],
};

describe('WhatsApp timeout and media regression', () => {
  it('408 preserves the session and schedules reconnection without logout or cleanup', async () => {
    const { subject, recorded } = connectionHarness();
    await subject.connectionUpdate(
      { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } },
      subject.client,
      0,
    );
    assert.equal(recorded.reconnects.length, 1);
    assert.deepEqual(recorded.events, []);
    assert.deepEqual(recorded.writes, []);
  });

  for (const code of [401, 403, 440, 402, 406]) {
    it(`terminal disconnect ${code} still performs logout`, async () => {
      const { subject, recorded } = connectionHarness();
      await subject.connectionUpdate(
        { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } },
        subject.client,
        0,
      );
      assert.equal(recorded.reconnects.length, 0);
      assert.deepEqual(recorded.events, ['logout.instance']);
      assert.equal(recorded.writes.length, 1);
    });
  }

  it('reconnection delay grows to a bounded maximum and resets after successful recovery', () => {
    const lifecycle = new BaileysConnectionLifecycle();
    const delays = Array.from({ length: 7 }, () => lifecycle.nextReconnectDelay());
    assert.deepEqual(delays, [3000, 6000, 12000, 24000, 48000, 60000, 60000]);
    lifecycle.resetReconnectBackoff();
    assert.equal(lifecycle.nextReconnectDelay(), 3000);
  });

  it('the real connection handler applies backoff and resets it when the connection opens', async () => {
    const { subject, recorded } = connectionHarness();
    const update = { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } };
    await subject.connectionUpdate(update, subject.client, 0);
    await subject.connectionUpdate(update, subject.client, 0);
    subject.client.user = { id: 'test-user', name: 'Test' };
    subject.profilePicture = async () => ({ profilePictureUrl: null });
    subject.getProfileName = async () => 'Test';
    await subject.connectionUpdate({ connection: 'open' }, subject.client, 0);
    await subject.connectionUpdate(update, subject.client, 0);
    assert.deepEqual(recorded.reconnects, [3000, 6000, 3000]);
    assert.deepEqual(recorded.events, []);
  });

  it('superseded socket events do not schedule retries or clean the current session', async () => {
    const { subject, recorded } = connectionHarness();
    await subject.connectionUpdate(
      { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } },
      {},
      0,
    );
    assert.deepEqual(recorded.reconnects, []);
    assert.deepEqual(recorded.events, []);
    assert.deepEqual(recorded.writes, []);
  });

  it('disconnected media fails before downloading or uploading the file', async () => {
    let downloads = 0;
    let uploads = 0;
    const subject = Object.create(
      serviceMethods(['prepareMediaMessage'], {
        isURL: () => true,
        axios: {
          get: async () => {
            downloads++;
            return { data: Buffer.from('image') };
          },
        },
        prepareWAMessageMedia: async () => {
          uploads++;
          return {};
        },
      }),
    );
    subject.stateConnection = { state: 'connecting' };
    subject.client = { ws: { isOpen: true }, waUploadToServer() {} };
    subject.logger = { error() {} };
    await assert.rejects(
      subject.prepareMediaMessage({ mediatype: 'document', media: 'https://file.example/test.pdf' }),
      (error: any) => error.status === 500 && /not connected/i.test(String(error.message)),
    );
    assert.equal(downloads, 0);
    assert.equal(uploads, 0);
  });

  for (const response of [undefined, { content: [] }, { content: [{ tag: 'media_conn', attrs: {} }] }]) {
    it(`invalid media response ${JSON.stringify(response)} returns a clear error and allows a new query`, async () => {
      let queries = 0;
      const refresh = mediaHarness(async () => (++queries === 1 ? response : validMediaResponse));
      await assert.rejects(refresh(), /media connection response/i);
      const media = await refresh();
      assert.equal(media.auth, 'test-auth');
      assert.equal(queries, 2);
      await refresh();
      assert.equal(queries, 2, 'successful response remains cached');
    });
  }

  it('concurrent media preparations share a single query', async () => {
    let queries = 0;
    const refresh = mediaHarness(async () => {
      queries++;
      return validMediaResponse;
    });
    const results = await Promise.all([refresh(), refresh()]);
    assert.equal(queries, 1);
    assert.equal(results[0].auth, 'test-auth');
    assert.equal(results[1].auth, 'test-auth');
  });

  it('a transport rejection clears the failed media query and recovers on the next attempt', async () => {
    let queries = 0;
    const refresh = mediaHarness(async () => {
      if (++queries === 1) throw new Error('Connection Closed');
      return validMediaResponse;
    });
    await assert.rejects(refresh(), /Connection Closed/);
    assert.equal((await refresh()).hosts[0].hostname, 'media.example');
    assert.equal(queries, 2);
  });

  it('successful media preparation remains available for an authenticated open socket', async () => {
    let uploads = 0;
    const subject = Object.create(
      serviceMethods(['prepareMediaMessage'], {
        isURL: () => false,
        Buffer,
        prepareWAMessageMedia: async (_media: unknown, options: any) => {
          await options.upload();
          return { documentMessage: { url: 'https://media.example/document' } };
        },
        mimeTypes: { lookup: () => 'application/pdf' },
        generateWAMessageFromContent: (_jid: string, content: unknown) => ({ message: content }),
      }),
    );
    subject.stateConnection = { state: 'open' };
    subject.instance = { wuid: 'test-user' };
    subject.client = {
      user: { id: 'test-user' },
      ws: { isOpen: true },
      waUploadToServer: async () => {
        uploads++;
      },
    };
    subject.logger = { error() {} };
    const result = await subject.prepareMediaMessage({
      mediatype: 'document',
      media: 'dGVzdA==',
      fileName: 'test.pdf',
    });
    assert.equal(uploads, 1);
    assert.equal(result.message.documentMessage.fileName, 'test.pdf');
    assert.equal(result.message.documentMessage.mimetype, 'application/pdf');
  });
});
