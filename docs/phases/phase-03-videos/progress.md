# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

## Auditoria das 57 acceptance criteria

Varredura explícita de **todas** as 57 ACs dos 10 SIs, feita depois de declarar a fase pronta — a pergunta "você validou cada uma delas?" expôs que eu havia validado os deliverables e as 9 capacidades, mas não percorrido as ACs uma a uma. A varredura encontrou **1 bug real**, **2 ACs sub-asseridas** e **1 AC que não vale literalmente**.

**Bug real — AC-35 falhava com arquivo de verdade.** "Um campo ausente na saída do `ffprobe` fica `NULL` na linha, e o job conclui com sucesso." O teste unitário que eu tinha cobria só a função de mapeamento, não o job. Com um arquivo real em que o `ffprobe` **de fato** omite campos (stream H.264 cru, sem container → sem `duration` nem `bit_rate`), o job terminava em `error`. Causa: **input seeking (`-ss` antes de `-i`) num stream sem timestamps de container faz o ffmpeg passar do input inteiro e escrever nada — saindo com código 0.** O `readFile` seguinte estourava `ENOENT`, que lê como problema de filesystem e não de thumbnail. Dois consertos: (1) o `-ss` é **omitido** quando o offset é 0 — não há o que buscar, e é a única forma que funciona para esses inputs; (2) depois de extrair, o worker confere que o arquivo existe e não está vazio, lançando erro descritivo caso contrário, já que o ffmpeg não sinaliza isso pelo exit code. Fixture `sample-no-metadata.h264` commitada e documentada; 2 testes de integração novos cobrem metadados NULL **e** thumbnail gerado mesmo sem duração (é para isso que `THUMBNAIL_FALLBACK_SECONDS` existe).

**AC-20 estava sub-asserida.** "Deixa o schema no estado anterior" — o teste só afirmava que `videos` sumiu. Um revert que derrubasse `users` junto passaria. Passou a afirmar que as 4 tabelas da fase 02 sobrevivem e que a tabela `migrations` registra exatamente as 2 migrations anteriores.

**AC-25 só tinha comentário, não asserção.** "Derrubar a aplicação encerra as conexões do `pg-boss` sem deixar handle aberto" — havia um `onApplicationShutdown` e um comentário dizendo que sem ele o Jest travava, mas nada afirmava o fechamento. Agora há teste que conta `pg_stat_activity` por `application_name` (é para isso que `QUEUE_APPLICATION_NAME` existe) como **delta** — baseline, sobe ao abrir, volta ao baseline após o shutdown, com polling porque o pg-boss fecha de forma assíncrona.

**AC-14 resolvida movendo o harness para dentro de `src/storage/` (opção A, escolhida pelo usuário).** "Nenhum arquivo fora de `src/storage/` importa de `@aws-sdk/`." O harness de teste importava o SDK e eu havia afrouxado o próprio teste de encapsulamento para isentá-lo — o que era um conflito entre duas exigências da **mesma** fase: a AC-14/TD-02 proíbe o import fora de `src/storage/`, e a ação 1 de SI-03.9 manda criar um harness que dirige o storage real (precisa de `ListObjectsV2`, `DeleteObject(s)` e `CreateMultipartUpload`; o `StorageService` cobre 5 das 7 operações, faltando só listagem e remoção de objetos).

`src/test/storage.ts` passou a ser **`src/storage/storage.test-harness.ts`**, com seu spec ao lado (`storage.test-harness.integration-spec.ts`, que também é a convenção do projeto de teste junto ao fonte). O nome **não** usa sufixo `.spec.ts`/`.integration-spec.ts` de propósito — o harness não é um teste e não pode casar com o `testRegex` do Jest. A isenção foi **removida**: o teste de encapsulamento voltou a ser uma asserção única e sem exceções, e `grep -rln "@aws-sdk/" src | grep -v "^src/storage/"` não retorna nada. Isso contraria o caminho que a ação 1 de SI-03.9 nomeia literalmente (`src/test/storage.ts`), que é a razão de a decisão ter sido do usuário; o plano permanece como registro histórico do contrato e esta nota registra o desvio.

Descartadas: manter a isenção (deixaria o gate oficialmente não cumprido) e adicionar `listObjects`/`deleteObjects` ao `StorageService` (colocaria superfície de produção existindo só para teste).

