---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-01T11:29:11+0000"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-01T15:06:04+0000"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-01T11:29:11+0000"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-01T11:29:11+0000"
  docs/phases/phase-02-auth/context.md: "2026-11-01T11:29:11+0000"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-01T11:29:11+0000"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-01T11:29:11+0000"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-01T17:45:47+0000"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** "Este é um desafio de backend: a entrega é a API, o worker, a infraestrutura e os artefatos do processo. (Há um frontend no repositório, mas a interface de vídeo não faz parte do escopo desta fase.)" (per repo-root `desafio.md`)

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project` — backend-only scope per `desafio.md`: "a entrega é a API, o worker, a infraestrutura e os artefatos do processo."

**Deferred subprojects:** `next-frontend` — "Um frontend Next.js em next-frontend/ (Fases 01–02), fora do escopo desta fase." (video interface out of scope for this phase per `desafio.md`)

**Sequencing notes:** "Depende de: Fase 01, Fase 02"

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Repo-wide | MinIO Image Sourcing and Bucket Provisioning | decided | A | — |
| | | | └─ Last revision: 2026-11-01 — sidecar creates **two** buckets, each with its own abort-incomplete-multipart rule (follows TD-05=B) | | | |
| phase-03-videos/TD-02 | phase | Backend | S3 Access Library and Presigning Surface | decided | A | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | phase | Backend | Upload Strategy for 10GB Files | decided | A | — |
| phase-03-videos/TD-04 | phase | Backend | Upload Session Handshake — Draft Pre-Registration and Completion Signal | decided | A | — |
| phase-03-videos/TD-05 | phase | Backend | Bucket Topology and Object Key Convention | decided | B | — |
| | | | └─ Last revision: 2026-11-01 — operative convention under B stated explicitly (two buckets, both keys on the row) | | | |
| phase-03-videos/TD-06 | phase | Backend | Enforcement Point for the 10GB Limit | rejected | None (rejected — invented requirement, retained for history) | — |
| phase-03-videos/TD-07 | phase | Repo-wide | Background Job Queue Technology | decided | C (pg-boss 12) | pg-boss |
| phase-03-videos/TD-08 | phase | Repo-wide | Worker Deployment Topology | decided | B | — |
| phase-03-videos/TD-09 | phase | Backend | FFmpeg / FFprobe Invocation Strategy | decided | A | — |
| | | | └─ Last revision: 2026-11-01 — persisted metadata set fixed (7 fields, NULL-tolerant) | | | |
| phase-03-videos/TD-10 | phase | Backend | Thumbnail Frame Selection and Derivative Set | decided | A | — |
| | | | └─ Last revision: 2026-11-01 — thumbnail key lives in the thumbnails bucket (follows TD-05=B) | | | |
| phase-03-videos/TD-11 | phase | Backend | Video Status Cycle, Failure Handling and Worker Idempotency | decided | A | — |
| | | | └─ Last revision: 2026-11-01 — retry policy fixed: retryLimit 3, retryDelay 60s, retryBackoff true | | | |
| phase-03-videos/TD-12 | phase | Backend | How Clients Learn That Processing Finished | decided | A | — |
| phase-03-videos/TD-13 | phase | Backend | Unique Public Video URL | decided | A | nanoid |
| phase-03-videos/TD-14 | phase | Backend | Media Delivery — Streaming Playback and Download | decided | A | — |
| | | | └─ Last revision: 2026-11-01 — Phase 03 authz narrowed to `status = ready`; visibility arrives with Phase 04 | | | |
| phase-03-videos/TD-15 | phase | Backend | Test Strategy for Storage, Queue and FFmpeg | decided | A | — |
| phase-03-videos/TD-16 | phase | Repo-wide | Compose Topology and the Storage Endpoint Contract | decided | A | — |
| | | | └─ Last revision: 2026-11-01 — `UPLOAD_MAX_BYTES` dropped; `S3_BUCKET` split in two; queue adds no env keys | | | |
| phase-03-videos/TD-17 | phase | Backend | pg-boss Database Connection and Schema Ownership | decided | B | pg-boss, pg |

**Notes on the index:**

- `Renders in` column omitted — no TD in scope sets `**Renders in:**` (`next-frontend` is explicitly out of scope, so there are no `Frontend` / `Cross-layer` TDs).
- Four TDs carry `**Libraries:**` — TD-02, TD-07, TD-13 and TD-17. The remaining TDs introduce no new npm dependency; the non-npm pins (the `bitnamilegacy/minio` image tag, the `mc` bootstrap image, and the `ffmpeg` version the worker stage installs) are recorded in `library-refs.md` prose rather than in this field.
- Seven TDs carry a `**Revisions:**` block — TD-01, TD-05, TD-09, TD-10, TD-11, TD-14 and TD-16. Each revision is the operative correction for that TD; where a revision and the original Recommendation prose disagree, **the revision governs**. The `└─` rows above summarise the latest entry; full text is in `## Decisions Detail`.
- **17 TDs total: 16 decided, 1 rejected, 0 pending.**
- **TD-06 is `rejected`, not `pending` and not `decided`.** It carries `<!-- status: rejected — invented requirement, no source. Retained for history. Do not implement. -->` immediately after its heading plus a visible "⛔ REJECTED — DO NOT IMPLEMENT" banner. It is **deliberately excluded from `## Decisions Detail` below** so its void recommendation cannot reach `plan-build`. It must not produce a Step Implementation, a Technical Specification entry, or an env key.

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

