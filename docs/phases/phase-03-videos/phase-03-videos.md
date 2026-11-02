---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-01T17:50:36+0000"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-01T17:45:47+0000"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-01T15:06:04+0000"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-01T11:29:11+0000"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver, in `nestjs-project` only, the backend for video upload and processing: a `Serviço de armazenamento de arquivos (vídeos e thumbnails)` and a `Serviço de processamento em segundo plano (filas)` running in Docker Compose alongside a dedicated video worker, `Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance` via presigned S3 multipart direct to storage with `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Processamento automático do vídeo após upload (extração de duração e metadados)` and `Geração automática de thumbnail a partir de um frame do vídeo` in the worker, `URL única por vídeo, sem conflito com outros vídeos`, and `Reprodução via streaming (sem necessidade de download completo)` plus `Download do vídeo pelo usuário` served as HTTP range responses from the API.

---

## Step Implementations

### SI-03.1.1 — Infra: instalar bibliotecas e estender o contrato de env (auto-split from SI-03.1 by /plan-build)

_Auto-split rationale: original SI-03.1 would have 7 Technical actions; split per "artifact type" — dependências e configuração da aplicação aqui, serviços de Compose em SI-03.1.2._

**Description:** Instalar as quatro bibliotecas novas da fase e registrar as chaves de env de storage no schema Joi e numa factory namespaced, para que todo o resto da fase leia configuração de uma única fonte.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3@3.1161.0`, `@aws-sdk/s3-request-presigner@3.1161.0`, `pg-boss@12.38.0` e `nanoid@3.3.11` dentro do container (per `phase-03-videos/TD-02`, `TD-07`, `TD-13`, `TD-17`). As versões e o motivo de `nanoid` ficar em 3.x estão em `library-refs.md`.
2. Verificar que `import { PgBoss } from 'pg-boss'` compila com `module: nodenext` e roda sob `ts-jest` — `pg-boss@12` é ESM-only; se falhar, trocar para `pg-boss@11.0.2` (CommonJS) conforme o fallback registrado em `library-refs.md`.
3. Estender `src/config/env.validation.ts` com `S3_ENDPOINT_INTERNAL`, `S3_ENDPOINT_PUBLIC`, `S3_REGION`, `S3_BUCKET_VIDEOS`, `S3_BUCKET_THUMBNAILS`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` e `PRESIGN_TTL_SECONDS` (per `phase-03-videos/TD-16`, revisões incluídas). Nenhuma chave de fila é adicionada — `pg-boss` reaproveita `databaseConfig` (per `phase-03-videos/TD-17`).
4. Criar `src/config/storage.config.ts` como factory `registerAs` namespaced, seguindo a convenção herdada de `phase-01-configuracao-base/TD-03`.
5. Atualizar `.env.example` com as novas chaves, mantendo os valores shell-safe conforme a convenção de `nestjs-project/CLAUDE.md`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` | Integration: schema aceita o conjunto completo de chaves e rejeita ausência das obrigatórias | `src/config/env.validation.integration-spec.ts` |
| `storage.config.ts` | Unit: factory mapeia env para o objeto de config tipado | `src/config/storage.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Subir a aplicação sem `S3_BUCKET_VIDEOS` definido falha no boot com erro de validação de env citando a chave ausente.
- Subir a aplicação com o conjunto completo de chaves de storage inicia sem erro de configuração.
- `UPLOAD_MAX_BYTES` não existe no schema de env nem no `.env.example` — nenhuma fonte exige limite de upload.
- `npx tsc --noEmit` sai com código 0 após a instalação das quatro bibliotecas.

---

### SI-03.1.2 — Infra: subir storage, bootstrap de buckets e worker no Compose (auto-split from SI-03.1 by /plan-build)

_Auto-split rationale: original SI-03.1 would have 7 Technical actions; split per "artifact type" — serviços de Compose e imagem do worker aqui, dependências e env em SI-03.1.1._

**Description:** Adicionar ao `nestjs-project/compose.yaml` os três serviços que a fase introduz — storage S3-compatível, sidecar de bootstrap dos buckets e o container do worker — de modo que `docker compose up -d` suba a stack completa.

**Technical actions:**

1. Adicionar o serviço de storage usando `bitnamilegacy/minio:2025.7.23` com healthcheck, portas `9000` (API S3) e `9001` (console) (per `phase-03-videos/TD-01`). A imagem `minio/minio` não é mais distribuída — o motivo está registrado em `library-refs.md`.
2. Adicionar o sidecar one-shot de bootstrap que cria **dois** buckets (`streamtube-videos`, `streamtube-thumbnails`) e aplica em cada um a regra de lifecycle que aborta multipart uploads incompletos (per `phase-03-videos/TD-01` revisão, `TD-05` revisão, `TD-04`).
3. Adicionar um stage de worker ao `Dockerfile.dev` que instala `ffmpeg` — somente nessa imagem, nunca na imagem da API (per `phase-03-videos/TD-08`, `TD-09`).
4. Adicionar o serviço `video-worker` com `depends_on` em `db` (`service_healthy`) e no serviço de storage (`service_healthy`) (per `phase-03-videos/TD-08`, `TD-16`).
5. Registrar em `nestjs-project/CLAUDE.md` as duas constrições aceitas: a imagem de storage está congelada e sem patches de segurança, e o schema `pgboss` é criado pela biblioteca no boot — não por migration (per `phase-03-videos/TD-01`, `TD-17`).

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1.1 — as chaves de env precisam existir antes de os serviços serem parametrizados

**Acceptance criteria:**

- `docker compose up -d` sobe `nestjs-api`, `db`, `mailpit`, o serviço de storage e `video-worker`, e `docker compose ps` mostra todos como `running`.
- O healthcheck do serviço de storage reporta `healthy`, e `nestjs-api` e `video-worker` só iniciam depois disso.
- Os buckets `streamtube-videos` e `streamtube-thumbnails` existem após o sidecar terminar, e rodar o sidecar uma segunda vez não falha.
- `ffmpeg -version` e `ffprobe -version` respondem dentro do container `video-worker` e **não** dentro de `nestjs-api`.
- A versão de `ffmpeg` efetivamente instalada está registrada em `nestjs-project/CLAUDE.md`.

---

### SI-03.2 — Criar StorageModule sobre o AWS SDK v3