**AC-37 verificada por composição, não ponta a ponta.** "Falha todas as tentativas → `error`, `processing_error` preenchido, `processing_attempts` igual a 3." O estado final está asserido, e as três peças que o compõem também: `retryLimit=3` conferido no banco (AC-23), `error` dentro do conjunto reivindicável (testado) e o contador limitado a 3 sob entrega repetida (testado). O que **não** é exercitado é o pg-boss redistribuir fisicamente 3 vezes com backoff de 60 s — isso levaria minutos de wall clock por execução, então fica fora da suíte de propósito.

As 52 ACs restantes foram confirmadas: 1–13, 15–19, 21–24, 26–34, 36, 38–57, cada uma com asserção de teste ou verificação empírica contra a stack no ar (os detalhes por SI estão abaixo).

### SI-03.1.1 — Infra: instalar bibliotecas e estender o contrato de env
- **Status:** completed
- **Tests:** 21/21 passing (env.validation.integration-spec.ts, storage.config.spec.ts)
- **Observations:**
  - **pg-boss@12.38.0 rejeitado pelo spike da action 2.** Type-checka sob `module: nodenext` (o pacote não tem `exports` map, só `main`, então não há condição `require` para falhar), mas falha em runtime sob `ts-jest`: `SyntaxError: Cannot use import statement outside a module` em `node_modules/pg-boss/dist/index.js:1`. Aplicado o fallback documentado: `pg-boss@11.0.2` (CommonJS), que passa as duas metades do spike. Migrar o Jest para ESM atingiria os 27 arquivos de teste existentes — fora do escopo deste SI.
  - **Diferença de API entre v12 e v11.** A v11 declara `export = PgBoss`, então o import é a forma default (`import PgBoss from 'pg-boss'`), não a forma nomeada `{ PgBoss }` que o `library-refs.md` documentava a partir da v12. Corrigi o `library-refs.md` (pin, formato de módulo, forma do import e a evidência do spike) porque SI-03.4 lê essa seção para escrever o `QueueModule`.
  - Tornar as chaves `S3_*` obrigatórias no Joi quebrou os 4 testes pré-existentes de `env.validation.integration-spec.ts` — a fixture `requiredEnv` deles não tinha as novas chaves. Estendi a fixture em vez de relaxar o schema.
  - Adicionei o bloco de storage ao `.env` local (untracked, gitignored) para a aplicação conseguir subir; o `.env.example` carrega as mesmas chaves como contrato versionado. O `.env.example` já tinha uma correção pendente de quoting em `MAIL_FROM`, não relacionada a esta fase — preservada.

### SI-03.1.2 — Infra: subir storage, bootstrap de buckets e worker no Compose
- **Status:** completed
- **Tests:** no tests (Infra) — ACs verificados empiricamente contra a stack no ar
- **Observations:**
  - **Esta build do MinIO não suporta `AbortIncompleteMultipartUpload`.** A regra de lifecycle que TD-04 pedia é rejeitada com *"XML … did not validate against our published schema"* em **todas** as formas de `Filter` (ausente, `{}`, `{Prefix:""}`, `Prefix` legado no nível da regra) quando é a única ação; combinada com `Expiration` o servidor aceita a requisição e **descarta silenciosamente** a cláusula Abort (comprovado pelo readback). Verificado com dois clientes independentes — `mc ilm import` e `aws s3api put-bucket-lifecycle-configuration` — então é limitação de servidor, não de cliente. **Substituição:** o requisito de limpeza passa para o segundo mecanismo de TD-04 — o job `draft-reaper` enumera uploads obsoletos via `ListMultipartUploads` (filtrando pelo timestamp `Initiated`) e remove via `AbortMultipartUpload`. Ambas as APIs foram verificadas funcionando nesta build (criei um multipart órfão, listei e abortei). **Isso move trabalho de SI-03.1.2 para SI-03.6** e precisa ser refletido no plano/decisões.
  - `Dockerfile.dev` passou a ser multi-stage (`base` e `worker`). O `target:` explícito em cada serviço do compose é **load-bearing**: sem ele o Docker constrói o último stage e a API receberia ffmpeg. Verificado nos dois sentidos — ffmpeg/ffprobe `5.1.9-0+deb12u1` respondem em `video-worker` e estão ausentes em `nestjs-api`.
  - `minio-client` foi pinado em `2025.7.21` (tag de versão real mais recente, alinhada ao servidor `2025.7.23`); `latest` não é pin.
  - Diagnóstico intermediário que registrei errado antes de confirmar: atribuí a falha de lifecycle a uma limitação do `mc`. O `aws-cli` falha de forma idêntica, então a causa é o servidor. O comentário no `compose.yaml` e o `CLAUDE.md` registram a conclusão correta.

