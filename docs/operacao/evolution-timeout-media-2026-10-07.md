# Evolution: timeout de sessão e falha na preparação de mídia

Diagnóstico e correção realizados em 07/10/2026. Horários dos eventos abaixo em America/Sao_Paulo.

## Resultado e escopo

Correção implementada no fork `evolution-api`, baseada em `origin/main` no SHA
`cef328ddb9197dcbc138ab44fa9b7fb092016442`. Branch:
`main-fix-whatsapp-timeout-media-20261007`. Worktree:
`/Users/sergioamim/dev/pessoal/conceitofit-worktrees/evolution-timeout-media-20261007`.

O backend Java é consumidor das rotas de envio. Não houve alteração de rotas,
payloads, autenticação ou isolamento por instância. A indisponibilidade de mídia
mantém a resposta HTTP 500 existente, com mensagem explícita, em vez de ser
classificada como payload inválido (400).

A publicação e aplicação foram autorizadas após a validação local. O baseline
observado antes do deploy é `v2.4.0-rc2-conceitofit.6`, com Baileys
`7.0.0-rc14`. O servidor estava sem reinícios desse container e sem OOM.

## Evidências e sequência do incidente

- 12:51:44: instância com prefixo de unidade `bbc6fe36` recebeu fechamento 408.
  A Evolution registrou `shouldReconnect: false`, ignorou reconexão e emitiu `LOGOUT`.
- 12:53:18: o mesmo caminho ocorreu para a unidade `18e9b684`.
- A configuração produtiva `DATABASE_SAVE_DATA_INSTANCE=true` habilita a limpeza
  de arquivos e registros da sessão ao receber `logout.instance`.
- Após novas tentativas de conexão, ocorreram fechamentos 428 e geração de QR.
- 13:12:55: houve `Cannot read properties of undefined (reading 'attrs')` em
  `baileys/lib/Socket/messages-send.js:58:41`.
- 13:39:28: uma stack mais completa confirmou `prepareWAMessageMedia` ->
  `prepareMediaMessage` -> `mediaMessage` -> `sendMedia`.
- A unidade `bbc6fe36` abriu conexão às 13:36:02. A última consulta de estado feita
  durante a implementação indicou uma instância `open`, uma `connecting` e duas
  `close`. Isso é uma fotografia temporal do código antigo, não validação do fix.

Esses eventos provam que os fechamentos 408 precederam o erro de mídia. Não há
evidência suficiente para atribuir o timeout inicial a rede, telefone, WhatsApp
ou versão de protocolo. Os logs Baileys em produção usam nível `error`, portanto
não capturam o aviso de timeout de consulta emitido em nível `warn`.

## Problemas encontrados e correções

| Problema | Comportamento anterior | Correção |
| --- | --- | --- |
| Timeout tratado como logout | 408 pertence à lista terminal e dispara limpeza de credenciais | 408 passa ao caminho de reconexão, preservando sessão |
| Reconexão repetida com intervalo fixo | Toda tentativa aguarda 3 segundos | Espera de 3, 6, 12, 24, 48 e até 60 segundos; reinicia após conexão aberta ou invalidação explícita |
| Preparação de mídia sem conexão utilizável | Inicia processamento/upload mesmo enquanto a sessão tenta conectar | Exige estado `open`, usuário autenticado e WebSocket aberto antes do processamento |
| Resposta `media_conn` ausente/inválida | Acesso direto a `mediaConnNode.attrs` | Valida nó, autenticação, TTL e hosts; retorna erro explícito |
| Falha armazenada no cache | Promise rejeitada reaproveitada nas chamadas seguintes | Remove somente a tentativa falha ainda vigente, permitindo nova consulta |
| Consultas concorrentes duplicadas | Duas primeiras chamadas podem iniciar duas consultas | Compartilha a consulta pendente; mantém cache válido e substitui cache expirado |

O Baileys pode devolver `undefined` em timeout de `waitForMessage`. Isso oferece
um caminho concreto para a ausência de `media_conn`, mas não prova qual resposta
exata foi recebida no incidente: o conteúdo do protocolo não foi capturado.

O ajuste da dependência é persistido em
`patches/baileys+7.0.0-rc14.patch`. O `postinstall` existente aplica o patch no
`npm ci`; o Dockerfile já inclui `patches` e executa `patch-package`.
Não se depende de edição manual do container de produção.

## Validação

Os testes novos executam os métodos reais extraídos e transpilados do serviço,
com colaboradores isolados, e a função real do pacote Baileys instalado. Não
inicializam banco produtivo nem abrem uma conexão real com o WhatsApp.