_No ad-hoc decisions doc has `3 ∈ related_phases` (all four ad-hoc docs declare `related_phases: []`), so `S_adhoc ∩ S_3 = ∅` and the phase-scope doc is the sole owned source._

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01, TD-02, TD-05, TD-15, TD-16 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-07, TD-08, TD-15, TD-16, TD-17 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03, TD-16 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04, TD-11 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, TD-08, TD-09, TD-11, TD-12, TD-15 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, TD-08, TD-09, TD-10, TD-15 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-13 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-14 |
| Download do vídeo pelo usuário | phase-03-videos/TD-14 |

_All 9 capabilities are covered by at least one decided TD. The rejected TD-06 also cited the 10GB capability; it is excluded from this table, which is why that row lists only TD-03 and TD-16._

## Decisions Detail

_(current-phase TDs only — 16 decided TDs; TD-06 excluded as rejected. Where a `**Revisions:**` entry and the original `**Recommendation:**` prose disagree, **the revision governs** — it is the operative correction.)_

### phase-03-videos/TD-01

**Recommendation:** **`bitnamilegacy/minio:2025.7.23` + a one-shot `mc` bootstrap sidecar**. Reproducibility is the deciding property here: this is a graded deliverable whose test suite must pass on someone else's machine, and Option A is the only verified-pullable option with real version tags to pin. The frozen-patches downside is immaterial for a local-only dev dependency that is replaced by managed S3 in production — and it should be written into `nestjs-project/CLAUDE.md` as a known, accepted constraint rather than left implicit. Option B is the better choice on security but trades away pinning and shell access, both of which this project's workflow actively relies on; revisit it if MinIO ever moves back into the hot path. Option C is disproportionate. Option D's bucket-creating application credentials are a privilege shape production would reject, so the sidecar keeps dev and prod honest. Note for `implement`: MinIO requires `forcePathStyle: true` on the S3 client (TD-02), exposes the console on `:9001` alongside the S3 API on `:9000`, and the sidecar is also where the aborted-multipart lifecycle rule from TD-04 belongs.
**Libraries:** —

**Revisions:**
- 2026-11-01 — Bootstrap sidecar creates **two** buckets (`streamtube-videos`, `streamtube-thumbnails`), each with its own abort-incomplete-multipart lifecycle rule, following TD-05's decision of Option B. Rationale: resolves IC-2 of `validation.md` — the recommendation above says "create the bucket" in the singular, assuming TD-05 Option A.