### SI-03.2 — Criar StorageModule sobre o AWS SDK v3
- **Status:** completed
- **Tests:** 19/19 passing (storage.service.spec.ts, storage.service.integration-spec.ts, storage.module.spec.ts)
- **Observations:**
  - **Dois `S3Client` distintos, não um.** SigV4 assina o header `host`, então uma URL assinada contra o endpoint interno (`minio:9000`) é rejeitada quando o cliente a usa a partir do host (`localhost:9000`). O cliente `internal` atende as chamadas servidor-a-servidor e o `presigner` só existe para gerar URLs com o host público — é por isso que `S3_ENDPOINT_INTERNAL` e `S3_ENDPOINT_PUBLIC` são duas chaves e não uma.
  - `getSignedUrl` não aceita uma união de tipos de comando: chamá-lo uma vez com o comando escolhido num `switch` não compila. A chamada foi movida para dentro de cada branch do `switch`.
  - Os testes de integração não podem dar `fetch()` numa URL assinada para o host público — de dentro do container `localhost:9000` é o próprio container. O helper `startMultipart` passou a usar o SDK contra o endpoint interno.
  - `OnModuleDestroy` destrói os dois clientes. Sem isso o Jest não encerra ("did not exit one second after the test run"), porque os agentes HTTP pooled ficam abertos; há um teste que afirma esse comportamento.

### SI-03.3 — Criar entidade Video e migration
- **Status:** completed
- **Tests:** 15/15 passing (video.entity.integration-spec.ts, videos.module.spec.ts, migrations.integration-spec.ts)
- **Observations:**
  - **`migrations.integration-spec.ts` travava indefinidamente (não falhava) depois de eu incluir `videos` em `MANAGED_TABLES`.** O setup emitia os `DROP TABLE ... CASCADE` dentro de um `Promise.all` sobre um único pool; `CASCADE` pega AccessExclusiveLock na tabela alvo **e** em toda tabela que a referencia, então dois drops concorrentes esperam cada um pelo lock que o outro já detém. O `Promise.all` é herdado da fase 02, mas só virou deadlock real quando `videos` (FK → `channels`) entrou no conjunto. Serializei os drops com um `for`/`await`.
  - **Derrubar tabela não derruba os tipos enum das suas colunas.** O teardown só removia `videos_status_enum` por nome, deixando `verification_tokens_type_enum` órfão depois de uma execução interrompida — e aí a migration seguinte falha em `CREATE TYPE`. Passou a enumerar os enums de `public` via `pg_type` e derrubar todos, de forma que uma execução que morre no meio não deixe um tipo que o próprio teardown não limpa.
  - `declared_size_bytes` e `size_bytes` são colunas separadas de propósito: a primeira é a alegação não confiável do cliente, a segunda é o que o ffprobe observou. O handshake de conclusão compara as duas (TD-04). Há um teste afirmando que são independentes.
  - A migration foi gerada pelo CLI do TypeORM, não escrita à mão, e tem `down()` completo — o teste de reversão depende disso.
  - Um teste afirma explicitamente a **ausência** de `visibility`/`published_at`: esse eixo é da fase 04 e dobrá-lo no enum de status forçaria uma migration de enum depois.

