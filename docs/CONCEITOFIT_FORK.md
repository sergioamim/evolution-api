# Fork Conceito Fit

Este fork mantém correções operacionais necessárias ao Conceito Fit enquanto elas não estão disponíveis em uma release upstream homologada.

## Proveniência

- Fork gravável: `https://github.com/sergioamim/evolution-api`
- Upstream: `https://github.com/evolution-foundation/evolution-api`
- Base desta linha: tag `2.4.0-rc2`
- Commit-base: `5624bdaea81c58e4db60fe2a3a8de7c48bba1e60`
- Correção upstream incorporada: PR `#2560`, commit `aaeaf51d55a317c1dabf2071eab8216dec5956fb`

A branch não deve ser reconstruída a partir da `main` do fork sem uma nova avaliação: no momento da criação desta linha, aquela branch apontava para a série `2.3.7`, diferente do runtime alvo.

## Correção de recuperação de sessão

O patch reinicializa dois limites do lifecycle Baileys:

1. `logoutInstance()` substitui o estado do QR por `{ count: 0 }` depois da limpeza;
2. a preparação de um novo cliente define `endSession=false` e `isDeleting=false` antes de construir o socket.

Isso corrige o estado preso depois de logout ou `401/device_removed`. A correção não impede que o WhatsApp revogue um dispositivo; ela permite que o runtime gere uma nova tentativa sem restart do processo ou exclusão/recriação manual da instância.

## Baileys

Esta linha fixa `baileys` em `7.0.0-rc14` no `package.json` e no `package-lock.json`.

A atualização foi aplicada junto com a expansão da cobertura funcional e validada com instalação limpa, testes, lint e build. O arquivo `patches/baileys+7.0.0-rc.6.patch` continua removido porque a alteração já existe no código publicado das versões atuais do pacote.

### Política de atualização

Uma nova versão do Baileys não deve ser atualizada automaticamente. O fluxo obrigatório é:

1. fixar versão exata no pacote e lockfile;
2. comparar commits e breaking changes desde a versão atual;
3. verificar se patches locais foram incorporados upstream ou precisam ser refeitos;
4. executar `npm ci`, testes, lint e build com Prisma gerado;
5. homologar QR, reconexão, envio, ACK e inbound em sandbox;
6. publicar imagem imutável e manter digest anterior como rollback.

## Hardening do parser XML

As cadeias transitivas vulneráveis foram corrigidas pelos pacotes pais:

- `@aws-sdk/client-sqs` em `3.1095.0` usa `@aws-sdk/xml-builder` sem `fast-xml-parser`;
- `minio` em `8.0.7` resolve `fast-xml-parser` `5.10.1`;
- não há `override` global do parser entre majors diferentes.

O gate `npm run audit:critical` deve permanecer com exit code zero. Ele não afirma que toda a dívida de segurança histórica do projeto foi eliminada; bloqueia especificamente a presença de vulnerabilidades críticas na árvore instalada.

## Verificação local

```bash
npm ci
npm run audit:critical
npm test
npm run test:coverage
npm run lint:check
DATABASE_PROVIDER=postgresql npm run db:generate
DATABASE_PROVIDER=postgresql npm run build
```

Os testes automatizados cobrem os resets em memória. Eles não substituem a homologação real com WhatsApp.

## Release do fork

- Tag: `v2.4.0-rc2-conceitofit.6`
- Imagem: `ghcr.io/sergioamim/evolution-api:v2.4.0-rc2-conceitofit.6`
- Rollback de produção: `evoapicloud/evolution-api:2.4.0-rc2`

Tags do fork publicam somente no GHCR. O workflow Docker Hub legado é restrito ao repositório oficial `evolution-foundation/evolution-api`.

## Rollback

Antes de promover uma imagem do fork:

- registrar tag, digest, commit e versão efetiva do Baileys;
- preservar o digest atualmente implantado;
- não executar migração destrutiva junto com o cutover;
- reverter para o digest anterior se QR, `open`, envio, ACK ou inbound falharem.

Nunca versionar API keys, `.env`, QR Codes, credenciais Baileys, números de teste pessoais ou payloads reais neste repositório.