### phase-03-videos/TD-02

**Recommendation:** **`@aws-sdk/client-s3` v3 + `s3-request-presigner`**, behind a project-owned `StorageModule` exposing a narrow interface (`presignUpload`, `presignDownload`, `headObject`, `getObjectStream`, `putObject`) so no other module imports `@aws-sdk/*` directly. The decisive point is direction of travel: dev runs MinIO but production runs S3, so the client should be the S3 client configured to talk to MinIO — not a MinIO client hoped to work against S3. It is also the only option with first-class multipart presigning, which TD-03 depends on, and the only one not maintained by a vendor that just archived its OSS edition. Options B and C invert the dev/prod relationship and take on the archival risk in the application layer, buying a convenience API that the `StorageModule` wrapper provides anyway. Pin the version in `library-refs.md`, and set `endpoint`, `forcePathStyle: true` and `region` from namespaced config so the same build works against both backends.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-videos/TD-03

**Recommendation:** **presigned S3 multipart, client direct to storage**. It is the strategy `desafio.md` names, and the only one that removes the 10GB from the Node process entirely rather than arguing that streaming it through is good enough — which matters when passing the file through the API is an explicit automatic failure. It also satisfies resumability through `ListParts` without any new dependency, and it reuses the presigning surface TD-02 already establishes. Option B is the better *protocol* and would be the pick if the requirement were only "don't block"; it loses on the stricter reading of the auto-fail criterion and on putting 10GB of I/O through the API container. Option C is eliminated by the 5GiB single-`PUT` ceiling before resumability is even considered. Option D combines B's byte path with A's coordination cost and tus's absent guarantees. **S3 multipart limits that constrain this design** (verified against the AWS docs): max 10,000 parts per upload, part size 5 MiB–5 GiB with no minimum on the last part, and `ListParts` paginated at 1,000 per request. Four consequences: derive a fixed part size with headroom (8 MiB → 1,280 parts for 10 GiB); **paginate `ListParts`**, since 1,280 parts exceeds one page and a single-page resume would re-upload ~280 parts; carry the client-declared size on the draft so part count is known up front and TD-04's integrity check has a comparand; and validate that the requested key belongs to the caller's draft on **every** signed operation.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** **draft-first, client-reported completion verified by `HeadObject`**. It is the only option that satisfies "pré-cadastro … ao iniciar o upload" while keeping the completion signal trustworthy and the dev/prod story identical. `HeadObject` is the whole point: it costs one call and makes the client's report unforgeable, which is the entire security content of Option B without binding the design to MinIO-specific notification config. The check is **integrity, not policy**: the object exists, is non-empty, and its size matches the size the client declared at draft creation — which detects a truncated or incorrectly completed multipart upload. Pair it with two cheap cleanup mechanisms — the bucket lifecycle rule aborting incomplete multipart uploads, and a scheduled queue job deleting pre-upload drafts past expiry. Option B is worth revisiting in production on real S3, as an additional signal rather than a replacement. Option C is ruled out by the capability text. The transition itself should be a conditional update rather than a read-then-write, so a duplicated completion call is idempotent (see TD-11).
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** **single bucket, `videos/{videoId}/…`**, with both keys persisted on the `videos` row as `desafio.md` requires, and `StorageModule` owning the single function that builds them. It gives uniqueness with no coordination, keeps delete and inspection trivial, and decouples storage layout from the public slug so the two can never drift. Option B is the correct eventual shape and should be revisited when thumbnails go behind a CDN — plausibly Phase 07's production work — but splitting now doubles the provisioning and config surface for a benefit this phase has no consumer for. Option C solves a problem that no longer exists. Create the bucket in the TD-01 bootstrap sidecar, and attach the aborted-multipart lifecycle rule there too.
**Libraries:** —