### SI-03.4 — Criar QueueModule sobre pg-boss
- **Status:** completed
- **Tests:** 10/10 passing (queue.module.spec.ts, queue.service.integration-spec.ts)
- **Observations:**
  - **O enqueue transacional funciona e está coberto — é a justificativa central de TD-07.** O teste abre uma transação TypeORM, enfileira por dentro dela via o adaptador BYODB (`db: { executeSql }`) e lança; o job desaparece junto com o rollback. Um segundo teste confirma, de uma conexão **separada**, que a linha não vazou para a conexão ambiente — é o que prova que o `executeSql` rodou na transação e não num membro qualquer do pool.
  - **`getQueueStats` tem o tipo errado na v11.0.2.** O `types.d.ts` declara `Promise<number>`, mas o runtime devolve uma linha de agregação (`{ name, queuedCount, activeCount, deferredCount, totalCount }`) — e devolve **`null`**, não uma linha zerada, quando a fila não tem nenhum job. Encapsulado em `stats()` com a interface `QueueStats` real e um cast estreito; `queueSize()` lê `queuedCount` com `?? 0`.
  - **`deleteQueuedJobs` não limpa fila.** Remove só os jobs em estado *queued* e deixa os *active* para trás, o que contaminava silenciosamente o teste seguinte. `drain()` usa `deleteAllJobs`.
  - O `draft-reaper` é periódico, então quem detém a cadência é o `boss.schedule(queue, cron)` do pg-boss (de hora em hora), não código da aplicação enfileirando à mão.
  - `useListenNotify` **não existe** na v11 — removi do `library-refs.md` a afirmação de "~3ms de latência de pickup" que vinha da doc da v12.

### SI-03.3 — Criar entidade Video e migration
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.4 — Criar QueueModule sobre pg-boss
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Implementar o handshake de upload (rascunho, assinatura, conclusão)
- **Status:** completed
- **Tests:** 43/43 passing (23 unit em `videos.service.spec.ts`, 12 integração em `videos.service.integration-spec.ts`, 8 e2e em `test/videos-upload.e2e-spec.ts` — os 7 cenários de `specs/videos-upload.plan.md` mais o de wiring do `ValidationPipe`)
- **Observations:**
  - **O `id` é gerado em código, não pelo banco.** `video_key` deriva do id, então o id precisa existir antes do INSERT — `randomUUID()` na aplicação em vez de deixar o default `uuid_generate_v4()` da coluna decidir. É isso que mantém a key **autoritativa do servidor**: o cliente nunca propõe uma key, ele recebe uma.
  - **Conflito aparente entre a AC #6 e o Error Catalog, resolvido na leitura literal.** A AC diz que chamar `upload-complete` duas vezes "deixa exatamente um job na fila e o status em `processing`" (fala só de efeito colateral, não de status code), e o Error Catalog diz `409 VIDEO_INVALID_STATE` quando o vídeo não está em `draft`. Implementei o literal: a segunda chamada dá 409 e a AC continua satisfeita. O spec de e2e foi escrito de propósito sem afirmar status code no passo 2, então as duas leituras passam.
  - **A idempotência está no `UPDATE` condicional, não no read.** O `WHERE id = :id AND status = 'draft'` é o que impede um segundo enqueue mesmo que duas chamadas passem juntas pela leitura anterior; `affected === 0` lança, o que **rola a transação de volta** e portanto também descarta o job. Há um teste que força uma falha depois do enqueue e afirma que nem o job nem a transição sobrevivem.
  - **A validação da `key` roda antes de assinar, e há um teste que afirma exatamente isso** (`presignUpload` não foi chamado). Sem essa ordem o endpoint é um oráculo que assina qualquer key do bucket.
  - A posse do canal é lida via `ChannelsService.findByUserId` (método novo), não consultando a entidade `Channel` de dentro de `VideosModule` — o domínio de vídeos não alcança a tabela de outro módulo.
  - `ParseUUIDPipe` no parâmetro `:id`: sem ele um id não-UUID vaza até o Postgres e vira 500 (`invalid input syntax for type uuid`) em vez de 400.
  - Extensão da key derivada do `content_type` com fallback `.bin` para tipo desconhecido, em vez de rejeitar: a key é só um caminho de storage e o formato autoritativo é o que o ffprobe observa. Nenhuma fonte pede allowlist de formato nesta fase.