Antes do fix foram reproduzidos: 408 sem reconexão, acesso a `attrs` em resposta
ausente, aceitação de resposta de mídia inválida e consulta inicial duplicada.
Uma reprodução isolada do código instalado no servidor também confirmou duas
falhas consecutivas de `attrs` com apenas uma consulta: cache de tentativa falha.

| Critério | Teste em `test/whatsapp-timeout-media.test.ts` | Resultado |
| --- | --- | --- |
| 408 agenda retry sem logout e sem escrita terminal | `408 preserves the session...` | COVERED |
| Códigos terminais mantêm logout | Casos 401, 403, 440, 402 e 406 | COVERED |
| Espera cresce e reinicia após conexão aberta | Testes de lifecycle e handler real | COVERED |
| Evento de socket substituído não limpa a sessão atual | `superseded socket events...` | COVERED |
| Mídia desconectada falha antes de download/upload, com HTTP 500 | `disconnected media fails...` | COVERED |
| Resposta ausente/inválida permite nova consulta e cache posterior | Três casos `invalid media response...` | COVERED |
| Concorrência compartilha consulta | `concurrent media preparations...` | COVERED |
| Rejeição de transporte não contamina novas tentativas | `a transport rejection...` | COVERED |
| Preparação autenticada mantém conteúdo do documento | `successful media preparation...` | COVERED |

Verificações executadas:

- `npm test`: 64 testes aprovados, incluindo 16 novos.
- `npm ci` após gerar o patch: aplicação automática do patch confirmada;
  regressões executadas novamente contra a instalação limpa.
- `DATABASE_PROVIDER=postgresql npm run db:generate`: cliente Prisma gerado.
- `npm run build`: TypeScript e bundle aprovados.
- ESLint nos dois arquivos de serviço alterados: aprovado.
- `git diff --check`: aprovado.

## Limites e aplicação em produção

Os testes comprovam os comportamentos corrigidos; não comprovam entrega real de
mensagem, estabilidade de sessão no WhatsApp ou recuperação de credenciais já
apagadas. Não foram enviados textos/documentos de teste a contatos reais.

Para aplicar: publicar imagem imutável do fork contendo o patch, atualizar a
definição persistente no Dokploy e executar deploy. O processo reinicia a
Evolution e interrompe as conexões brevemente. Manter a imagem `.6` como rollback.
Sessões ainda persistidas podem reconectar; sessões anteriormente apagadas pelo
fluxo de logout podem precisar de novo pareamento por QR.

O pós-deploy precisa confirmar imagem/revisão, ausência de reinícios/OOM, estados
por instância, retry de 408 sem `LOGOUT`, recuperação de mídia após falha e entrega
de um documento real a um destinatário de teste autorizado. Rollback para `.6`
restaura o comportamento antigo e não recupera credenciais apagadas.

## Publicação e deploy concluídos

- Commit de implementação publicado na main: `005ee200644affc2e806d607556949333ef8a390`.
- Tag Git/release: `v2.4.0-rc2-conceitofit.7`.
- Build AMD64/ARM64 aprovado: https://github.com/sergioamim/evolution-api/actions/runs/37668536043.
- Imagem publicada e efetivamente implantada: `ghcr.io/sergioamim/evolution-api@sha256:15bc85621842ae45dc5ec6eebe0e18a3a7c0ba394972772bd2f3d51a588f624a`.
- O build duplicado da tag demorou além do principal e foi cancelado; a produção usa o digest imutável do build principal do mesmo commit. Não afirmar que uma imagem com a tag `.7` está publicada.
- Definição persistente atualizada pela API Dokploy; `compose.deploy` concluído, status `done`. Env preservado.
- Container iniciado em `2026-10-07T19:10:21Z`, revisão `005ee20`, `running`, restart count zero, sem OOM.
- HTTP público 200.
- Antes: uma sessão open, três close. Depois: a sessão bbc6fe36 voltou a open sem QR; 18e9b684 e saas connecting; d37174be close. São estados temporais, não estabilidade prolongada.
- Logs desde o startup: zero ocorrências de erro attrs, LOGOUT, ECONNREFUSED, PrismaClientInitializationError e unhandledRejection na primeira verificação.
- Smoke isolado executado na imagem e no container produtivo: resposta media_conn ausente gera erro explícito; tentativa seguinte recupera; concorrência compartilha consulta; cache válido reaproveitado. Sem tráfego de teste ao WhatsApp.
- Rollback disponível na imagem `.6` e definição anterior guardada no control-plane com permissão 0600.
- Não houve envio real de mensagem de teste. Sessões sem credenciais ainda podem precisar de pareamento.