**Revisions:**
- 2026-11-01 — Decision is Option B (separate buckets per asset class); the Recommendation above argues for Option A and is retained as the record of the original analysis. **Operative convention under B:** bucket `streamtube-videos` holds `videos/{videoId}/original{ext}`; bucket `streamtube-thumbnails` holds `videos/{videoId}/thumbnail.jpg`. Both bucket names and both object keys persist on the `videos` row. Rationale: resolves IC-1 of `validation.md` — `plan-build` drafts Technical actions from Recommendation prose, so where the decision diverges from that prose the operative convention must be stated explicitly.

### phase-03-videos/TD-07

**Recommendation:** **`pg-boss` 12**. Two things decide it. First, it is the only option that gives a Postgres-only stack *today*: Option B is architecturally the same choice but is blocked on an unreleased `@nestjs/bullmq` feature, and the workaround sacrifices the decorator API that justified the wrapper. Second, transactional enqueue is a genuine correctness gain that TD-04 would use directly — the draft row and its job commit together, so they cannot diverge — and neither BullMQ backend offers it. The cost is a ~60-line `QueueModule`, which is cheaper than adding a stateful service (Option A) or betting the schedule on an upstream release (Option B). If familiarity and the `@Processor` developer experience outweigh infrastructure minimalism, Option A is defensible — but it should be chosen knowingly as "we are adding Redis", with the lost-job window handled explicitly. Revisit Option B once `@nestjs/bullmq` ships the merged backend support. Whichever is chosen, the job payload must be specified for the plan's Events/Messages section: at minimum `videoId` and the object key, kept deliberately thin so the worker re-reads current state from the database rather than trusting a possibly stale message.
**Libraries:** pg-boss

### phase-03-videos/TD-08

**Recommendation:** **separate container, same codebase, `createApplicationContext(WorkerModule)`**. It is the only option that both matches the documented architecture and keeps one source of truth for entities, config and storage access. The CPU-isolation argument is decisive on its own: under Option A a single 10GB upload makes the whole API slow, which the plan explicitly prohibits, and it leaves nothing to point at for the "worker real subindo no Compose" criterion. Option C's extra isolation is paid for in duplicated entities and a premature monorepo decision. Concretely: `WorkerModule` imports `ConfigModule`, `TypeOrmModule`, `StorageModule`, `QueueModule` and the video-processing provider but registers no controllers; `Dockerfile.dev` gains a worker stage that installs `ffmpeg`; `compose.yaml` gains a `video-worker` service depending on `db` (healthy) and on the MinIO service.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** **direct `spawn` behind a project-owned `FfmpegService`**. This phase needs two FFmpeg operations — one `ffprobe` metadata read and one single-frame extract — which is far too little to justify taking on dependency risk, and upstream `fluent-ffmpeg`'s archival plus the youth of its forks makes that risk concrete rather than theoretical. Direct invocation also keeps the performance-critical detail visible instead of hidden: `-ss` before `-i` is the difference between a fast and a slow thumbnail, and the wrapper options obscure where it goes. Install via `apt install ffmpeg` in the worker stage only (TD-08), and confine all spawning to one injectable service with an explicit timeout, `AbortSignal` support and argv arrays — giving unit tests a single seam to mock and integration tests the real binaries against a committed fixture (TD-15). Pin nothing new in `library-refs.md` for this TD beyond the FFmpeg version the image installs, which should be recorded.
**Libraries:** —

**Revisions:**
- 2026-11-01 — Persisted metadata set fixed to `duration_seconds` (required by the capability), `width`, `height`, `codec_name`, `container_format`, `bitrate_bps`, `size_bytes`. All read from a single `ffprobe -v error -print_format json -show_format -show_streams` invocation; any field absent from the probe output persists as NULL rather than failing the job. Rationale: resolves AMB-1 of `validation.md` — "duração e metadados" enumerated nothing, leaving the Data Model underspecified.

### phase-03-videos/TD-10