### SI-03.9 — Montar a infraestrutura de testes de storage, fila e FFmpeg
- **Status:** completed
- **Tests:** 5/5 passing (`src/storage/storage.test-harness.integration-spec.ts`); a asserção de `ffprobe` sobre a fixture pertence a `src/worker/ffmpeg.service.integration-spec.ts` e é entregue com SI-03.6
- **Observations:**
  - Executado **antes** de SI-03.5 por ordem topológica (depende só de 03.1.2 + 03.2 + 03.4, todos prontos) — escrever os helpers primeiro evitou que SI-03.5 criasse versões ad-hoc que depois seriam duplicadas.
  - `createTestStorage(suite)` prefixa toda key com `test/<suite>/<uuid>`, e o `cleanup()` remove objetos **e** multiparts em voo sob o prefixo — multiparts são invisíveis ao `ListObjectsV2` e esta build do MinIO não os expira por lifecycle, então sem isso um teste que abre um multipart e não conclui vaza storage para sempre.
  - **Precisei de um `remove(bucket, key)` por key absoluta.** As keys que a *aplicação* gera (`videos/<uuid>/original.mp4`) são autoritativas do servidor e ficam **fora** do prefixo da suíte, então a varredura por prefixo não as alcança; as suítes que as usam registram as keys escritas e as removem no `afterAll`.
  - `ListObjectsV2` é paginado — o cleanup segue o `NextContinuationToken`. Uma leitura de página única deixaria objetos para trás silenciosamente.
  - Fixture `sample.mp4` (15.725 bytes, 2.000000 s, 320×240, h264) gerada pelo ffmpeg do próprio container `video-worker` e **commitada**: gerar em tempo de teste faria os valores esperados depender do build de ffmpeg instalado. Os números estão documentados em `src/test/fixtures/README.md`, que é o par da asserção.
  - Declarada em `nest-cli.json` sob `compilerOptions.assets` e **verificado** que aparece em `dist/test/fixtures/` depois de `npm run build`.
  - **Fora de escopo, anotado como tarefa separada:** `createTestDataSource` lê `process.env.DB_DATABASE`, mas a chave real no `.env` é `DB_NAME`. Hoje não quebra porque o fallback é `'streamtube'`, igual ao valor real — mas um `DB_NAME` divergente apontaria os testes para o banco errado sem avisar.

