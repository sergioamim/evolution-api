import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

import {
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

  it('AC-3: mantém pacote e lockfile na mesma versão Baileys sem patch obsoleto', async () => {
    const projectRoot = process.cwd();
    const packageJson = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8'));

    assert.equal(packageJson.dependencies.baileys, '7.0.0-rc13');
    assert.equal(packageLock.packages[''].dependencies.baileys, '7.0.0-rc13');
    assert.equal(packageLock.packages['node_modules/baileys'].version, '7.0.0-rc13');
    await assert.rejects(
      access(resolve(projectRoot, 'patches/baileys+7.0.0-rc.6.patch')),
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    );
  });

  it('AC-5: mantém a cadeia XML fora das versões criticamente vulneráveis', async () => {
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
      assert.equal(
        isAtLeast(version, [5, 5, 6]),
        true,
        `fast-xml-parser ${version} permanece em uma faixa vulnerável`,
      );
    }
  });
});