**Recommendation:** **single frame at ~10% of duration, one 1280×720 rendition** at `videos/{videoId}/thumbnail.jpg`, exposed as a single nullable URL field. The automatic thumbnail is a placeholder that Phase 04 lets users replace, so Option B optimises the wrong thing — and its extra decodes are the last thing a worker chewing through 10GB files needs. Option C is genuinely useful but should wait until real layouts define the breakpoints, which is also when a backfill is cheapest since the catalogue is still small; guessing sizes now would be exactly the invented requirement `desafio.md` warns against. Use input seeking (`-ss` before `-i`, per TD-09) so extraction cost is independent of video length, and write to a fixed key so regeneration is idempotent.
**Libraries:** —

**Revisions:**
- 2026-11-01 — Thumbnail object key is `videos/{videoId}/thumbnail.jpg` inside the **thumbnails** bucket (`streamtube-thumbnails`), not alongside the original, following TD-05's decision of Option B. Rationale: resolves IC-2 of `validation.md` — the recommendation above assumed TD-05 Option A's single-bucket layout.

### phase-03-videos/TD-11

**Recommendation:** **single `status` enum carrying the four named states**. The criterion is explicit that the cycle must be reflected in the database, and Option A is the only choice where a reader of the migration sees `draft`, `processing`, `ready`, `error` directly — Option B renders them only as a projection and Option C not at all. The objection to a single enum is real but is about *publication*, not upload: keeping Phase 04's `visibility`/`published_at` as a separate orthogonal column, rather than extending this enum, resolves it without the extra column now. For failure handling, which `desafio.md` asks about specifically: persist `processing_error` and `processing_attempts`, let the queue retry with exponential backoff up to a bounded attempt count, land on `error` as a terminal state, and expose a reprocess path that transitions `error → processing`. For idempotency, make the worker's first action a conditional update — `UPDATE videos SET status='processing' WHERE id=$1 AND status IN ('draft','error')` — and treat zero affected rows as "already handled", so a duplicate delivery is a no-op rather than a second FFmpeg run. Choose Option B instead only if the team prefers precise modelling over literal alignment with the criterion, and then make sure the derived status is documented in OpenAPI so no consumer reimplements the mapping.
**Libraries:** —

**Revisions:**
- 2026-11-01 — Retry policy fixed explicitly on `createQueue`: `retryLimit: 3`, `retryDelay: 60` (seconds), `retryBackoff: true`. Rationale: resolves AMB-2 of `validation.md` — "bounded attempt count" was unspecified, and `pg-boss` has made retries opt-out with `retryLimit: 2` since v10, which is the wrong inherited default for a non-idempotent FFmpeg handler. Terminal state remains `error`, with `processing_error` and `processing_attempts` persisted.

### phase-03-videos/TD-12

**Recommendation:** **status on the video resource, clients poll**. The signal is one low-frequency state change for very few concurrent clients, and polling is the only option needing no new transport, no cross-container fan-out, and no exception to the guard/filter/validation stack every other endpoint uses — while being by far the easiest to assert in the e2e suite that the Definition of Done requires. Options B and C both pay a real plumbing cost specifically because the worker and API are different containers, and both make the DoD suite harder to write. Document a suggested poll interval and the terminal states in OpenAPI so clients do not guess. Revisit SSE if a later phase needs genuine real-time updates for many simultaneous viewers; adding it then is additive rather than a rewrite.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** **`nanoid(11)` in a `UNIQUE` column, regenerate on conflict**. Unguessability is not optional here: Phase 05 requires unlisted videos to be reachable only by direct link, which eliminates Options B and D outright since both let someone enumerate the catalogue from a single known identifier. Against Option C it wins on the plan's explicit "URL curta" requirement and on keeping the public identifier independent of the internal primary key. Generate it in application code rather than as a database default so it is available in TD-04's draft-creation response, index it `UNIQUE`, and keep the storage key derived from the video id (TD-05) rather than the slug so the two can never drift. Pin `nanoid` in `library-refs.md`.
**Libraries:** nanoid