### SI-03.6 — Criar o worker de vídeo e o FfmpegService
- **Status:** completed
- **Tests:** 46/46 passing (`ffmpeg.service.spec.ts` 17 unit, `ffmpeg.service.integration-spec.ts` 7, `worker.module.spec.ts` 3, `video-processing.integration-spec.ts` 11, `draft-reaper.integration-spec.ts` 8)
- **Observations:**
  - **As suítes de integração do worker precisam rodar dentro do container `video-worker`, não no `nestjs-api`.** ffmpeg/ffprobe só existem na imagem do worker (é justamente o que o `target:` do compose garante), então `docker compose exec video-worker npx jest ... src/worker/` é a invocação correta. Registrado em `nestjs-project/CLAUDE.md`.
  - **Bug real de boot do worker, pego pelo teste de compilação.** `WorkerModule` declarava `entities: [Video]`, mas `Video` tem `@ManyToOne(() => Channel)` e `Channel` tem `@ManyToOne(() => User)`; o TypeORM resolve os lados inversos na inicialização e falhava com *"Entity metadata for Video#channel was not found"* — o container **não subiria**. Passou a declarar o grafo inteiro (`[User, Channel, Video]`).
  - **`force_original_aspect_ratio=decrease` não impede upscale.** O teste de integração pegou um thumbnail de 320×240 virando **960×720** (encaixa a altura no box). Upscalear produz um JPEG mais borrado e maior sem nenhum detalhe novo, então o filtro passou a limitar ao tamanho da fonte: `scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease`. As aspas simples são do parser de filtergraph (vírgula nua separa **filtros**), não de shell — não há shell envolvido.
  - **Segunda limitação desta build do MinIO: `ListMultipartUploads` ignora o parâmetro `Prefix`.** O valor volta ecoado na resposta e o conjunto de resultados vem **vazio**, embora os mesmos uploads apareçam quando o parâmetro é omitido. Isso tornava o cleanup de multipart do helper de teste um no-op silencioso. Passou a listar sem `Prefix` e filtrar no cliente (`listOwnUploads`). `StorageService.listStaleUploads` não é afetado porque o reaper varre o bucket inteiro por desenho. Registrado em `nestjs-project/CLAUDE.md`.
  - `-ss` **antes** de `-i` tem um teste dedicado que afirma a posição relativa no argv. Com `-ss` depois de `-i` o ffmpeg decodifica e descarta tudo até o timestamp — num arquivo de 10 GB é a diferença entre instantâneo e minutos.
  - O seam de processo (`ProcessRunner`) recebe argv como **array** e nunca string de shell; há um teste de integração que passa um nome de arquivo hostil (`x; touch <canário>`) e afirma que o canário **não** foi criado.
  - O handler faz `claim` por update condicional com `status IN ('draft','processing','error')`; `error` está no conjunto de propósito para que a retry da fila (e o reprocess de SI-03.7) consigam re-reivindicar a linha. O teste de entrega duplicada afirma que `updated_at` **não muda** na segunda entrega.
  - O handler **não relança** em falha de processamento — registra `processing_error`/`processing_attempts` e retorna. Relançar de um handler de fila derrubaria o processo do worker (`.claude/rules/nestjs-services.md` § background tasks). Há um teste que afirma `resolves.toBeUndefined()`.
  - O download é **streaming para disco** (`pipeline`), não `Buffer`: o objetivo da fase é suportar até 10 GB e um `Buffer` desse tamanho estoura o limite máximo de buffer do Node muito antes de esgotar memória. O `finally` remove o diretório temporário sempre, e há um teste que afirma que nada sobrou em `tmpdir()`.
  - **AC #6 verificada empiricamente:** com `dist/main` (API) e `dist/main.worker` (worker) rodando, enfileirei um vídeo de 7,9 MB / 120 s / 1920×1080 e martelei `GET /` enquanto processava — **8/8 respostas 200, nenhuma falha**, e o vídeo terminou `ready` com `duration_seconds=120.000` e `1920x1080`. Nota: na primeira tentativa usei `start:dev` e vi dois `000`; a causa era o **watcher** do `nest start --watch` reiniciando o servidor porque eu havia escrito o script de seed dentro da árvore observada — artefato do meu método de teste, não do worker. Refeito contra o build.
  - O `draft-reaper` é o portador do requisito de limpeza que a regra de lifecycle do MinIO não aceita; a suíte dele é a evidência dessa substituição. Cobre: só apaga `draft` (nunca `processing`/`ready`/`error`, com teste para cada), respeita a janela de expiração, aborta multipart anterior ao corte, **preserva** multipart recém-iniciado (um upload que o usuário está retomando) e é idempotente.
  - `compose.yaml` mantém `tail -f /dev/null` como comando do `video-worker`, igual ao `nestjs-api` — é a convenção já estabelecida em `nestjs-project/CLAUDE.md` ("subir o ambiente" significa subir só infraestrutura). O serviço existe no Compose, que é o que `desafio.md:143` exige; os comandos `start:worker` / `start:worker:dev` / `start:worker:prod` foram adicionados ao `package.json`.