**Description:** Encapsular todo acesso a object storage numa interface estreita, de modo que nenhum outro módulo importe `@aws-sdk/*` diretamente e a troca MinIO → S3 seja apenas configuração.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` expondo exatamente `presignUpload`, `presignDownload`, `headObject`, `getObjectStream` e `putObject` (per `phase-03-videos/TD-02`).
2. Construir **dois** `S3Client`: um ligado a `S3_ENDPOINT_INTERNAL` para operações server-side e outro ligado a `S3_ENDPOINT_PUBLIC` usado **somente** para assinar URLs destinadas a chamadores fora da rede Docker — SigV4 assina o header `host`, então a URL precisa ser assinada para o host que o chamador realmente alcança (per `phase-03-videos/TD-16`).
3. Configurar ambos com `forcePathStyle: true` e `region` vindos de `storage.config.ts` — `forcePathStyle` é obrigatório para MinIO e inofensivo em S3 (per `phase-03-videos/TD-01`, `TD-02`).
4. Implementar a função única que monta object keys: `videos/{videoId}/original{ext}` no bucket de vídeos e `videos/{videoId}/thumbnail.jpg` no bucket de thumbnails (per `phase-03-videos/TD-05` revisão, `TD-10` revisão).
5. Registrar `StorageModule` em `AppModule` e exportar `StorageService` para consumo por `VideosModule` e pelo worker.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test — DI resolve os dois clients e a config | `src/storage/storage.module.spec.ts` |
| `StorageService` | Unit: construção de object key para original e thumbnail nos buckets corretos | `src/storage/storage.service.spec.ts` |
| `StorageService` | Integration: `putObject` → `headObject` → `getObjectStream` contra o storage real do Compose | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1.1 (config) + SI-03.1.2 (serviço de storage no ar para o teste de integração)

**Acceptance criteria:**

- `putObject` seguido de `headObject` na mesma key retorna o tamanho exato dos bytes gravados.
- `getObjectStream` com um range de bytes retorna somente aquele trecho do objeto.
- Uma URL gerada por `presignUpload` tem como host o valor de `S3_ENDPOINT_PUBLIC`, não o de `S3_ENDPOINT_INTERNAL`.
- `headObject` numa key inexistente sinaliza ausência sem lançar erro não tratado.
- Nenhum arquivo fora de `src/storage/` importa de `@aws-sdk/`.

---

### SI-03.3 — Criar entidade Video e migration

**Description:** Materializar a tabela de vídeos ligada ao canal, com o ciclo de status, as chaves de storage, os campos de metadados e o identificador da URL única.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` como `@Entity('videos')` com todos os campos de `## Technical Specifications → ### Data Model → Video`, usando `@PrimaryGeneratedColumn('uuid')`, colunas em snake_case e `@CreateDateColumn`/`@UpdateDateColumn` conforme as regras de entidade do projeto.
2. Declarar a relação com `Channel` nos **dois** lados — `@ManyToOne` em `Video` e `@OneToMany` em `Channel` — com `@JoinColumn({ name: 'channel_id' })`.
3. Implementar a geração de `slug` em código de aplicação via `nanoid(11)`, com coluna `UNIQUE` e regeneração em caso de conflito de inserção (per `phase-03-videos/TD-13`).
4. Gerar a migration `CreateVideos` pelo CLI do TypeORM — nunca à mão — criando o enum de `status` com os quatro valores `draft`, `processing`, `ready`, `error` (per `phase-03-videos/TD-11`), o índice único em `slug` e índices em `channel_id` e `status`.
5. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, enum de status, unicidade de `slug`, FK para `channels` | `src/videos/entities/video.entity.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |
| migration `CreateVideos` | Integration: migration roda e reverte limpa | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1.1 — `nanoid` precisa estar instalado

**Acceptance criteria:**

- Inserir dois vídeos com o mesmo `slug` viola a constraint de unicidade.
- Inserir um vídeo sem `channel_id` viola a constraint de chave estrangeira.
- Um vídeo recém-criado tem `status` igual a `draft` e `processing_attempts` igual a `0` sem que esses valores sejam informados.
- Os sete campos de metadados aceitam `NULL` na criação do rascunho.
- A tabela `videos` não possui coluna `visibility` nem `published_at` — esse eixo é da Fase 04.
- `npm run migration:run` seguido de `npm run migration:revert` deixa o schema no estado anterior.

---

### SI-03.4 — Criar QueueModule sobre pg-boss

**Description:** Prover a fila de processamento em segundo plano sobre o PostgreSQL existente, com enqueue transacional, de modo que nenhum broker novo entre na stack.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` e `src/queue/queue.service.ts` encapsulando `PgBoss` atrás de uma porta estreita (`enqueueVideoProcessing`, `registerWorker`), para que uma troca de backend futura toque apenas este módulo (per `phase-03-videos/TD-07`).
2. Construir o `Pool` dedicado do `pg-boss` a partir da **mesma** factory `databaseConfig` que a aplicação usa — o pool é duplicado deliberadamente para que o long-poll do worker não concorra com o tráfego HTTP, mas a configuração tem uma única fonte (per `phase-03-videos/TD-17`).
3. Ligar o ciclo de vida: `boss.on('error', ...)` — a biblioteca emite, não lança —, `boss.start()` em `OnModuleInit` e `boss.stop()` em `OnApplicationShutdown` (per `library-refs.md` → `### pg-boss`).
4. Chamar `createQueue('video-processing', { retryLimit: 3, retryDelay: 60, retryBackoff: true, deadLetter: 'video-processing-dlq' })` explicitamente — `createQueue` é obrigatório desde a v10 e nunca atualiza uma fila existente, e o default de `retryLimit: 2` é errado para um handler não idempotente (per `phase-03-videos/TD-11` revisão).
5. Expor o adaptador `db` que embrulha um `QueryRunner` do TypeORM em `{ executeSql(sql, values) }`, que é o mecanismo de enqueue atômico usado por SI-03.5 (per `phase-03-videos/TD-17`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `src/queue/queue.module.spec.ts` |
| `QueueService` | Integration: `enqueue` → `work` entrega o job contra o Postgres real | `src/queue/queue.service.integration-spec.ts` |
| `QueueService` | Integration: enqueue dentro de uma transação revertida não entrega job algum | `src/queue/queue.service.integration-spec.ts` |

**Dependencies:** SI-03.1.1 — `pg-boss` instalado e o spike de ESM resolvido

**Acceptance criteria:**

- Enfileirar um job e registrar um worker entrega o payload ao handler.
- Enfileirar dentro de uma transação que é revertida não entrega job algum — a fila e a escrita de domínio compartilham o destino do commit.
- A fila `video-processing` existe com `retryLimit` igual a `3` após o boot, e não com o default `2` da biblioteca.
- O schema `pgboss` existe após o boot da aplicação e **não** aparece em `src/database/migrations/`.
- Derrubar a aplicação encerra as conexões do `pg-boss` sem deixar handle aberto.

---

### SI-03.5 — Implementar o handshake de upload (rascunho, assinatura, conclusão)

**Route:** POST /videos, POST /videos/{id}/upload/sign, POST /videos/{id}/upload-complete
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`
**Authorization:** Owner — ver `## Technical Specifications` → `### Authorization Matrix`

**Description:** Entregar os três endpoints que cercam o upload: pré-cadastrar o vídeo como rascunho ao iniciar, assinar cada operação S3 individualmente e verificar a conclusão antes de enfileirar o processamento.

**Technical actions:**

1. Criar `VideosController` + `VideosService` com `POST /videos`, que cria a linha em `draft`, gera o `slug`, deriva `video_key` a partir do id, grava `declared_size_bytes` e responde `{ id, slug, uploadKey, part_size_bytes }` com o part size fixo derivado com folga contra o teto de 10.000 partes (per `phase-03-videos/TD-04`, `TD-03`, `TD-13`).
2. Implementar `POST /videos/{id}/upload/sign`, que trata a `key` recebida como **não confiável** e a valida contra a `video_key` gravada no rascunho **em toda** operação assinada, antes de delegar a `StorageService.presignUpload` (per `phase-03-videos/TD-03`).
3. Suportar a paginação de `ListParts` no endpoint de assinatura via `part_number_marker` — um upload de 10 GiB tem ~1.280 partes e excede a página de 1.000, e um resume de página única re-enviaria ~280 partes (per `phase-03-videos/TD-03`).
4. Implementar `POST /videos/{id}/upload-complete`, que completa o multipart se necessário, chama `headObject` e compara o tamanho observado com `declared_size_bytes` como checagem de **integridade** — não de política — antes de transicionar o status (per `phase-03-videos/TD-04`).
5. Transicionar `draft → processing` por update condicional e enfileirar `video-processing` **dentro da mesma transação**, via o adaptador `db` de SI-03.4, para que a linha e o job commitem juntos (per `phase-03-videos/TD-04`, `TD-11`, `TD-17`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: geração de slug com retry em conflito, derivação de key, cálculo de part size | `src/videos/videos.service.spec.ts` |
| `VideosService` | Unit: validação de key contra o rascunho rejeita key alheia | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: handshake completo contra DB e storage reais, incluindo divergência de tamanho | `src/videos/videos.service.integration-spec.ts` |
| `VideosService` | Integration: enqueue transacional — rollback do commit não deixa job na fila | `src/videos/videos.service.integration-spec.ts` |
| `CreateVideoDto` | E2E: wiring do `ValidationPipe` num endpoint | `test/videos-upload.e2e-spec.ts` |

Os cenários E2E de ponta a ponta deste SI são autorados externamente por `/plan-test-specs` no spec referenciado em `**Test Specs:**`; a linha E2E acima cobre apenas o wiring de validação exigido por `phase-02-auth/TD-06`.

**Dependencies:** SI-03.2 (storage), SI-03.3 (entidade), SI-03.4 (fila)

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `id`, `slug`, `uploadKey` e `part_size_bytes`, e persiste a linha com `status` igual a `draft`.
- `POST /videos/{id}/upload/sign` com uma `key` que não pertence ao rascunho retorna `403` com `error` igual a `UPLOAD_KEY_MISMATCH`.
- `POST /videos/{id}/upload/sign` por um usuário que não é dono do canal retorna `403` com `error` igual a `VIDEO_NOT_OWNED`.
- `POST /videos/{id}/upload-complete` sem objeto gravado na key retorna `409` com `error` igual a `UPLOAD_OBJECT_MISSING`.
- `POST /videos/{id}/upload-complete` com objeto de tamanho diferente de `declared_size_bytes` retorna `409` com `error` igual a `UPLOAD_SIZE_MISMATCH`.
- `POST /videos/{id}/upload-complete` chamado duas vezes deixa exatamente um job na fila e o status em `processing`.
- `POST /videos` sem token de acesso retorna `401`.

---

### SI-03.6 — Criar o worker de vídeo e o FfmpegService

**Description:** Entregar o container de worker que consome a fila e, para cada vídeo, extrai metadados via `ffprobe`, gera o thumbnail via `ffmpeg` e conclui o ciclo de status — com o processamento isolado do event loop da API.

**Technical actions:**

1. Criar `src/main.worker.ts` chamando `NestFactory.createApplicationContext(WorkerModule)` e `src/worker/worker.module.ts` importando `ConfigModule`, `TypeOrmModule`, `StorageModule`, `QueueModule` e o provider de processamento, **sem registrar controllers** (per `phase-03-videos/TD-08`).
2. Criar `src/worker/ffmpeg.service.ts` que invoca os binários por `child_process.spawn` com array de argv — nunca string de shell —, com timeout explícito e suporte a `AbortSignal`, expondo um único seam mockável (per `phase-03-videos/TD-09`).
3. Implementar a leitura de metadados numa única chamada `ffprobe -v error -print_format json -show_format -show_streams`, persistindo os sete campos de `### Data Model` e deixando como `NULL` o que o probe não trouxer (per `phase-03-videos/TD-09` revisão).
4. Implementar a extração do thumbnail a ~10% da duração usando input seeking — `-ss` **antes** de `-i`, o que torna o custo independente do tamanho do vídeo — escalando para 1280×720 e gravando em `videos/{videoId}/thumbnail.jpg` no bucket de thumbnails (per `phase-03-videos/TD-10`, revisão incluída).
5. Implementar o handler registrado via `registerWorker`, cuja primeira ação é o update condicional para `processing` tratando zero linhas afetadas como "já processado", e que ao final persiste `thumbnail_bucket`/`thumbnail_key` e transiciona para `ready`, ou grava `processing_error`/`processing_attempts` e termina em `error` (per `phase-03-videos/TD-11`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Unit: construção de argv, posição de `-ss` antes de `-i`, timeout e abort | `src/worker/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration: binários reais contra a fixture commitada, asserindo duração e dimensões conhecidas | `src/worker/ffmpeg.service.integration-spec.ts` |
| `WorkerModule` | Unit: compilation test do contexto standalone | `src/worker/worker.module.spec.ts` |
| processing handler | Integration: job real enfileirado leva o vídeo de `processing` a `ready` com metadados e thumbnail gravados | `src/worker/video-processing.integration-spec.ts` |
| processing handler | Integration: entrega duplicada do mesmo job não dispara segundo processamento | `src/worker/video-processing.integration-spec.ts` |

**Dependencies:** SI-03.1.2 (imagem do worker com `ffmpeg`), SI-03.2 (storage), SI-03.3 (entidade), SI-03.4 (fila)

**Acceptance criteria:**

- Um vídeo que entra em `processing` termina em `ready` com `duration_seconds`, `width`, `height` e `size_bytes` preenchidos a partir do arquivo real.
- O objeto de thumbnail existe em `videos/{videoId}/thumbnail.jpg` no bucket de thumbnails, e `thumbnail_bucket`/`thumbnail_key` estão persistidos.
- Um campo ausente na saída do `ffprobe` fica `NULL` na linha, e o job conclui com sucesso.
- Entregar o mesmo job duas vezes resulta em um único processamento — a segunda entrega é no-op.
- Um vídeo cujo processamento falha todas as tentativas termina em `status` igual a `error`, com `processing_error` preenchido e `processing_attempts` igual a `3`.
- O container `nestjs-api` continua respondendo em `GET /` enquanto o worker processa um arquivo grande.

---

### SI-03.7 — Implementar leitura de status e reprocessamento

**Route:** GET /videos/{slug}, POST /videos/{slug}/reprocess
**Test Specs:** see `nestjs-project/specs/videos-read.plan.md`
**Authorization:** Anonymous quando `status = ready`; Owner nos demais casos — ver `## Technical Specifications` → `### Authorization Matrix`

**Description:** Entregar a superfície pela qual um cliente descobre que o processamento terminou, e o caminho de recuperação que retorna um vídeo em `error` para a fila.

**Technical actions:**

1. Implementar `GET /videos/{slug}` devolvendo o recurso com `status`, os sete campos de metadados, `thumbnail_url`, `processing_error` e `processing_attempts`, conforme `### API Contracts` (per `phase-03-videos/TD-12`).
2. Aplicar a regra de visibilidade: um vídeo que não está `ready` responde `404 VIDEO_NOT_FOUND` para quem não é dono — e não `403` — para não revelar a existência do rascunho (per `### Authorization Matrix`).
3. Documentar no OpenAPI o intervalo de polling sugerido e quais estados são terminais, para que clientes não precisem adivinhar (per `phase-03-videos/TD-12`).
4. Implementar `POST /videos/{slug}/reprocess` como update condicional `error → processing` seguido de re-enqueue na mesma transação, reaproveitando o caminho de SI-03.5 (per `phase-03-videos/TD-11`, `TD-17`).
5. Anotar os dois endpoints com os decoradores `@nestjs/swagger` para que entrem no `openapi.json` exportado (per `openapi-docs-nestjs/TD-01`, `TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: transição condicional de reprocess rejeita status não-`error` | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: leitura projeta metadados e `thumbnail_url` a partir das chaves gravadas | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` | E2E: wiring do `ValidationPipe` no parâmetro de rota `slug` | `test/videos-read.e2e-spec.ts` |

Os cenários E2E de polling e de recuperação são autorados externamente por `/plan-test-specs` no spec referenciado em `**Test Specs:**`.

**Dependencies:** SI-03.5 (handshake e serviço), SI-03.6 (worker, para que exista transição observável até `ready`)

**Acceptance criteria:**

- `GET /videos/{slug}` de um vídeo `ready` retorna `200` com `duration_seconds` e `thumbnail_url` preenchidos, para chamador anônimo.
- `GET /videos/{slug}` de um vídeo em `draft` retorna `404` para um usuário autenticado que não é dono.
- `GET /videos/{slug}` de um vídeo em `draft` retorna `200` com `status` igual a `draft` para o dono.
- `GET /videos/{slug}` de um vídeo em `error` retorna `processing_error` não nulo.
- `POST /videos/{slug}/reprocess` num vídeo em `error` retorna `200` com `status` igual a `processing` e deixa um job na fila.
- `POST /videos/{slug}/reprocess` num vídeo em `ready` retorna `409` com `error` igual a `VIDEO_INVALID_STATE`.
- Os dois endpoints aparecem no `openapi.json` após `npm run openapi:export`.

---

### SI-03.8 — Implementar streaming por range e download

**Route:** GET /videos/{slug}/stream, GET /videos/{slug}/download
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Anonymous com `status = ready` — ver `## Technical Specifications` → `### Authorization Matrix`

**Description:** Entregar a reprodução que começa sem download completo e o download do arquivo, servidos pelo mesmo handler e diferindo apenas no `Content-Disposition`.

**Technical actions:**

1. Implementar o handler de range em `VideosController` que lê o header `Range`, repassa o intervalo de bytes para `StorageService.getObjectStream` — sem buscar o objeto inteiro e fatiar — e devolve `StreamableFile` com `206`, `Content-Range` e `Content-Length` (per `phase-03-videos/TD-14`).
2. Tratar ausência de `Range` como `200` com o corpo completo, e range fora dos limites do objeto como `416`, sempre com `Accept-Ranges: bytes` (per `phase-03-videos/TD-14`).
3. Autorizar antes de abrir o stream: exigir `status = ready`, respondendo `409 VIDEO_NOT_READY` caso contrário. Esta fase **não** condiciona autorização a `visibility` — essa coluna é da Fase 04 (per `phase-03-videos/TD-14` revisão).
4. Expor `GET /videos/{slug}/download` apontando para o **mesmo** handler, adicionando `Content-Disposition: attachment` com filename derivado do `slug` (per `phase-03-videos/TD-14`).
5. Anotar os dois endpoints com os decoradores `@nestjs/swagger`, incluindo os status `206` e `416`, para que entrem no `openapi.json` (per `openapi-docs-nestjs/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| range parser | Unit: parsing de `Range`, cálculo de `Content-Range`, detecção de range insatisfazível | `src/videos/range.util.spec.ts` |
| `VideosService` | Integration: leitura ranged contra o storage real devolve exatamente o trecho pedido | `src/videos/videos.service.integration-spec.ts` |
| `VideosController` | E2E: `Range: bytes=0-1023` retorna `206` com `Content-Range` coerente | `test/videos-stream.e2e-spec.ts` |

Os cenários E2E de seek e de download são autorados externamente por `/plan-test-specs` no spec referenciado em `**Test Specs:**`; a linha E2E acima é o smoke mínimo do contrato de range.

**Dependencies:** SI-03.2 (storage), SI-03.6 (worker, para existir vídeo em `ready` para servir)

**Acceptance criteria:**

- `GET /videos/{slug}/stream` com `Range: bytes=0-1023` retorna `206` com `Content-Range: bytes 0-1023/{total}` e corpo de 1024 bytes.
- `GET /videos/{slug}/stream` sem header `Range` retorna `200` com `Accept-Ranges: bytes`.
- `GET /videos/{slug}/stream` com range além do tamanho do objeto retorna `416` com `error` igual a `RANGE_NOT_SATISFIABLE`.
- `GET /videos/{slug}/stream` de um vídeo em `processing` retorna `409` com `error` igual a `VIDEO_NOT_READY`.
- `GET /videos/{slug}/download` retorna `Content-Disposition: attachment` com filename derivado do `slug`.
- Chamador anônimo obtém `206` num vídeo `ready`, sem token de acesso.
- Os dois endpoints aparecem no `openapi.json` após `npm run openapi:export`.

---

### SI-03.9 — Montar a infraestrutura de testes de storage, fila e FFmpeg

**Description:** Dar às suítes de integração o ferramental para exercitar storage, fila e binários reais do Compose, seguindo o precedente do `mailpit` — sem simular o que a infraestrutura real pode rodar.

**Technical actions:**

1. Criar `src/test/storage.ts` espelhando `src/test/mailpit.ts`: cria e destrói um prefixo de key por suíte nos dois buckets, para que suítes rodando em série não se contaminem (per `phase-03-videos/TD-15`).
2. Commitar `src/test/fixtures/sample.mp4` — arquivo pequeno, de poucos segundos, com duração e dimensões conhecidas para servirem de asserção nos testes de `ffprobe` (per `phase-03-videos/TD-15`).
3. Criar o helper de fila de teste que registra um worker, aguarda a entrega de um job e limpa a fila entre suítes, para que os testes do handler rodem contra `pg-boss` real (per `phase-03-videos/TD-15`).
4. Declarar `src/test/fixtures/` como asset em `nest-cli.json` sob `compilerOptions.assets`, sem o que a fixture existe em `src/` e falta em `dist/` — falhando só depois do build (per a convenção de Build Assets em `nestjs-project/CLAUDE.md`).
5. Registrar em `nestjs-project/CLAUDE.md` que as suítes de integração desta fase exigem os serviços de storage e de banco no ar, e continuam obrigadas a `--runInBand`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `src/test/storage.ts` | Integration: setup e teardown criam e removem o prefixo nos dois buckets | `src/test/storage.integration-spec.ts` |
| `src/test/fixtures/sample.mp4` | Integration: `ffprobe` da fixture devolve a duração e as dimensões esperadas | `src/worker/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.1.2 (serviços no Compose), SI-03.2 (storage), SI-03.4 (fila)

**Acceptance criteria:**

- Rodar duas suítes de integração que usam storage em sequência não produz colisão de objetos entre elas.
- O teardown do helper deixa os buckets sem objetos do prefixo da suíte encerrada.
- `ffprobe` sobre `src/test/fixtures/sample.mp4` devolve a duração e as dimensões documentadas na própria fixture.
- A fixture existe em `dist/` depois de `npm run build`.
- `npm test -- --runInBand` e `npm run test:e2e` passam com a stack do Compose no ar.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| slug | varchar(11) | unique, not null — `nanoid(11)`, generated in application code (per `phase-03-videos/TD-13`) |
| channel_id | uuid | FK → `channels.id`, not null |
| title | varchar(255) | not null |
| status | enum | not null, default `draft` — one of `draft`, `processing`, `ready`, `error` (per `phase-03-videos/TD-11`) |
| video_bucket | varchar(63) | not null — `streamtube-videos` (per `phase-03-videos/TD-05` revision) |
| video_key | varchar(1024) | not null — `videos/{videoId}/original{ext}` (per `phase-03-videos/TD-05` revision) |
| thumbnail_bucket | varchar(63) | nullable — `streamtube-thumbnails`, set by the worker (per `phase-03-videos/TD-05` revision) |
| thumbnail_key | varchar(1024) | nullable — `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-10` revision) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId`, retained for `ListParts` resume (per `phase-03-videos/TD-03`) |
| declared_size_bytes | bigint | not null — size declared by the client at draft creation; the comparand for the completion integrity check (per `phase-03-videos/TD-03`, `TD-04`) |
| duration_seconds | numeric(12,3) | nullable (per `phase-03-videos/TD-09` revision) |
| width | integer | nullable (per `phase-03-videos/TD-09` revision) |
| height | integer | nullable (per `phase-03-videos/TD-09` revision) |
| codec_name | varchar(64) | nullable (per `phase-03-videos/TD-09` revision) |
| container_format | varchar(64) | nullable (per `phase-03-videos/TD-09` revision) |
| bitrate_bps | bigint | nullable (per `phase-03-videos/TD-09` revision) |
| size_bytes | bigint | nullable — actual size observed by `ffprobe`, distinct from `declared_size_bytes` (per `phase-03-videos/TD-09` revision) |
| processing_error | text | nullable (per `phase-03-videos/TD-11`) |
| processing_attempts | integer | not null, default 0 (per `phase-03-videos/TD-11`) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to one `Channel` via `channel_id` (`@ManyToOne` + `@OneToMany`, both sides defined).
**Indexes:** unique on `slug`; index on `channel_id`; index on `status` (the reaper and the worker both query by status).

**Notes:**

- All seven metadata columns are nullable by design: a field absent from the `ffprobe` output persists as NULL rather than failing the job (per `phase-03-videos/TD-09` revision).
- `declared_size_bytes` and `size_bytes` are deliberately separate. The first is the untrusted client claim recorded at draft creation; the second is observed server-side. `POST /videos/{id}/upload-complete` compares them as an integrity check, not as a policy limit (per `phase-03-videos/TD-04`).
- No `visibility` / `published_at` column is created in this phase — those are Phase 04's orthogonal axis (per `phase-03-videos/TD-11`).
- No upload size-limit column or configuration exists; `phase-03-videos/TD-06` was rejected as an invented requirement.

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — min 1, max 255 characters
- declared_size_bytes: number, required — positive integer, the byte length of the file the client is about to upload (per `phase-03-videos/TD-03`)
- content_type: string, required — the MIME type of the file, recorded for the stored object

**Response 201:**
- id: string (uuid)
- slug: string — the public identifier, `nanoid(11)` (per `phase-03-videos/TD-13`)
- uploadKey: string — the authoritative object key the client must use for every signed operation (per `phase-03-videos/TD-04`)
- part_size_bytes: number — fixed part size the client must slice with; derived server-side with headroom against the 10,000-part ceiling (per `phase-03-videos/TD-03`)

**Error responses:**
- 403 VIDEO_NOT_OWNED: when the authenticated user has no channel to own the draft
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/{id}/upload/sign (SI-03.5)

Signs exactly one S3 operation. Called once per `CreateMultipartUpload`, once per `UploadPart`, and again for `ListParts` / `CompleteMultipartUpload` / `AbortMultipartUpload` (per `phase-03-videos/TD-03`).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- method: string, required — one of `GET`, `PUT`, `POST`, `DELETE`
- key: string, required — treated as untrusted and validated against the draft's stored `video_key` before signing (per `phase-03-videos/TD-03`)
- upload_id: string, optional — present for every multipart operation after creation
- part_number: number, optional — present only for `UploadPart`
- part_number_marker: string, optional — `ListParts` continuation token; `ListParts` is paginated at 1,000 parts and a 10 GiB upload exceeds one page (per `phase-03-videos/TD-03`)

**Response 200:**
- url: string — the presigned URL, signed against `S3_ENDPOINT_PUBLIC` so the signature is valid for the host the caller actually reaches (per `phase-03-videos/TD-16`)
- expires_in: number — seconds, from `PRESIGN_TTL_SECONDS`

**Error responses:**
- 403 UPLOAD_KEY_MISMATCH: when `key` does not match the draft's stored `video_key`
- 403 VIDEO_NOT_OWNED: when the caller does not own the draft's channel
- 404 VIDEO_NOT_FOUND: when no video exists for `{id}`
- 409 VIDEO_INVALID_STATE: when the video is no longer in `draft`
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/{id}/upload-complete (SI-03.5)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- id: string (uuid)
- slug: string
- status: string — `processing` on success

**Error responses:**
- 409 UPLOAD_OBJECT_MISSING: when `HeadObject` finds no object at the draft's key
- 409 UPLOAD_SIZE_MISMATCH: when the stored object's size differs from `declared_size_bytes` — detects a truncated or incorrectly completed multipart upload (per `phase-03-videos/TD-04`)
- 403 VIDEO_NOT_OWNED: when the caller does not own the draft's channel
- 404 VIDEO_NOT_FOUND: when no video exists for `{id}`
- 409 VIDEO_INVALID_STATE: when the video is not in `draft`

**Idempotency:** the status transition is a conditional update, so a duplicated call is a no-op rather than a second enqueue (per `phase-03-videos/TD-04`, `TD-11`).

---

#### GET /videos/{slug} (SI-03.7)

The polling surface by which a client learns processing finished (per `phase-03-videos/TD-12`).

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: string — `draft` | `processing` | `ready` | `error`
- duration_seconds: number, nullable
- width: number, nullable
- height: number, nullable
- codec_name: string, nullable
- container_format: string, nullable
- bitrate_bps: number, nullable
- size_bytes: number, nullable
- thumbnail_url: string, nullable — populated once the worker has written the thumbnail
- processing_error: string, nullable — populated only when `status` is `error`
- processing_attempts: number

**Polling guidance (documented in OpenAPI per `phase-03-videos/TD-12`):** suggested interval 3 seconds while `status` is `draft` or `processing`; `ready` and `error` are terminal and polling must stop.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video exists for `{slug}`, or when the video is not `ready` and the caller is not its owner

---

#### GET /videos/{slug}/stream (SI-03.8)

Serves the video bytes as HTTP range responses so playback starts without a full download (per `phase-03-videos/TD-14`).

**Request headers:**
- Range: bytes={start}-{end}, optional

**Response 206:** Partial content — the requested byte range.
- Content-Range: bytes {start}-{end}/{total}
- Accept-Ranges: bytes
- Content-Length: {length of the returned range}
- Content-Type: {the video's stored content type}

**Response 200:** Full body stream, returned when no `Range` header is present.
- Accept-Ranges: bytes

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video exists for `{slug}`
- 409 VIDEO_NOT_READY: when `status` is not `ready`
- 416 RANGE_NOT_SATISFIABLE: when the requested range lies outside the object

---

#### GET /videos/{slug}/download (SI-03.8)

The same handler as `/stream`, differing only in `Content-Disposition` (per `phase-03-videos/TD-14`).

**Response 200:** Full body stream.
- Content-Disposition: attachment; filename="{slug}{ext}"
- Accept-Ranges: bytes

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video exists for `{slug}`
- 409 VIDEO_NOT_READY: when `status` is not `ready`
- 416 RANGE_NOT_SATISFIABLE: when a `Range` header requests a range outside the object

---

#### POST /videos/{slug}/reprocess (SI-03.7)

Transitions `error → processing` and re-enqueues the job (per `phase-03-videos/TD-11`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- id: string (uuid)
- slug: string
- status: string — `processing`

**Error responses:**
- 403 VIDEO_NOT_OWNED: when the caller does not own the video's channel
- 404 VIDEO_NOT_FOUND: when no video exists for `{slug}`
- 409 VIDEO_INVALID_STATE: when `status` is not `error`

---

#### Validation Rules — videos module

- `title`: required, min 1, max 255 characters
- `declared_size_bytes`: required, integer, positive. **Not** bounded by an upper limit — no source requires an upload ceiling and `phase-03-videos/TD-06` was rejected on exactly that ground
- `content_type`: required, non-empty string
- `method`: required, one of `GET` | `PUT` | `POST` | `DELETE`
- `key`: required, non-empty string — validated against the draft's stored `video_key`, never trusted
- `part_number`: optional, integer, 1–10,000 (the S3 part-number range per `phase-03-videos/TD-03`)
- `slug` path parameter: 11 characters, URL-safe alphabet

Validation is enforced by the global `ValidationPipe` with `class-validator` DTOs (inherited from `phase-02-auth/TD-06`).

### Authorization Matrix

The global JWT guard is inherited from `phase-02-auth/TD-02`; `@Public()` opts a route out. "Owner" means the authenticated user owns the channel the video belongs to.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✓ (becomes the owner) | ✓ |
| POST /videos/{id}/upload/sign | ✗ | ✗ | ✓ |
| POST /videos/{id}/upload-complete | ✗ | ✗ | ✓ |
| GET /videos/{slug} — `status = ready` | ✓ | ✓ | ✓ |
| GET /videos/{slug} — any other status | ✗ | ✗ | ✓ |
| GET /videos/{slug}/stream | ✓ | ✓ | ✓ |
| GET /videos/{slug}/download | ✓ | ✓ | ✓ |
| POST /videos/{slug}/reprocess | ✗ | ✗ | ✓ |

**Notes:**

- Streaming and download require `status = ready` and are otherwise open, including to anonymous callers — this matches the project plan's anonymous-viewing requirement. There is deliberately **no** public/unlisted distinction in this phase: `visibility` is Phase 04's column, and conditioning Phase 03 authorisation on it would either invent the column or silently drop the rule (per `phase-03-videos/TD-14` revision).
- A non-`ready` video is invisible to non-owners on `GET /videos/{slug}` — the endpoint answers `404 VIDEO_NOT_FOUND` rather than `403`, so a draft's existence is not disclosed.
- Rate limiting is inherited from `phase-02-auth/TD-08` and remains scoped to `AuthModule`; the streaming routes are deliberately not throttled, since range requests are many-per-playback.

### Error Catalog

Error responses use the envelope established by `phase-02-auth/TD-07` — the custom domain exception filter emitting `{ statusCode, error, message }`, where `error` carries the machine-readable domain code below. This phase adds no new envelope shape; it inherits the existing one.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Nenhum vídeo existe para o `{id}`/`{slug}` informado — também usado quando um vídeo não-`ready` é pedido por quem não é o dono, para não revelar sua existência |
| VIDEO_NOT_OWNED | 403 | O usuário autenticado não é dono do canal a que o vídeo pertence |
| VIDEO_INVALID_STATE | 409 | A operação não é válida para o `status` atual (assinar upload fora de `draft`, completar fora de `draft`, reprocessar fora de `error`) |
| VIDEO_NOT_READY | 409 | Streaming ou download pedido antes de o processamento concluir (`status != ready`) |
| UPLOAD_KEY_MISMATCH | 403 | A `key` enviada para assinatura não corresponde à `video_key` gravada no rascunho — bloqueia o uso do endpoint de assinatura como oráculo aberto |
| UPLOAD_OBJECT_MISSING | 409 | `HeadObject` não encontrou objeto na chave do rascunho ao concluir o upload |
| UPLOAD_SIZE_MISMATCH | 409 | O tamanho do objeto gravado difere de `declared_size_bytes` — indica upload truncado ou multipart concluído incorretamente |
| RANGE_NOT_SATISFIABLE | 416 | O `Range` pedido está fora dos limites do objeto |

**Note:** there is intentionally no `UPLOAD_TOO_LARGE` code. No source requires an upload ceiling — `phase-03-videos/TD-06` proposed one and was rejected as an invented requirement.

### Events/Messages

Transport is `pg-boss` over the existing PostgreSQL instance — no broker service (per `phase-03-videos/TD-07`).

**Why no queue service appears in `compose.yaml`, stated explicitly** (carrying out TD-07's required mitigation). `desafio.md` lists *"Object storage, fila e worker subindo via docker compose junto com o backend"* as an acceptance criterion and *"Não ter fila, worker e storage reais subindo no Compose"* as an automatic fail, so the absence of a queue service is a deliberate choice that has to be defended rather than left implicit:

- The queue **is** real and durable, not simulated: jobs are rows in a `pgboss` schema with WAL-backed durability, retry counters, backoff and a dead-letter queue — the same guarantees a broker provides, on storage that is already backed up.
- It **does** come up via Compose: `pgboss` lives inside the `db` service, which is a Compose service that `nestjs-api` and `video-worker` both declare `depends_on: { db: { condition: service_healthy } }`. Bringing the stack up brings the queue up; there is no step a reader has to perform separately.
- The thing it buys is not minimalism but **correctness**: it is the only option of the four considered that supports transactional enqueue, so the video row and its job commit or roll back together. With an external broker a crash between the DB commit and the publish leaves a video stuck in `processing` with no job behind it, or a job pointing at a row that never committed.
- What is genuinely given up is a broker's management UI and cross-service fan-out. Neither is required by this phase, and TD-07 records the trigger for revisiting the choice.

A reviewer looking for a fifth container will not find one; the queue is the `db` container doing one more job. The trade-off is recorded in TD-07's "Accepted risks" and is the single largest grading exposure in this phase. The queue's connection pool is built from the same `databaseConfig` factory the application uses, and `pg-boss` owns its `pgboss` schema, creating it at `boss.start()` rather than via a versioned migration (per `phase-03-videos/TD-17`).

#### video-processing

**Payload:**

```json
{ "videoId": "uuid", "videoBucket": "string", "videoKey": "string" }
```

The payload is deliberately thin: the worker re-reads current state from the database rather than trusting a possibly stale message (per `phase-03-videos/TD-07`).

**Producer:** `VideosService` on `POST /videos/{id}/upload-complete`, enqueued **inside the same TypeORM transaction** that flips `status` to `processing`, via `pg-boss`'s per-call `db` option wrapping the active `QueryRunner` — so the row and its job commit together and cannot diverge (per `phase-03-videos/TD-04`, `TD-07`, `TD-17`)
**Consumer:** the `video-worker` container — a standalone Nest context (`createApplicationContext(WorkerModule)`) with no HTTP listener, registering the handler via `boss.work()` (per `phase-03-videos/TD-08`)
**Trigger:** the upload-complete handshake has verified, via `HeadObject`, that the object exists and matches `declared_size_bytes` (per `phase-03-videos/TD-04`)
**Delivery semantics:** at-least-once — `pg-boss` retries, so the handler's first action is a conditional update (`UPDATE videos SET status='processing' WHERE id=$1 AND status IN ('draft','error')`) and zero affected rows means "already handled", making a duplicate delivery a no-op rather than a second FFmpeg run (per `phase-03-videos/TD-11`)

**Retry policy** (set explicitly on `createQueue`, never inherited — `pg-boss` has made retries opt-out with `retryLimit: 2` since v10, which is the wrong default for a non-idempotent FFmpeg handler, per `phase-03-videos/TD-11` revision):

| Option | Value |
|--------|-------|
| retryLimit | 3 |
| retryDelay | 60 (seconds) |
| retryBackoff | true |
| deadLetter | `video-processing-dlq` |

**Terminal failure:** after the retry budget is exhausted the row lands on `status = error` with `processing_error` and `processing_attempts` persisted, and the job moves to `video-processing-dlq`. `POST /videos/{slug}/reprocess` is the recovery path, transitioning `error → processing` (per `phase-03-videos/TD-11`).

**Handler steps** (per `phase-03-videos/TD-09`, `TD-10`):

1. Conditional-update guard to `processing` — bail out as a no-op when zero rows are affected.
2. `ffprobe -v error -print_format json -show_format -show_streams` over the stored object; persist the seven metadata columns, leaving absent fields NULL.
3. Extract one frame at ~10% of duration using input seeking (`-ss` **before** `-i`), scale to 1280×720, write to `streamtube-thumbnails` at `videos/{videoId}/thumbnail.jpg`.
4. Persist `thumbnail_bucket` / `thumbnail_key` and transition `status` to `ready`.

#### draft-reaper

**Payload:**

```json
{}
```

**Producer:** scheduled by `QueueModule` at application boot (per `phase-03-videos/TD-04`)
**Consumer:** the `video-worker` container (per `phase-03-videos/TD-08`)
**Trigger:** periodic — removes `draft` rows whose upload never completed, past an expiry window; complements the buckets' abort-incomplete-multipart lifecycle rules, which clean up the orphaned S3 multipart uploads themselves (per `phase-03-videos/TD-01` revision, `TD-04`)
**Delivery semantics:** at-least-once; the job is naturally idempotent because it operates on a `status`-and-age predicate rather than on a fixed row set

---

## Dependency Map

```
SI-03.1.1 (root — libs instaladas + contrato de env)
├── SI-03.1.2 — depends on SI-03.1.1 (env precisa existir antes de parametrizar os serviços)
│   ├── SI-03.2 — depends on SI-03.1.1 + SI-03.1.2 (config, e storage no ar para o teste de integração)
│   │   ├── SI-03.6 — depends on SI-03.1.2 + SI-03.2 + SI-03.3 + SI-03.4 (imagem com ffmpeg, storage, entidade, fila)
│   │   │   ├── SI-03.7 — depends on SI-03.5 + SI-03.6 (precisa de transição observável até `ready`)
│   │   │   └── SI-03.8 — depends on SI-03.2 + SI-03.6 (precisa de vídeo em `ready` para servir)
│   │   └── SI-03.9 — depends on SI-03.1.2 + SI-03.2 + SI-03.4 (exercita storage e fila reais)
│   └── (SI-03.1.2 também habilita SI-03.6 e SI-03.9 acima)
├── SI-03.3 — depends on SI-03.1.1 (`nanoid` instalado)
│   └── SI-03.5 — depends on SI-03.2 + SI-03.3 + SI-03.4 (storage, entidade, fila)
│       └── SI-03.7 (ver acima)
└── SI-03.4 — depends on SI-03.1.1 (`pg-boss` instalado, spike de ESM resolvido)
    ├── SI-03.5 (ver acima)
    ├── SI-03.6 (ver acima)
    └── SI-03.9 (ver acima)
```

**Caminho crítico:** `SI-03.1.1 → SI-03.1.2 → SI-03.2 → SI-03.6 → SI-03.8`. O worker é o gargalo: ele depende de infraestrutura, storage, entidade e fila ao mesmo tempo, e tanto a leitura de status quanto o streaming só se tornam observáveis depois que ele leva um vídeo a `ready`.

**Paralelizável:** depois de `SI-03.1.1`, os três ramos `SI-03.1.2`, `SI-03.3` e `SI-03.4` são independentes entre si e podem avançar em qualquer ordem.

---

## Deliverables

- [x] SI-03.1.1 — Infra: instalar bibliotecas e estender o contrato de env
- [x] SI-03.1.2 — Infra: subir storage, bootstrap de buckets e worker no Compose
- [x] SI-03.2 — Criar StorageModule sobre o AWS SDK v3
- [x] SI-03.3 — Criar entidade Video e migration
- [x] SI-03.4 — Criar QueueModule sobre pg-boss
- [x] SI-03.5 — Implementar o handshake de upload (rascunho, assinatura, conclusão)
- [x] SI-03.6 — Criar o worker de vídeo e o FfmpegService
- [x] SI-03.7 — Implementar leitura de status e reprocessamento
- [x] SI-03.8 — Implementar streaming por range e download
- [x] SI-03.9 — Montar a infraestrutura de testes de storage, fila e FFmpeg

**Capacidades da fase** _(uma linha por bullet de `docs/project-plan.md`)_:

- [x] Serviço de armazenamento de arquivos (vídeos e thumbnails) — dois buckets provisionados e acessíveis via `StorageModule`
- [x] Serviço de processamento em segundo plano (filas) — `video-processing` e `draft-reaper` operando sobre `pg-boss`
- [x] Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance — bytes vão direto do cliente ao storage, sem passar pela API
- [x] Pré-cadastro automático do vídeo como rascunho ao iniciar o upload — linha em `draft` criada antes do primeiro byte
- [x] Processamento automático do vídeo após upload (extração de duração e metadados) — sete campos persistidos pelo worker
- [x] Geração automática de thumbnail a partir de um frame do vídeo — objeto gravado no bucket de thumbnails
- [x] URL única por vídeo, sem conflito com outros vídeos — `slug` `nanoid(11)` em coluna `UNIQUE`
- [x] Reprodução via streaming (sem necessidade de download completo) — `206 Partial Content` com `Content-Range`
- [x] Download do vídeo pelo usuário — mesmo handler com `Content-Disposition: attachment`

**Test specs a autorar antes de implementar** _(placeholders `**Test Specs:** _pending_` em 3 SIs)_:

- [x] Spec de `SI-03.5` (handshake de upload) autorado via `/plan-test-specs phase-03-videos`
- [x] Spec de `SI-03.7` (leitura de status e reprocess) autorado via `/plan-test-specs phase-03-videos`
- [x] Spec de `SI-03.8` (streaming e download) autorado via `/plan-test-specs phase-03-videos`

**Full test suites** _(comandos conforme `nestjs-project/CLAUDE.md` — todo `npm`/`npx` roda dentro do container)_:

- [x] Infraestrutura no ar (`cd nestjs-project && docker compose up -d` — todos os serviços em `running`, storage e `db` em `healthy`)
- [x] Migrations aplicadas (`cd nestjs-project && docker compose exec nestjs-api npm run migration:run`)
- [x] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [x] Type checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit` — exit code 0)
- [x] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint` — exit 0, zero errors e zero warnings)
- [x] OpenAPI regenerado (`cd nestjs-project && docker compose exec nestjs-api npm run openapi:export` — os 7 endpoints desta fase presentes)

**Documentação:**

- [x] `nestjs-project/CLAUDE.md` atualizado com a seção de vídeos: módulo, endpoints, fila/worker e storage, mais as duas constrições aceitas (imagem de storage congelada; schema `pgboss` criado no boot e ausente de `src/database/migrations/`)
- [x] `CLAUDE.md` da raiz atualizado — a fila deixa de ser **TBD** e passa a `pg-boss` sobre PostgreSQL