### phase-03-videos/TD-14

**Recommendation:** **API serves `206 Partial Content`** — a reversal of what I would have recommended while the frontend was in scope, and worth being explicit about why. With a Next.js BFF in the picture, Option A meant two Node hops for every byte and that cost dominated; backend-only, it is one hop. Against that, Option A matches the mechanism `desafio.md` names, is the version a `supertest` assertion can demonstrate directly against our own code, gives per-request authorisation that is strictly stronger than a short-TTL bearer URL for the unlisted-video requirement arriving in Phase 05, and removes the browser-reachable-storage problem from TD-16 entirely. Option B remains the better *architecture* for a real video platform and should be the clear choice the moment a CDN enters the picture or read volume becomes material — it is worth noting in the plan as the intended production direction rather than silently dropping. Option C is out of scope. For implementation: set `Accept-Ranges: bytes`, handle a missing `Range` as a `200` full-body stream and an unsatisfiable one as `416`, pass the byte range through to `GetObject` rather than fetching the whole object and slicing, authorise before opening the stream, and reuse the same handler for download with `Content-Disposition: attachment`.
**Libraries:** —

**Revisions:**
- 2026-11-01 — Phase 03 authorisation narrowed to what this phase's data model actually contains: the video must have `status = ready`, and access is otherwise open (anonymous reads permitted, matching the project plan's anonymous-viewing requirement). The public/unlisted distinction described in the recommendation above arrives with Phase 04's `visibility` column and must be added to this handler at that point. Rationale: resolves IC-4 of `validation.md` — TD-11 deliberately defers `visibility` to Phase 04, so conditioning Phase 03 authorisation on it would either invent the column (scope creep) or silently drop the rule.

### phase-03-videos/TD-15

**Recommendation:** **reuse the Compose services, real FFmpeg against a committed fixture**, following the `mailpit` precedent: add `src/test/storage.ts` mirroring `src/test/mailpit.ts` to create and tear down a per-suite key prefix, and commit `src/test/fixtures/sample.mp4` with known duration and dimensions to assert against. `desafio.md` effectively mandates this, and it is also the right call on the merits — the bugs in this phase live in behaviours only a real S3 implementation and a real `ffprobe` exhibit. Option B's isolation is attractive but collides with the container-only execution rule and leans on an image that no longer exists. Option C is an automatic fail. Keep the suffix contract intact: `FfmpegService`, `StorageModule` and `QueueModule` each expose a mockable seam for `*.spec.ts` while `*.integration-spec.ts` uses the real services; test the worker by enqueuing a real job and running the handler rather than asserting on mocks; and cover the full upload → process → `ready` → ranged-read path in `*.e2e-spec.ts` via `supertest`.
**Libraries:** —

### phase-03-videos/TD-16

**Recommendation:** **single backend stack, explicit `S3_ENDPOINT_INTERNAL` / `S3_ENDPOINT_PUBLIC` pair**. All the new services belong in `nestjs-project/compose.yaml` next to `db` and `mailpit`, keeping every documented command and the service-name rule intact; the frontend stack is untouched, which is correct given it is out of scope. The dual endpoint is not ceremony — it is the only way a presigned upload URL works from the e2e suite and from manual verification, and naming both keys turns a confusing runtime failure into an explicit contract. Option B offloads the problem to undocumented machine setup and would break a reviewer's clean clone. Option C is likely right eventually but belongs to a separate infra task for Phase 07. Add to the env contract, all through `env.validation.ts` (Joi) and a namespaced `storage.config.ts`: `S3_ENDPOINT_INTERNAL`, `S3_ENDPOINT_PUBLIC`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `PRESIGN_TTL_SECONDS`. Give MinIO a healthcheck so `nestjs-api` and `video-worker` can both `depends_on: condition: service_healthy`, and order the bootstrap sidecar after it.
**Libraries:** —