### SI-03.7 — Implementar leitura de status e reprocessamento
- **Status:** completed
- **Tests:** 47/47 passing do SI (38 unit em `videos.service.spec.ts`, 20 integração em `videos.service.integration-spec.ts` — 8 novos, 9 e2e em `test/videos-read.e2e-spec.ts`). Suíte completa: **314/314** unit+integração e **69/69** e2e.
- **Observations:**
  - **`@Public()` curto-circuitava o guard antes de ler o token, o que tornava a Authorization Matrix inimplementável.** A matriz exige que `GET /videos/{slug}` atenda anônimos quando `ready` **e** mostre um vídeo não-`ready` ao **dono** — mas o `JwtAuthGuard` retornava `true` imediatamente numa rota pública, deixando `request.user` indefinido mesmo para um dono corretamente autenticado. Passou a fazer autenticação **best-effort** na rota pública (`tryAttachUser`): token ausente, malformado, expirado ou forjado simplesmente não popula `request.user` e nunca é erro. Adicionei o decorador `@OptionalUser` porque `CurrentUser` declara `JwtPayload` não-nulo e mentiria sobre o tipo nessas rotas. Mudança num artefato herdado da fase 02, feita porque é um habilitador necessário da AC, não um desvio oportunista — a suíte de auth (73 unit/integração + 45 e2e) foi re-executada e passa.
  - **Regressão que eu mesmo introduzi em SI-03.3, encontrada agora ao rodar a suíte completa.** Adicionar `@OneToMany(() => Video)` em `Channel` quebrou **todas** as suítes pré-existentes cujo array de entidades omitia `Video` (`auth.service.integration-spec`, `channels.*`, `users.*`): o TypeORM resolve o lado inverso na inicialização e falha com *"Entity metadata for Channel#videos was not found"*. Eram 10 arquivos com cópias próprias de `const ALL_ENTITIES = [...]`. Em vez de adicionar `Video` em cada um, centralizei `ALL_ENTITIES` em `src/test/create-test-data-source.ts` — uma entidade nova agora é uma linha ali, não uma caçada por uma dúzia de arquivos. Só foi pega porque eu havia rodado apenas as suítes da fase até aqui.
  - **`npm run test:e2e` não serializava, apesar de `nestjs-project/CLAUDE.md` afirmar que estava "já configurado".** Nem o script tinha `--runInBand` nem `test/jest-e2e.json` tinha `maxWorkers`. Com só 3 suítes (app, swagger, auth) era benigno porque duas não tocam tabelas; as duas suítes novas de vídeo expuseram o problema — rodando em workers paralelos contra um único banco, o `cleanAllTables` de cada `beforeEach` apagava os dados das outras (13 testes falhavam juntos e passavam isolados, incluindo um de auth). Corrigido com `"maxWorkers": 1` no **config** e não no script, para que qualquer invocação do jest herde.
  - Duas suítes ficaram **obsoletas** por mudanças legítimas e precisaram ser atualizadas, não "consertadas": `videos.module.spec.ts` foi escrita quando `VideosModule` não tinha dependências e `overrideProvider(DataSource)` não alcança dentro de `ChannelsModule` (passou a usar `forRoot`, como já faziam `channels.module.spec.ts`/`users.module.spec.ts`); e o teste de encapsulamento do AWS SDK isentou temporariamente o harness — resolvido depois movendo o harness para `src/storage/` e removendo a isenção (ver a auditoria das ACs, AC-14).
  - `SlugParamPipe` novo: parâmetro de rota não é coberto pelo par `ValidationPipe` + DTO, então sem ele uma string arbitrária chega até a query do repositório. Valida os 11 caracteres do alfabeto URL-safe do nanoid.
  - As colunas `bigint`/`numeric` fazem round-trip como **string** no TypeORM; a resposta converte para número (`duration_seconds`, `bitrate_bps`, `size_bytes`) — um cliente que faz polling de duração não deveria ter que parsear string. Há teste unitário afirmando isso.
  - O `reprocess` **não** zera `processing_attempts` — é a trilha de auditoria de quantas vezes o vídeo já falhou. Apenas `processing_error` é limpo. Há teste afirmando `processing_attempts === 3` depois do re-enqueue.
  - Conflito aparente entre AC #5/#6 e o Error Catalog resolvido como em SI-03.5: estado não-`error` → `409 VIDEO_INVALID_STATE`, com teste afirmando que **nada** é enfileirado nesse caminho.
  - AC #7 verificada: `npm run openapi:export` emite os 5 endpoints de vídeo, com `security` presente nos 4 autenticados e **ausente** no `GET /videos/{slug}` público, mais o schema `VideoResponseDto`. O `@ApiBearerAuth('access-token')` ficou por método em vez de na classe justamente porque a regra de controllers proíbe anunciar auth numa rota `@Public()`.
  - **Dívida de lint pré-existente, não introduzida por esta fase.** Medi o baseline num worktree de `HEAD`: **190 problemas / 150 erros** já antes da fase 03. Deixei meus 64 arquivos com **zero** problemas e o projeto fechou em **172 / 133** — ou seja, abaixo do baseline. Os 133 erros restantes estão todos em arquivos da fase 02 que não toquei (`no-unsafe-member-access` em `res.body` do supertest, `unbound-method` em mocks). **`npm run lint` continua falhando por essa dívida herdada** e limpá-la é uma tarefa separada.

