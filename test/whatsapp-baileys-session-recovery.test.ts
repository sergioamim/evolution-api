import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import {
  BaileysConnectionLifecycle,
  resetBaileysClientLifecycle,
  resetBaileysQrLifecycle,
} from '../src/api/integrations/channel/whatsapp/baileys-session-lifecycle';

const isAtLeast = (version: string, minimum: [number, number, number]) => {
  const parsed = version.split('.').map(Number);

  for (let index = 0; index < minimum.length; index += 1) {
    if (parsed[index] !== minimum[index]) {
      return parsed[index] > minimum[index];
    }
  }

  return true;
};

describe('recuperação de sessão Baileys', () => {
  it('AC-1: reinicializa o contador e remove dados obsoletos de QR após logout', () => {
    const instance = {
      qrcode: {
        count: 30,
        code: 'stale-code',
        base64: 'stale-base64',
        pairingCode: 'stale-pairing-code',
      },
    };

    resetBaileysQrLifecycle(instance);

    assert.deepEqual(instance.qrcode, { count: 0 });
  });

  it('AC-2: limpa os flags terminais antes da criação de um novo cliente', () => {
    const lifecycle = resetBaileysClientLifecycle();

    assert.deepEqual(lifecycle, {
      endSession: false,
      isDeleting: false,
    });
  });

  it('AC-3: compartilha uma única tentativa de conexão concorrente', async () => {
    const lifecycle = new BaileysConnectionLifecycle();
    let executions = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = async () => {
      executions += 1;
      await pending;
      return 'connected';
    };

    const first = lifecycle.runSingleFlight(operation);
    const second = lifecycle.runSingleFlight(operation);

    assert.equal(first, second);
    assert.equal(executions, 1);
    release();
    assert.equal(await first, 'connected');
  });

  it('AC-4: agenda somente uma reconexão e cancela timers de gerações invalidadas', async () => {
    const lifecycle = new BaileysConnectionLifecycle();
    let executions = 0;
    const operation = async () => {
      executions += 1;
    };

    const generation = lifecycle.beginConnection();
    assert.equal(lifecycle.scheduleReconnect(generation, operation, 5), true);
    assert.equal(lifecycle.scheduleReconnect(generation, operation, 5), false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(executions, 1);

    const cancelledGeneration = lifecycle.beginConnection();
    assert.equal(lifecycle.scheduleReconnect(cancelledGeneration, operation, 5), true);
    lifecycle.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(executions, 1);
    assert.equal(lifecycle.isCurrent(cancelledGeneration), false);
  });

  it('AC-5: invalidação libera uma nova tentativa sem reutilizar a conexão obsoleta', async () => {
    const lifecycle = new BaileysConnectionLifecycle();
    let releaseStale!: () => void;
    const stalePending = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });

    const stale = lifecycle.runSingleFlight(async () => {
      await stalePending;
      return 'stale';
    });
    lifecycle.invalidate();
    const current = lifecycle.runSingleFlight(async () => 'current');

    assert.notEqual(stale, current);
    assert.equal(await current, 'current');
    releaseStale();
    assert.equal(await stale, 'stale');
  });

  it('AC-6: mantém pacote e lockfile na mesma versão Baileys sem patch obsoleto', async () => {
    const projectRoot = process.cwd();
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8'));

    assert.equal(packageJson.dependencies.baileys, '7.0.0-rc13');
    assert.equal(packageLock.packages[''].dependencies.baileys, '7.0.0-rc13');
    assert.equal(packageLock.packages['node_modules/baileys'].version, '7.0.0-rc13');
    await access(resolve(projectRoot, 'patches'));
    await assert.rejects(
      access(resolve(projectRoot, 'patches/baileys+7.0.0-rc.6.patch')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  it('AC-7: mantém a cadeia XML fora das versões criticamente vulneráveis', async () => {
    const projectRoot = process.cwd();
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8'));

    assert.equal(packageJson.dependencies['@aws-sdk/client-sqs'], '^3.1095.0');
    assert.equal(packageJson.dependencies.minio, '^8.0.7');
    assert.equal(packageLock.packages[''].dependencies['@aws-sdk/client-sqs'], '^3.1095.0');
    assert.equal(packageLock.packages[''].dependencies.minio, '^8.0.7');
    assert.equal(packageLock.packages['node_modules/@aws-sdk/xml-builder'].dependencies['fast-xml-parser'], undefined);
    assert.equal(packageLock.packages['node_modules/minio'].dependencies['fast-xml-parser'], '^5.3.4');
    assert.doesNotMatch(JSON.stringify(packageJson.overrides ?? {}), /fast-xml-parser/);

    const xmlParserVersions = Object.entries<{ version?: string }>(packageLock.packages)
      .filter(([path]) => path.endsWith('node_modules/fast-xml-parser'))
      .map(([, metadata]) => metadata.version);

    assert.ok(xmlParserVersions.length > 0);
    for (const version of xmlParserVersions) {
      assert.ok(version);
      assert.equal(isAtLeast(version, [5, 5, 6]), true, `fast-xml-parser ${version} permanece em uma faixa vulnerável`);
    }
  });
});