**Revisions:**
- 2026-11-01 — `UPLOAD_MAX_BYTES` removed from the canonical env contract. Rationale: resolves IC-3 of `validation.md` — the key existed solely to serve TD-06, which is rejected; no source requires an upload ceiling.
- 2026-11-01 — Singular `S3_BUCKET` replaced by `S3_BUCKET_VIDEOS` and `S3_BUCKET_THUMBNAILS`, following TD-05's decision of Option B. Rationale: resolves IC-2 of `validation.md`.
- 2026-11-01 — Queue connection adds no new env keys: per TD-17 (Option B) `pg-boss` builds its pool from the existing `databaseConfig` factory. Rationale: closes the "plus whatever TD-07's queue requires" placeholder in the recommendation above.

### phase-03-videos/TD-17

**Recommendation:** **dedicated pool built from the shared `databaseConfig`; `pg-boss` owns its schema; per-call `db` override for transactional enqueue.** It is the only option that keeps all three commitments at once: one source of connection configuration (satisfying the inherited convention), transactional enqueue intact (preserving TD-07's central justification), and no hand-maintained copy of a third party's internal DDL. Option A looks tidier against the versioned-migration rule but buys that tidiness by vendoring `pg-boss`'s schema into our migration history, where it will rot on the first library upgrade — and it puts worker polling on the request pool. Option C is eliminated by the convention and by losing transactional enqueue. Record the schema-ownership deviation explicitly in `nestjs-project/CLAUDE.md`: the `pgboss` schema is created by the library at boot, is intentionally absent from `src/database/migrations/`, and `migration:run` alone does not provision it.
**Libraries:** pg-boss, pg

## Inherited Decisions Detail

_(inherited TDs from prior phases via phases-reader, plus the correlator-confirmed `openapi-docs-nestjs` doc; dedupe applied — no ref collides with current scope)_

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.
**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

## Inherited Conventions

_(from phases-reader — flattened from prior phases)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and the CLI data source. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`. _(from phase 01)_

_Phase 02 (both slices) records no conventions of its own — `phase-02-auth-frontend/context.md` § Inherited Conventions reads `_No inherited conventions from prior phases._` and neither slice declares any. The Phase 02 contract surface reaches this phase only through the TD details above and the deferred rows below._

## Inherited Deferred Capabilities

_(from phases-reader — informational only; `plan-validate` does NOT fire issues based on unaddressed entries here)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

_All inherited deferred entries are frontend screens. Phase 03 is backend-only per `desafio.md`, so none of them is addressed by this phase and none blocks it._

## Non-UI / Deferred Capabilities

_(read by plan-context / plan-build; write-append by plan-resolve)_

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` § 3 — Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit (branch logic, mock repo) + Integration (DB contract) |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller (`*.controller.ts`) | E2E only — do NOT write unit tests |
| DTO (`*.dto.ts`) | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter (`*.filter.ts`) | Unit + E2E |
| Middleware (`*.middleware.ts`) | E2E |

**Suffix contract** (from `nestjs-project/CLAUDE.md`): `*.spec.ts` = unit (external I/O forbidden); `*.integration-spec.ts` = integration (real DB/services required); `*.e2e-spec.ts` = full HTTP cycle via `supertest`, located in `nestjs-project/test/`. Integration and e2e suites share one database and **must** run with `--runInBand`.

**Phase-03-specific layering implied by TD-15 (decided A):** `FfmpegService`, `StorageModule` and `QueueModule` each expose a mockable seam for `*.spec.ts`, while `*.integration-spec.ts` exercises the real Compose services. The worker is tested by enqueuing a real job and running the handler, not by asserting on mocks. One `*.e2e-spec.ts` covers the full upload → process → `ready` → ranged-read path. Per `desafio.md`, do not simulate what the Compose infrastructure can run for real.

### next-frontend

_Deferred subproject — the video interface is out of scope for this phase per `desafio.md`. No frontend artifact is created, so no frontend testing requirements apply. The `testing-guide-next-frontend` skill exists and will govern when a later phase builds the video UI._