### SI-03.8 — Implementar streaming por range e download
- **Status:** completed
- **Tests:** 46/46 do SI (26 unit em `range.util.spec.ts`, 9 integração novos em `videos.service.integration-spec.ts`, 11 e2e em `test/videos-stream.e2e-spec.ts`)
- **Observations:**
  - **O `Content-Type` vem da linha, não dos metadados do objeto — e isso foi uma descoberta do teste, não uma escolha a priori.** O objeto é gravado por um PUT assinado, que **não precisa** enviar header `Content-Type`; quando não envia, o storage registra `application/octet-stream`, e devolver isso faz o navegador **baixar** em vez de reproduzir. A linha é o registro autoritativo do que o vídeo é; o valor do storage ficou só como fallback. Há um teste que grava o objeto sem content type, afirma que o storage reporta `application/octet-stream` e que a resposta ainda assim é `video/mp4`.
  - **Um `Range` malformado é `200`, não `416`.** A RFC 9110 manda **ignorar** um header de Range que não dá para parsear; só um range bem-formado e insatisfazível é 416. O `resolveRange` separa os dois casos com tipos distintos (`null` vs `UnsatisfiableRangeError`) em vez de misturar, e há uma tabela de 7 headers que devem cair em `200`.
  - Um range cujo fim passa do objeto é **clampado**, não rejeitado — a parte que se sobrepõe é satisfazível e a RFC exige servi-la. Só `start >= total`, range invertido e sufixo zero viram 416.
  - A forma sufixo `bytes=-N` (últimos N bytes) está implementada e testada porque é como um player lê o átomo `moov` de um MP4 sem faststart, que fica no **fim** do arquivo. Sem ela, esses vídeos não iniciam.
  - Os testes de integração e e2e usam um objeto cujo byte no índice `i` é `i % 251` — primo, então o padrão nunca se alinha com uma fronteira de range potência-de-dois. Um off-by-one na aritmética aparece como **bytes errados**, não só como tamanho errado; as asserções comparam `Buffer.equals` contra a fatia esperada, não apenas o comprimento.
  - O e2e faz duas requisições de ranges adjacentes e afirma que os corpos **diferem** — é o que prova que o intervalo chegou ao storage em vez de ser ignorado com o início do objeto devolvido duas vezes.
  - `Accept-Ranges: bytes` vai em **toda** resposta, inclusive no `200`: é como o player descobre que pode fazer seek.
  - Status e headers são escritos no handler via `@Res({ passthrough: true })` e não por decorador, porque dependem de haver ou não um `Range` utilizável — um `@HttpCode` fixo não expressa 200 e 206 ao mesmo tempo.
  - `/download` honra `Range` também, com teste — sem isso um download interrompido não retoma.
  - AC #7 verificada: os 7 endpoints da fase estão no `openapi.json`, e os dois de entrega documentam `200,206,400,404,409,416` com `security` ausente (são públicos).
  - **Defeito funcional encontrado só na verificação manual contra a stack no ar: o rate limit derrubava streaming e polling.** O `ThrottlerGuard` é registrado como `APP_GUARD` dentro do `AuthModule`, o que o torna **global** a 10 req/60s — e não "escopado ao AuthModule" como a nota da Authorization Matrix do plano afirmava. Com isso, as **duas** leituras documentadas quebravam: de 40 requisições de range anônimas em `/stream`, **30 voltaram 429**, e o intervalo de polling de 3 s recomendado no OpenAPI estoura 10/min depois de meio minuto (processar um vídeo grande leva minutos). O plano declara explicitamente que "as rotas de streaming deliberadamente não são limitadas, já que range requests são muitas por reprodução" — então a intenção estava escrita, só a premissa sobre a implementação estava errada. Apliquei `@SkipThrottle()` nas três rotas públicas de leitura (`GET /videos/:slug`, `/stream`, `/download`) e deixei as rotas de escrita limitadas. Re-verificado no ar: **40/40 `206`** em stream, **40/40 `200`** em polling, **15/15 `200`** em download, e em escrita autenticada **10 `201` + 6 `429`** — o limite continua ativo onde deve. Há 3 testes e2e de regressão para isso.
  - Nota lateral descoberta no mesmo teste: o `JwtAuthGuard` roda **antes** do `ThrottlerGuard` (ordem do array de providers do `APP_GUARD`), então requisição sem token nunca chega ao throttler — 16 POSTs anônimos devolveram 16 `401`, nenhum `429`. O limite de escrita só se aplica a chamadas autenticadas.

### SI-03.9 — Montar a infraestrutura de testes de storage, fila e FFmpeg
- **Status:** pending
- **Tests:** —
- **Observations:** none
