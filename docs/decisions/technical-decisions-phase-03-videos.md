---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-01
scope_description: "Phase 03 — upload and processing of videos, backend only: MinIO object-storage provisioning, the S3 access layer, the resumable 10GB direct-to-storage upload strategy and its handshake contract, the background job queue (the phase's main open stack decision), worker topology, FFmpeg/FFprobe metadata extraction and thumbnail generation, the video status cycle, the unique video URL, streaming and download delivery, and the test strategy for the new infrastructure. Per desafio.md the video interface is out of scope for this phase, so next-frontend is not touched."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — every TD below. The `videos` module, the storage access layer, the queue producer, the video worker, the delivery endpoints, the migration and the tests.
- `next-frontend/` — **explicitly out of scope, no TD in this document.** `desafio.md` states it twice: *"Este é um desafio de backend: a entrega é a API, o worker, a infraestrutura e os artefatos do processo. (Há um frontend no repositório, mas a interface de vídeo não faz parte do escopo desta fase.)"* and *"Um frontend Next.js em next-frontend/ (Fases 01–02), fora do escopo desta fase."* The Critérios de Aceite contain no frontend deliverable. Consequently there are **no `Frontend` and no `Cross-layer` TDs here** — with no frontend being built this phase, nothing constrains both layers at once. The API contracts this phase defines are published through OpenAPI and will be consumed by a later phase.
- **Repo-wide / infra** — TD-01, TD-07, TD-08 and TD-16 add services to `nestjs-project/compose.yaml` and extend the env contract.

> **Settled by `desafio.md` — NOT open decisions.**
> - **Object storage is given.** *"Sobre o object storage: ele não é uma escolha em aberto. O projeto já aponta para S3 (compatível) — na prática você roda MinIO localmente em Docker (mesma API do S3) e trocaria por S3 em produção. O que você decide aqui é como usá-lo (organização de buckets/chaves, upload pré-assinado), não qual storage."* So MinIO is the local service and S3 the production target; what this document decides about storage is **how** it is used — TD-05 (buckets/keys) and TD-03 (presigned upload) — plus the narrow sourcing question in TD-01 that exists only because the `minio/minio` image is no longer distributed.
> - **The queue is the phase's main open stack decision.** *"A tecnologia de fila — o plano do projeto a deixa explicitamente em aberto ("TBD"). É a principal decisão de stack da fase."* → TD-07.
> - **Passing the 10GB file through the API is an automatic fail.** *"Passar o arquivo de 10GB pela API de forma que trave o sistema (sem estratégia de upload assíncrono/direto)"* is listed under Reprova automática → TD-03.
> - **Real infra in Compose, exercised by tests.** *"Não ter fila, worker e storage reais subindo no Compose"* is an automatic fail, and *"Não mocke o que dá para testar de verdade com a infra do Compose"* → TD-15.
> - **No invented requirements.** *"Toda informação registrada nos artefatos deve ser rastreável ao plano ou ao código. Não invente requisitos, decisões ou comportamentos sem origem identificável."* Every TD below traces to a capability bullet and to one of the five decisions `desafio.md` names.

> **Inherited hard constraints — not reopened here.**
> - `phase-01-configuracao-base/TD-02` (**Joi** env validation) and `TD-03` (namespaced `registerAs` configs): every new env key goes through `src/config/env.validation.ts` plus a namespaced config factory.
> - `phase-02-auth/TD-02` (custom `@nestjs/jwt` global guard), `TD-06` (`class-validator` + global `ValidationPipe`), `TD-07` (domain exception filter / error envelope), `TD-08` (`@nestjs/throttler`): the new endpoints reuse these unchanged.
> - `openapi-docs-nestjs/TD-01..TD-03`: every new endpoint is documented via `@nestjs/swagger` and exported to `openapi.json`.
> - Channel ownership: each user has one channel (1:1, created at signup). Videos belong to a **channel**, per `desafio.md` and `src/channels/entities/channel.entity.ts`.
> - `nestjs-project/CLAUDE.md`: all commands run inside the container; Compose service names are the only valid hosts; integration/e2e suites share one DB and run `--runInBand`; test suffixes are `*.spec.ts` / `*.integration-spec.ts` / `*.e2e-spec.ts`.

> **Dependency chain.** TD-03 (upload strategy) is load-bearing: TD-04, TD-05, TD-06 and TD-16 are conditioned on it. Decide TD-03 first, then TD-07 (the queue), which conditions TD-08 and TD-12.

---

## TD-01: MinIO Image Sourcing and Bucket Provisioning

**Scope:** Repo-wide

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** MinIO itself is **not** a choice — `desafio.md` fixes it. But a concrete problem blocks writing the Compose service: **the `minio/minio` image is no longer available on Docker Hub.** MinIO stopped publishing community binaries and Docker images in October 2025, entered maintenance mode in December 2025, and the repository was archived on 2026-04-25. Verified against the registries while writing this document (anonymous pull token, control repos on the same code path for comparison):

| Reference | Result |
|---|---|
| `docker.io/minio/minio` | `401` on manifest; Hub API `object not found` |
| `docker.io/minio/mc` | `401`; Hub API `object not found` |
| `quay.io/minio/minio` | `401` — not anonymously pullable |
| `docker.io/library/postgres`, `library/redis` (control) | `200` |
| `docker.io/bitnamilegacy/minio` | `200` — 1027 tags, newest MinIO version `2025.7.23` |
| `docker.io/chainguard/minio` | `200` — actively rebuilt |

So `image: minio/minio` in `compose.yaml` simply will not pull. The server is still AGPL-3.0 open source and runs fine; only the distribution channel changed. This TD picks the image reference and the bucket-bootstrap mechanism — both cited in `compose.yaml`, the env contract and the test setup, which makes it a cross-component concern rather than a container detail. A second, related question: MinIO starts with no buckets, so something must create the bucket before the API presigns into it.

**Options:**

### Option A: `bitnamilegacy/minio` pinned to `2025.7.23`, bucket bootstrapped by a one-shot `mc` sidecar
Bitnami's MinIO packaging, moved to the `bitnamilegacy` namespace in July 2025. A short-lived companion service runs `mc alias set` + `mc mb --ignore-existing` against the server, then exits.
- **Pros:** Verified pullable with real version tags, so the image is **pinnable and reproducible** — valuable for a graded deliverable and for CI. Env-var configuration (`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`), which is the shape most MinIO documentation and tutorials assume, so existing recipes transfer. The `mc` sidecar is the conventional, well-documented bootstrap and gives an obvious place to also set the bucket's lifecycle rule for aborted multipart uploads (TD-04).
- **Cons:** Frozen at MinIO `2025.7.23` — no security patches going forward, which is acceptable for a local dev dependency but must be a conscious, documented acceptance. `bitnamilegacy` is explicitly a legacy/archival namespace, so it may itself be retired eventually. Bitnami images run as a non-root UID with their own path conventions, so volume permissions need attention.

### Option B: `chainguard/minio`, bucket bootstrapped by a one-shot `mc` sidecar
Chainguard's distroless, continuously-rebuilt MinIO image.
- **Pros:** Actively maintained and patched — the only option that still receives CVE fixes. Minimal attack surface, distroless.
- **Cons:** Chainguard's free tier generally publishes only moving tags (`:latest`, `:latest-dev`) with version-pinned tags reserved for paying customers, so **reproducibility is the weak point** — a rebuild can change behaviour under a stable tag, which is the opposite of what a graded, reproducible deliverable wants, and it would need verifying before committing. Distroless means no shell in the container, making the debugging habits documented in `nestjs-project/CLAUDE.md` (`docker compose exec … sh`) unavailable for that service. A matching `mc` image still has to be sourced separately.

### Option C: Build MinIO from the archived AGPL source in a multi-stage Dockerfile
Vendor the archived source at a known tag and compile it in the Compose build.
- **Pros:** Fully self-sufficient — immune to any registry disappearing. Exact version control.
- **Cons:** Adds a Go toolchain and a multi-minute build to the dev environment setup, for a dependency that is incidental to the challenge. Contradicts the "suba o backend e confirme a suíte verde" quick-start the assignment assumes. Clearly disproportionate.

### Option D: Provision the bucket from application code instead of a sidecar
Any image from A/B, but the API creates the bucket on boot (`HeadBucket` → `CreateBucket`).
- **Pros:** One fewer Compose service; the bucket exists wherever the app runs, including tests, with no orchestration.
- **Cons:** Gives the application's runtime credentials bucket-creation authority, which production S3 would not grant — so dev and production diverge in privilege, and the code path is dead weight in production. Mixes infrastructure provisioning into application startup, against the Single Responsibility principle in root `CLAUDE.md`.

**Recommendation:** **Option A (`bitnamilegacy/minio:2025.7.23` + a one-shot `mc` bootstrap sidecar)**. Reproducibility is the deciding property here: this is a graded deliverable whose test suite must pass on someone else's machine, and Option A is the only verified-pullable option with real version tags to pin. The frozen-patches downside is immaterial for a local-only dev dependency that is replaced by managed S3 in production — and it should be written into `nestjs-project/CLAUDE.md` as a known, accepted constraint rather than left implicit. Option B is the better choice on security but trades away pinning and shell access, both of which this project's workflow actively relies on; revisit it if MinIO ever moves back into the hot path. Option C is disproportionate. Option D's bucket-creating application credentials are a privilege shape production would reject, so the sidecar keeps dev and prod honest. Note for `implement`: MinIO requires `forcePathStyle: true` on the S3 client (TD-02), exposes the console on `:9001` alongside the S3 API on `:9000`, and the sidecar is also where the aborted-multipart lifecycle rule from TD-04 belongs.

**Decision:** Option A. We are only using it for local development
**Revisions:**
- 2026-11-01 — Bootstrap sidecar creates **two** buckets (`streamtube-videos`, `streamtube-thumbnails`), each with its own abort-incomplete-multipart lifecycle rule, following TD-05's decision of Option B. Rationale: resolves IC-2 of `validation.md` — the recommendation above says "create the bucket" in the singular, assuming TD-05 Option A.

---

## TD-02: S3 Access Library and Presigning Surface

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** The backend needs to issue presigned URLs (upload and download), verify objects (`HeadObject`), read objects for the worker (`GetObject`, possibly ranged), write thumbnails (`PutObject`), and — per TD-03 — drive multipart create/sign-part/complete/abort. The same client configuration is consumed by the API process, the worker process and the integration tests, so the choice is a cross-component one. It must work against MinIO in dev (custom endpoint, path-style addressing) and real S3 in production with no code change, which is precisely the portability `desafio.md` assumes when it says *"trocaria por S3 em produção"*.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 + `@aws-sdk/s3-request-presigner`
The official AWS SDK v3. Modular commands, first-class TypeScript, `endpoint` + `forcePathStyle` for MinIO.
- **Pros:** The reference implementation for presigning, including `UploadPartCommand` presigning — the exact operation TD-03 Option A depends on, and the one least well covered elsewhere. Identical code against MinIO and real S3, with only config differing, which is the stated production path. Maintained by the vendor whose API this is, so it cannot be orphaned by MinIO's archival.
- **Cons:** Package sprawl (two or three `@aws-sdk/*` packages plus transitive middleware). Verbose command-object API. Near-daily releases mean lockfile churn — mitigated by the `library-refs.md` pin the assignment expects.

### Option B: `minio` JS client (v8)
MinIO's own SDK, still published on npm, works against any S3-compatible endpoint.
- **Pros:** Noticeably friendlier API (`presignedGetObject`, `presignedPutObject`, `fPutObject`) and a single dependency. Purpose-built for the server actually running in dev.
- **Cons:** Maintained by the vendor that **archived the project** (TD-01) — the same risk that made `minio/minio` unpullable now applies to the client. Its multipart-presigning ergonomics are thinner than the AWS SDK's, which matters because multipart is the core of TD-03. Optimised for MinIO rather than for the S3 production target, so it is the wrong way round given the dev→prod direction.

### Option C: `nestjs-minio-client` or a similar community Nest wrapper
A DI wrapper around the `minio` client.
- **Pros:** Saves hand-writing a module; `forRootAsync` config out of the box.
- **Cons:** Inherits every Option B risk and adds a community indirection layer over an archived client. What it saves is roughly 40 lines of a `StorageModule` the project should own regardless, since storage access is a domain boundary.

**Recommendation:** **Option A (`@aws-sdk/client-s3` v3 + `s3-request-presigner`)**, behind a project-owned `StorageModule` exposing a narrow interface (`presignUpload`, `presignDownload`, `headObject`, `getObjectStream`, `putObject`) so no other module imports `@aws-sdk/*` directly. The decisive point is direction of travel: dev runs MinIO but production runs S3, so the client should be the S3 client configured to talk to MinIO — not a MinIO client hoped to work against S3. It is also the only option with first-class multipart presigning, which TD-03 depends on, and the only one not maintained by a vendor that just archived its OSS edition. Options B and C invert the dev/prod relationship and take on the archival risk in the application layer, buying a convenience API that the `StorageModule` wrapper provides anyway. Pin the version in `library-refs.md`, and set `endpoint`, `forcePathStyle: true` and `region` from namespaced config so the same build works against both backends.

**Decision:** Option A
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Upload Strategy for 10GB Files

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** `desafio.md` names this as a decision to justify — *"A estratégia de upload de 10GB sem travar (ex.: upload direto ao storage via URL pré-assinada / multipart, em vez de passar o arquivo pela API)"* — and simultaneously puts the wrong answer under **Reprova automática**: *"Passar o arquivo de 10GB pela API de forma que trave o sistema (sem estratégia de upload assíncrono/direto)."* So the decision space is constrained: the file must not be funnelled through the Node process in a way that blocks it. What remains genuinely open is *which* non-blocking strategy, and each has different consequences for the handshake (TD-04), the object key (TD-05), the size limit (TD-06) and resumability. The project plan's own Pontos de Atenção add a second requirement the options separate on: the upload must *"permitir retomar em caso de falha de conexão."*

**Options:**

### Option A: Presigned S3 multipart — client talks directly to MinIO/S3
The API authorises the upload and presigns each S3 operation (`CreateMultipartUpload`, `UploadPart` ×N, `ListParts`, `CompleteMultipartUpload`, `AbortMultipartUpload`); the client performs them against the storage endpoint. ~1,250 parts at 8MiB for 10GB.
- **Pros:** Zero bytes through Node — the "sem travar" requirement is satisfied structurally rather than by tuning, which is the cleanest possible answer to the auto-fail criterion. Resumability comes from `ListParts`: a client that reconnects discovers which parts already landed. Needs no new server-side protocol dependency, only presigning the API already has (TD-02). Maps directly onto the strategy `desafio.md` itself names as the example.
- **Cons:** Six operations to presign and authorise rather than one endpoint, each needing the requested key validated against the caller's draft so the signer cannot be abused as an open oracle. The signing endpoint is called once per part. Clients must be able to reach the storage endpoint, which TD-16 has to make true without breaking SigV4's signed `host`.

### Option B: tus resumable-upload server in NestJS (`@tus/server` 2.x + `@tus/s3-store`)
Nest mounts the tus protocol handler (`server.handle(req, res)` on Express) and `@tus/s3-store` streams incoming chunks into an S3 multipart upload. `onUploadCreate`/`onUploadFinish` hooks are natural homes for the draft row and the job enqueue.
- **Pros:** Resumability is a protocol guarantee rather than application logic — offset negotiation, upload expiry and `maxSize` are built in, and the lifecycle hooks fit TD-04 almost exactly. One well-specified contract instead of six presigned operations, with authorisation in a single `onIncomingRequest`. Clients only ever talk to the API, so no storage endpoint needs exposing.
- **Cons:** Every byte still transits the Node process. It streams rather than buffers, so it does not *block* the event loop the way a naive multipart body parse would — but it does put 10GB of I/O through the API container, which is arguably the spirit of what the auto-fail criterion prohibits and would need defending explicitly. Requires disabling Nest's global body parser for those routes (`bodyParser: false` plus selective re-enable), a known sharp edge. Adds two dependencies.

### Option C: Presigned single `PUT` per file
One presigned `PutObject` URL; the client uploads the whole file in one request.
- **Pros:** The simplest possible implementation — one presign, one upload, one completion call. No part bookkeeping.
- **Cons:** **Fails the requirement outright.** S3's single-`PUT` ceiling is 5GB, below the mandated 10GB. And a single request has no resume: a dropped connection at 9GB restarts from zero, directly contradicting *"permita retomar em caso de falha de conexão."* Listed to be explicit that the simple option is not available.

### Option D: Chunked upload proxied through the API
Client slices the file; each chunk POSTs to the API, which appends it to an S3 multipart upload.
- **Pros:** Full server-side control over every chunk (byte accounting, scanning). No storage endpoint exposed to clients. No new protocol dependency.
- **Cons:** Re-implements tus by hand — offset negotiation, idempotent chunk retry, orphan cleanup, expiry — all of it correctness- and security-sensitive, and all of it undifferentiated work. Bytes transit Node, same objection as B, without B's protocol guarantees. Highest test burden of the four for the least benefit.

**Recommendation:** **Option A (presigned S3 multipart, client direct to storage)**. It is the strategy `desafio.md` names, and the only one that removes the 10GB from the Node process entirely rather than arguing that streaming it through is good enough — which matters when passing the file through the API is an explicit automatic failure. It also satisfies resumability through `ListParts` without any new dependency, and it reuses the presigning surface TD-02 already establishes. Option B is the better *protocol* and would be the pick if the requirement were only "don't block"; it loses on the stricter reading of the auto-fail criterion and on putting 10GB of I/O through the API container. Option C is eliminated by the 5GiB single-`PUT` ceiling before resumability is even considered. Option D combines B's byte path with A's coordination cost and tus's absent guarantees.

**Notes for `implement` — S3 multipart limits that constrain this design.** Verified against the [Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) rather than assumed:

| Limit | Value |
|---|---|
| Maximum parts per upload | **10,000** (part numbers 1–10,000) |
| Part size | **5 MiB – 5 GiB**; no minimum on the **last** part |
| Maximum parts returned per `ListParts` request | **1,000** |
| Maximum object size | 48.8 TiB |

Four consequences:

1. **Part size must be derived, not guessed.** The 5 MiB floor binds before the 10,000-part ceiling does at our sizes: 10 GiB at 5 MiB is 2,048 parts, at 8 MiB is 1,280. Either is comfortably inside the limit (8 MiB parts would carry a 78 GiB file), so pick a fixed part size with headroom rather than computing one per upload — a fixed size also keeps resume deterministic, since skipping already-uploaded parts is only correct if part boundaries are reproducible.
2. **`ListParts` is paginated at 1,000, and a 10 GiB upload exceeds that.** At 1,280 parts, a resume implementation that reads only the first page will conclude 280 parts are missing and re-upload them. Paginate it, or resume is quietly wrong in exactly the case this phase exists to support. This also means the signing proxy must sign `ListParts` repeatedly with the continuation token, not once.
3. **The declared file size is needed at draft creation** so part size and expected part count are known before the first signed operation — it is also what TD-04's `HeadObject` integrity check compares against. It is *not* a limit to enforce; see the rejected TD-06.
4. Validate that the requested key belongs to the caller's draft on **every** signed operation, and set a bucket lifecycle rule aborting incomplete multipart uploads (TD-01's sidecar) so abandoned uploads do not accumulate.

**Decision:** Option A. Breaking down the file into smaller chunks makes sense and make the process more robust

---

## TD-04: Upload Session Handshake — Draft Pre-Registration and Completion Signal

**Scope:** Backend

**Capability:** `Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"; "Processamento automático do vídeo após upload (extração de duração e metadados)"`

**Context:** The capability requires the draft to exist **"ao iniciar o upload"**, not after it. So there is a handshake: create a `videos` row in draft state before the first byte, hand the client an upload target, and later learn the bytes landed so the processing job can be enqueued. Under TD-03 Option A the bytes bypass the API entirely, which makes the **completion signal a trust boundary** — a client asserting "done" is not evidence, and acting on it would let a client drive a video to `pronto` with no file behind it. `desafio.md` also lists *"o que acontece em caso de falha no processamento"* among the decisions to justify, which starts here with what happens to an upload that never completes.

**Options:**

### Option A: Draft-first, client-reported completion verified server-side
`POST /videos` (authenticated, channel-scoped) creates the draft, derives the object key from the new id (TD-05), and returns `{ id, slug, uploadKey }`. The client uploads. `POST /videos/{id}/upload-complete` calls `CompleteMultipartUpload` if needed and `HeadObject` to confirm existence and size **before** transitioning the row and enqueuing the job.
- **Pros:** Satisfies "ao iniciar o upload" literally, which is what the capability and the Critérios de Aceite are graded on. The `HeadObject` check turns an untrusted claim into a server-verified fact, so the row cannot advance without a real object of the expected size — the full security benefit of a storage-event design at none of its cost. Two small endpoints, each trivially testable. The draft row is also the natural durable home for `uploadId` and key, which TD-03's `ListParts` resume needs.
- **Cons:** A client that uploads and vanishes leaves a row in the pre-upload state plus an orphan multipart upload, so it needs a reaper — a scheduled job on the TD-07 queue plus the bucket lifecycle rule from TD-01. One extra round-trip before the upload can start.

### Option B: Storage event notification as the authoritative signal
Draft created as in A, but completion is driven by MinIO's bucket notification calling a webhook; the client's report is ignored or treated as a hint.
- **Pros:** Authoritative by construction — the signal originates from the component holding the bytes, and is immune to a client dying after the last part. Mirrors the canonical production pattern on AWS (S3 Event Notifications → SQS/Lambda).
- **Cons:** Couples the application to MinIO's notification configuration, which must then be reproduced differently on real S3 — working against the dev/prod portability `desafio.md` assumes. The webhook is a public, unauthenticated-by-default endpoint needing its own signature verification, and it must be reachable from the storage container. Adds an infrastructure capability to solve a problem Option A's `HeadObject` already closes, and adds a second async hop to debug.

### Option C: Separate `upload_sessions` entity; `videos` row created only on completion
An `upload_sessions` table holds key, `uploadId`, size, owner and expiry; the `videos` row is inserted when the upload finishes.
- **Pros:** The `videos` table never holds rows without a file, and expiry/reaping is a property of a table that exists for exactly that purpose.
- **Cons:** **Contradicts the capability as written** — nothing is pre-registered as a *rascunho* at upload start, so there is no draft to list or resume into, and the Critério *"com pré-cadastro do vídeo como rascunho ao iniciar"* is not met. Adds an entity and a second identifier for a cleanup problem Option A solves with a reaper.

**Recommendation:** **Option A (draft-first, client-reported completion verified by `HeadObject`)**. It is the only option that satisfies "pré-cadastro … ao iniciar o upload" while keeping the completion signal trustworthy and the dev/prod story identical. `HeadObject` is the whole point: it costs one call and makes the client's report unforgeable, which is the entire security content of Option B without binding the design to MinIO-specific notification config. Pair it with two cheap cleanup mechanisms — the bucket lifecycle rule aborting incomplete multipart uploads, and a scheduled queue job deleting pre-upload drafts past expiry. Option B is worth revisiting in production on real S3, as an additional signal rather than a replacement. Option C is ruled out by the capability text. The transition itself should be a conditional update rather than a read-then-write, so a duplicated completion call is idempotent (see TD-11).

**Decision:** A

---

## TD-05: Bucket Topology and Object Key Convention

**Scope:** Backend

**Capability:** `Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)"; "Geração automática de thumbnail a partir de um frame do vídeo"`

**Context:** This is one of the two storage questions `desafio.md` explicitly leaves open — *"O que você decide aqui é como usá-lo (organização de buckets/chaves, upload pré-assinado)"*. The key is a contract across components: the API derives and presigns it, the worker reads the original and writes the thumbnail beside it, the delivery endpoints (TD-14) presign reads from it, and the entity persists it (`desafio.md` requires *"chaves de storage do arquivo e do thumbnail"* on the videos table). Bucket topology matters because originals and thumbnails differ in size, lifetime and how public they can be.

**Options:**

### Option A: Single bucket, entity-prefixed keys
One bucket. `videos/{videoId}/original{ext}` and `videos/{videoId}/thumbnail.jpg`.
- **Pros:** Everything about one video lives under one prefix, so deleting a video is a prefix delete and inspecting one is a single `mc ls`. One bucket to provision, one credential, one CORS/policy surface. The `{videoId}` prefix is unique without coordination, and it is deliberately *not* the public slug (TD-13), so changing a slug can never orphan an object. Shortest path from the entity to its objects — the key is derivable from the id even if the stored column were lost.
- **Cons:** One policy surface for two asset classes with genuinely different exposure profiles — a thumbnail is small and cacheable, an original is large and private. Per-class lifecycle or storage-class rules must be written as prefix-scoped rules rather than bucket-level ones.

### Option B: Separate buckets per asset class
`streamtube-videos` and `streamtube-thumbnails`, each with its own policy and lifecycle.
- **Pros:** Thumbnails can be made public with a long cache TTL while originals stay presigned-only — the right shape once a CDN is involved. Independent lifecycle rules (originals → cold storage) without prefix scoping. Cleanest blast radius.
- **Cons:** Two buckets to provision in the TD-01 sidecar, two env keys, two code paths in `StorageModule`, and cross-bucket consistency on delete. The payoff — publicly cacheable thumbnails — has no consumer in this phase, since the video interface is out of scope.

### Option C: Date-sharded prefixes
`2026/11/{videoId}/original{ext}`.
- **Pros:** Makes bulk time-range operations easy, and historically helped S3 request-rate distribution.
- **Cons:** S3 dropped the prefix-hashing requirement years ago and MinIO never had it, so the performance rationale is obsolete. Costs the derivability Option A gets for free: every read must consult the stored key, with no fallback. Complexity with no corresponding benefit at this scale.

**Recommendation:** **Option A (single bucket, `videos/{videoId}/…`)**, with both keys persisted on the `videos` row as `desafio.md` requires, and `StorageModule` owning the single function that builds them. It gives uniqueness with no coordination, keeps delete and inspection trivial, and decouples storage layout from the public slug so the two can never drift. Option B is the correct eventual shape and should be revisited when thumbnails go behind a CDN — plausibly Phase 07's production work — but splitting now doubles the provisioning and config surface for a benefit this phase has no consumer for. Option C solves a problem that no longer exists. Create the bucket in the TD-01 bootstrap sidecar, and attach the aborted-multipart lifecycle rule there too.

**Decision:** Option B. I like having separate entities splitted.
**Revisions:**
- 2026-11-01 — Decision is Option B (separate buckets per asset class); the Recommendation above argues for Option A and is retained as the record of the original analysis. **Operative convention under B:** bucket `streamtube-videos` holds `videos/{videoId}/original{ext}`; bucket `streamtube-thumbnails` holds `videos/{videoId}/thumbnail.jpg`. Both bucket names and both object keys persist on the `videos` row. Rationale: resolves IC-1 of `validation.md` — `plan-build` drafts Technical actions from Recommendation prose, so where the decision diverges from that prose the operative convention must be stated explicitly.

---

## TD-06: Enforcement Point for the 10GB Limit

<!-- status: rejected — invented requirement, no source. Retained for history. Do not implement. -->

> ### ⛔ REJECTED — DO NOT IMPLEMENT
> This TD decides something **no requirement asks for**. It is retained deliberately as a record of a wrong turn in the research, not as pending work. The options and recommendation below are **void** — they were written against a requirement that does not exist. See **Decision** at the end of the section for the evidence.
>
> Nothing in this section may produce a Step Implementation, a Technical Specification entry, or an env key.
>
> **Pipeline note — do not reformat the Decision line below.** Its leading `**None` (starting with `*`, not a letter) is what keeps this TD out of the plan pipeline's decided-TD enumeration, which matches on `^\*\*Decision:\*\* [A-Z]`. Every other TD in this document starts its decision with a capital letter and is counted; this one must not be. Removing the bold markers would silently readmit a void TD into `plan-build`.

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** Under TD-03 Option A the bytes never pass through code the API controls, so the limit cannot be enforced by counting bytes in a handler. The ceiling is a cross-component constant — declared in the env schema, applied by the signer, asserted at completion, and documented in OpenAPI so any client reads one authoritative value rather than hard-coding its own.

**Options:**

### Option A: Bound it at signing, then verify at completion
Refuse to presign when the declared size exceeds the limit, sign parts with a fixed bounded part size so total signed capacity cannot exceed it, and assert the real size with the `HeadObject` call TD-04 already makes — rejecting and deleting anything over.
- **Pros:** Honest clients are rejected before uploading a byte; dishonest ones are caught by a check that costs nothing extra because TD-04 makes the call anyway. One configured value, surfaced in OpenAPI. No wasted storage in the normal case.
- **Cons:** Two mechanisms to keep consistent rather than one atomic constraint — a presigned `UploadPart` carries no `content-length-range`, so the guarantee is "bounded signed capacity + verified actual size", not a single signature-level cap. Both halves need tests.

### Option B: Verify only at completion
Presign freely; `HeadObject` at completion and reject + delete anything oversized.
- **Pros:** The simplest possible implementation — one check, in the one place that already calls `HeadObject`. Impossible to bypass.
- **Cons:** A buggy or malicious client can push unbounded data into the bucket before being told no, so storage cost is uncapped — and the user only learns of the rejection after a potentially hours-long upload. Weakest on both cost and experience.

### Option C: Enforce in the bucket policy
Express the cap as a MinIO bucket policy or quota.
- **Pros:** A hard ceiling independent of application code.
- **Cons:** Per-object size caps are not portable between MinIO and real S3, so dev and production would enforce differently or not at all — against the portability this phase is built on. Produces a storage-level error with no usable domain message, so it cannot satisfy the project's error-envelope contract (`phase-02-auth/TD-07`).

**Recommendation:** **Option A (bound at signing, verify at completion)**. Add `UPLOAD_MAX_BYTES` to the Joi schema and a namespaced config factory, reject oversized declarations at presign time, derive part size so signed capacity cannot exceed the cap, and keep TD-04's `HeadObject` size assertion as the closing check. The two-mechanism cost is small and both halves are already on the critical path; what it buys is a fast cheap rejection for honest clients plus a hard backstop against dishonest ones. Option B alone leaves the bucket open to unbounded writes, which is a real cost exposure for a 10GB-per-upload system. Option C breaks dev/prod portability and cannot produce a domain error. Any client-side pre-check is a convenience only and is never the enforcement point.

**Decision:** **None — TD rejected.** The requirements state that we should handle files up to 10GB without performance issues. They never state that we should not accept more than 10GB. This should not be in the implementation plan.

Every mention of the figure in both source documents is a **capacity** statement, not a ceiling:

| Source | Wording |
|---|---|
| `docs/project-plan.md:11` | "**suporte a** arquivos **de até** 10GB sem impactar a performance" |
| `docs/project-plan.md:75` | "Upload de vídeos com **suporte a** arquivos de até 10GB" |
| `docs/project-plan.md:165` | "o upload de até 10GB precisa ser feito de forma que **não trave o sistema**" |
| `desafio.md:81` | "Upload de vídeos de até 10GB **sem travar o sistema**" |
| `desafio.md:137` (Critério) | "Upload de vídeo de até 10GB **sem travar a API**" |
| `desafio.md:154` (Reprova) | "**passar o arquivo** de 10GB **pela API** de forma que trave o sistema" |

No source asks for oversized files to be refused, and the only mention of abuse prevention in either document is `docs/project-plan.md:171`, about likes. Writing this TD therefore breached `desafio.md:32` — *"Não invente requisitos, decisões ou comportamentos sem origem identificável."* It is kept here as the audit trail of that breach and its correction.

**What survives, and where it went:** S3 multipart caps at 10,000 parts, so part size must be derived such that the largest supported file fits (8MiB parts → ~1,250 parts for 10GB). That is arithmetic against a documented storage limit, not a policy, and belongs with the upload strategy in **TD-03** — not here. The `UPLOAD_MAX_BYTES` env key proposed above is **not** part of the canonical env contract.

**If a size cap is ever wanted**, it needs a requirement behind it first and then its own TD — not a revival of this one.

---

## TD-07: Background Job Queue Technology

**Scope:** Repo-wide

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** `desafio.md` calls this out as *"a principal decisão de stack da fase"* — the project plan and `CLAUDE.md` both record the queue as **TBD**. The workload shape matters more than throughput: one job per upload, each extremely heavy (FFmpeg over up to 10GB), so operational weight, retry semantics and inspectability dominate and jobs-per-second is irrelevant. PostgreSQL 17 is already in the stack; Redis is not. The landscape moved in 2026: **BullMQ v6 (released 2026-07-30) added a first-class PostgreSQL backend** with full feature parity — queues, workers, flows, schedulers, rate limiting, priorities, delayed jobs, deduplication, metrics and events — implemented as SQL functions in a `bullmq` schema using `LISTEN`/`NOTIFY` instead of Redis blocking commands, at roughly half Redis throughput (~9,400 vs ~23,000 jobs/s). This TD must also produce enough detail for the plan's **Events/Messages** specification, which the Critérios de Aceite require because of the queue.

**Options:**

### Option A: BullMQ v6 on Redis, via `@nestjs/bullmq` 12
The canonical NestJS queue; adds a `redis` service to Compose.
- **Pros:** Best-supported and best-documented queue in the Nest ecosystem, with `@Processor`/`@OnWorkerEvent` decorators and DI inside processors. `@nestjs/bullmq` 12 already declares `bullmq: ^3 || ^4 || ^5 || ^6`, so v6 works today. Deep retry/backoff/concurrency features and the largest body of prior art, plus Bull Board for inspection — useful for demonstrating the queue works.
- **Cons:** Adds **Redis as a whole new stateful service** — its persistence configuration and failure modes — for roughly one job per upload, when a perfectly good durable store is already running. Jobs cannot be enqueued inside the application's Postgres transaction, so "draft committed, job lost" is a real failure mode that needs handling.

### Option B: BullMQ v6 on PostgreSQL (`createPostgresBackend`)
Identical BullMQ API and `@nestjs/bullmq` decorators, backed by the existing `db` service.
- **Pros:** BullMQ's full feature set and ecosystem with **zero new infrastructure**. Same code as Option A, so moving to Redis later is a configuration change. Jobs get the same ACID durability as the rest of the data.
- **Cons:** **Verified blocking gap:** the published `@nestjs/bullmq@12.0.0` (2026-08-27) contains no `backendFactory` support — I checked the package contents, and the PR adding pluggable backends to `@nestjs/bull` merged **2026-10-27**, after that release. So today this means either waiting on an unreleased upstream feature or hand-rolling `Queue`/`Worker` providers and giving up the `@Processor` decorators that were the reason to use the wrapper. For a deliverable with a deadline, depending on an unreleased feature is a schedule risk.

### Option C: `pg-boss` 12
A mature Postgres-native queue built on `SELECT … FOR UPDATE SKIP LOCKED`.
- **Pros:** Postgres-native by design rather than by adaptation, and the most battle-tested option in that category — no new service. Supports **transactional enqueue**, which neither BullMQ backend offers: the draft row and its processing job commit atomically, eliminating the lost-job window in Option A. With `useListenNotify` and `notify: true`, pickup latency is ~3ms. Retries, backoff, scheduling, dead-letter queues and job archiving are all first-class — and the archive covers the failure-history question `desafio.md` asks about. Inspectable with plain SQL via the project's Postgres MCP server.
- **Cons:** No official NestJS module, so it needs a small project-owned `QueueModule` wrapping `PgBoss` as a provider with `OnModuleInit`/`OnModuleDestroy` hooks, and worker registration is explicit rather than decorator-driven — roughly 60 lines. Smaller Nest-specific community, and no Bull-Board equivalent.

### Option D: RabbitMQ via `@nestjs/microservices`
A real broker with a Nest transport.
- **Pros:** Proper broker semantics and a mature management UI; the natural choice if the system later needs fan-out across several consumer services.
- **Cons:** Heaviest operational footprint of the four for the smallest job volume. `@nestjs/microservices` models RPC and events rather than jobs, so retry, backoff, delayed jobs and progress all have to be built on top. Clear over-engineering for one FFmpeg job per upload.

**Recommendation:** **Option C (`pg-boss` 12)**. Two things decide it. First, it is the only option that gives a Postgres-only stack *today*: Option B is architecturally the same choice but is blocked on an unreleased `@nestjs/bullmq` feature, and the workaround sacrifices the decorator API that justified the wrapper. Second, transactional enqueue is a genuine correctness gain that TD-04 would use directly — the draft row and its job commit together, so they cannot diverge — and neither BullMQ backend offers it. The cost is a ~60-line `QueueModule`, which is cheaper than adding a stateful service (Option A) or betting the schedule on an upstream release (Option B). If familiarity and the `@Processor` developer experience outweigh infrastructure minimalism, Option A is defensible — but it should be chosen knowingly as "we are adding Redis", with the lost-job window handled explicitly. Revisit Option B once `@nestjs/bullmq` ships the merged backend support. Whichever is chosen, the job payload must be specified for the plan's Events/Messages section: at minimum `videoId` and the object key, kept deliberately thin so the worker re-reads current state from the database rather than trusting a possibly stale message.

**Decision:** Option C (`pg-boss` 12). Familiarity pointed at RabbitMQ, but this is a small lab project continuing an existing stack rather than a greenfield build, so the queue should fit what is already running instead of adding a tier.
**Libraries:** pg-boss

Three things decided it. It introduces **no new runtime service** — the one cost agentic development does not reduce, since authoring a RabbitMQ topology is cheap but owning a broker is not. It has the **smallest surface to get wrong**: a six-call API (`start` / `createQueue` / `send` / `work` / `stop`) backed by ten years and 305 releases, against a hand-built DLX + TTL retry topology in D or a three-month-old backend averaging a release every two days in B. And it is the **only option supporting transactional enqueue** — `send()` accepts a `db` option taking `{ executeSql }`, documented as the mechanism for atomic job insertion — which TD-04's handshake uses directly so the draft row and its processing job cannot diverge.

On the rejected options: **A** means adding Redis for roughly one job per upload, with job durability further dependent on AOF/RDB configuration and `maxmemory-policy: noeviction`. **B** is architecturally the same choice as C, but its NestJS integration is unreleased — `@nestjs/bullmq@12.0.0` (2026-08-27) ships no `backendFactory`, and the PR adding it merged 2026-10-27 — so it costs the same manual wiring as C while giving up the decorator API that was the only reason to prefer BullMQ, on a far less mature backend. **D**'s real cost was never authoring effort but operational surface plus retry semantics we would have to build and verify ourselves; reviewer familiarity is a genuine point in its favour and was weighed, but pg-boss's absolute review surface is smaller even unfamiliar.

**Accepted risks and required mitigations:**

- `pg-boss@12` is **ESM-only** (`"type": "module"`, Node ≥ 22.12.0) while this project is CommonJS (no `type` field, `module: nodenext`). Node 25.6.0 supports `require(esm)` and pg-boss's engines floor matches that threshold exactly, which reads as deliberate — but **spike it before committing**, including under `ts-jest`. Fallback: pin `11.0.2`, the last CommonJS release.
- Retries are **opt-out since v10, defaulting to `retryLimit: 2`**. TD-11's conditional-update idempotency guard is therefore load-bearing, not defensive — without it a transient FFmpeg failure silently reprocesses.
- `createQueue` is mandatory and **never updates an existing queue**, so retry and dead-letter tuning must be applied explicitly to queues that already exist.
- **No queue *service* will appear in `compose.yaml`** — the queue is a durable schema inside the `db` service. This is a real, accepted exposure against the Critério de Aceite requiring "fila … subindo via docker compose": the queue is genuinely durable and real rather than simulated, and `db` does come up via Compose. Argue this explicitly in the phase plan rather than leaving it implicit.
- Expose the queue behind a **narrow port** (`enqueueVideoProcessing` / `registerWorker`) and build the **reconciliation sweep** alongside transactional enqueue. The sweep independently covers a worker dying mid-job, which transactional enqueue does not, and it makes a later swap to A or B a one-line change against an already-tested fallback — bounding the cost of this decision to roughly one module.
- **Revisit B** once `@nestjs/bullmq` publishes the merged backend support: decorators, zero new infrastructure and CommonJS would make it attractive for a later phase.

---

## TD-08: Worker Deployment Topology

**Scope:** Repo-wide

**Capability:** `Transversal — covers: "Serviço de processamento em segundo plano (filas)"; "Processamento automático do vídeo após upload (extração de duração e metadados)"; "Geração automática de thumbnail a partir de um frame do vídeo"`

**Context:** `desafio.md` lists *"Como o worker roda (processo/container separado)"* among the decisions to justify, and requires *"fila, worker e storage reais subindo no Compose"* — not having them is an automatic fail. The container diagram already shows a distinct **Video Worker (FFmpeg)**. FFmpeg over a 10GB file saturates CPU and I/O, and the project plan requires processing to run *"em segundo plano, sem bloquear o usuário"*. The worker also needs the `ffmpeg`/`ffprobe` binaries, which the API image has no reason to carry — `nestjs-project/Dockerfile.dev` is currently `node:25.6.0-slim` plus `procps` and `curl`.

**Options:**

### Option A: In-process worker inside the API
Register the queue worker in `AppModule`; jobs run in the API container.
- **Pros:** No new container, one image, one entrypoint, trivial DI reuse. Fastest to get working.
- **Cons:** Contradicts the documented target architecture, and arguably fails the *"worker … subindo no Compose"* criterion since there is no worker service to show. FFmpeg child processes contend with HTTP handling for the same container's CPU, so one large video degrades API latency for every user — the exact failure the plan forbids. Forces FFmpeg into the API image. No independent scaling or restart.

### Option B: Separate container, same codebase, standalone Nest context
A second Compose service built from the same repo with an FFmpeg-bearing image and its own entrypoint (`main.worker.ts`) calling `NestFactory.createApplicationContext(WorkerModule)`.
- **Pros:** Matches the container diagram and satisfies the Compose criterion visibly. Full reuse of DI, config, TypeORM entities, logging and `StorageModule` with no duplication. CPU isolation from the API, and independent restart/scaling. Standalone contexts are the documented Nest pattern for precisely this — no HTTP listener, so guards, interceptors and pipes correctly do not apply. FFmpeg is installed only in the worker image.
- **Cons:** A second Dockerfile stage and Compose service, and two processes to run locally. Shared code means a worker-only change still rebuilds the API image unless build targets are split carefully.

### Option C: Separate npm project / independent service
A `video-worker/` subproject with its own `package.json`.
- **Pros:** Hardest isolation and a fully independent dependency graph.
- **Cons:** Duplicates entities, config and storage access — or forces extracting a shared `packages/*` library, which is a monorepo-tooling decision nothing else in this phase needs. Two TypeORM entity definitions will drift, and that drift is a silent data bug. Far more work for isolation Option B already provides, and it works against the assignment's *"Continuidade, não retrabalho"* guidance.

**Recommendation:** **Option B (separate container, same codebase, `createApplicationContext(WorkerModule)`)**. It is the only option that both matches the documented architecture and keeps one source of truth for entities, config and storage access. The CPU-isolation argument is decisive on its own: under Option A a single 10GB upload makes the whole API slow, which the plan explicitly prohibits, and it leaves nothing to point at for the "worker real subindo no Compose" criterion. Option C's extra isolation is paid for in duplicated entities and a premature monorepo decision. Concretely: `WorkerModule` imports `ConfigModule`, `TypeOrmModule`, `StorageModule`, `QueueModule` and the video-processing provider but registers no controllers; `Dockerfile.dev` gains a worker stage that installs `ffmpeg`; `compose.yaml` gains a `video-worker` service depending on `db` (healthy) and on the MinIO service.

**Decision:** Option B. Worker inside the API sounds like mixing up things that are separate.
If this were a project expected to be maintained by a bigger team with multiple people working at the same time I could see us going with C but it is a one man project for now. We can keep it simple

---

## TD-09: FFmpeg / FFprobe Invocation Strategy

**Scope:** Backend

**Capability:** `Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)"; "Geração automática de thumbnail a partir de um frame do vídeo"`

**Context:** `desafio.md` names *"como ele extrai metadados e gera o thumbnail (FFmpeg/ffprobe)"* as a decision to justify. The long-standing default for this in Node was `fluent-ffmpeg`, but **the upstream `fluent-ffmpeg/node-fluent-ffmpeg` repository was archived on 2025-05-22** (final publish `2.1.3`, same date) and is documented as no longer working correctly against recent FFmpeg builds. What remains are forks of varying provenance. A second question interacts with TD-08's image build: where the binaries come from.

**Options:**

### Option A: Direct `child_process.spawn` of system `ffmpeg`/`ffprobe` behind a thin typed service
`apt install ffmpeg` in the worker stage; a project-owned `FfmpegService` spawns the binaries, parses `ffprobe -print_format json` output, and reads `stderr` for progress.
- **Pros:** No dependency to be abandoned. Arguments are exactly what FFmpeg documents, so every upstream answer and optimisation transfers directly — notably `-ss` **before** `-i` for input seeking, which is 10–50× faster on long files, and `-frames:v 1`. Metadata is one documented command (`ffprobe -v error -print_format json -show_format -show_streams`). Full control over timeouts, kill signals and `AbortSignal`. Easiest to test: unit tests mock one spawn seam, integration tests run the real binaries.
- **Cons:** The project owns argument construction, error-output interpretation and process lifecycle — roughly 100–150 lines. No fluent builder. Injection discipline is on us, mitigated by always using `spawn` with an argv array and never a shell string.

### Option B: `@modernized/fluent-ffmpeg` (maintained TypeScript fork, 1.0.3)
A fork rewritten in TypeScript and republished, targeting Node ≥ 22.
- **Pros:** Keeps the familiar fluent builder (`.screenshots()`, `.ffprobe()`) with native types, and works against current FFmpeg. Less code to write.
- **Cons:** A recent, single-maintainer fork of an abandoned library with a small user base — trading a known abandonment for a younger risk, on the critical path of the phase. Its abstraction hides where `-ss` lands, which is the single detail that dominates thumbnail performance. Every FFmpeg answer needs translating into fork API.

### Option C: npm-bundled binaries (`@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe`)
Binaries delivered as platform-specific npm packages rather than OS packages.
- **Pros:** No `apt` layer; the binary version is pinned in `package-lock.json` and identical across machines and CI, and the worker image stays `node:*-slim`.
- **Cons:** Platform-specific optional dependencies are a well-known source of arm64/amd64 install failures — directly relevant on Apple Silicon building for linux/amd64. Bundled builds frequently lack codecs a distro build includes, which matters when accepting arbitrary user uploads. Adds tens of MB that Docker layer caching handles worse than an `apt` layer.

**Recommendation:** **Option A (direct `spawn` behind a project-owned `FfmpegService`)**. This phase needs two FFmpeg operations — one `ffprobe` metadata read and one single-frame extract — which is far too little to justify taking on dependency risk, and upstream `fluent-ffmpeg`'s archival plus the youth of its forks makes that risk concrete rather than theoretical. Direct invocation also keeps the performance-critical detail visible instead of hidden: `-ss` before `-i` is the difference between a fast and a slow thumbnail, and the wrapper options obscure where it goes. Install via `apt install ffmpeg` in the worker stage only (TD-08), and confine all spawning to one injectable service with an explicit timeout, `AbortSignal` support and argv arrays — giving unit tests a single seam to mock and integration tests the real binaries against a committed fixture (TD-15). Pin nothing new in `library-refs.md` for this TD beyond the FFmpeg version the image installs, which should be recorded.

**Decision:** A
**Revisions:**
- 2026-11-01 — Persisted metadata set fixed to `duration_seconds` (required by the capability), `width`, `height`, `codec_name`, `container_format`, `bitrate_bps`, `size_bytes`. All read from a single `ffprobe -v error -print_format json -show_format -show_streams` invocation; any field absent from the probe output persists as NULL rather than failing the job. Rationale: resolves AMB-1 of `validation.md` — "duração e metadados" enumerated nothing, leaving the Data Model underspecified.

---

## TD-10: Thumbnail Frame Selection and Derivative Set

**Scope:** Backend

**Capability:** "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** "A thumbnail from a frame" leaves two things open that reach the API contract: *which* frame, and *how many* renditions. The rendition set determines the object keys (TD-05), the fields in the video response schema, and what later phases can request — adding a size afterwards means backfilling every existing video. Frame choice matters because many videos open on black or a fade, and a black thumbnail reads as a broken video. Phase 04 adds *custom* thumbnails, so what this phase generates must be replaceable rather than authoritative.

**Options:**

### Option A: Single frame at a fixed relative timestamp, one size
Seek to ~10% of the duration already read by `ffprobe`, extract one frame, store one JPEG at one resolution (e.g. 1280×720).
- **Pros:** One `ffmpeg` call with input seeking, so cost is predictable and independent of file length — which matters for 10GB inputs. One object and one URL field in the schema. The 10% offset avoids the opening black frame in the common case. Idempotent: re-running writes the same key.
- **Cons:** Still picks a poor frame sometimes (long fades, slates). A single large rendition means later grid views download more bytes than they display.

### Option B: Multi-candidate extraction with scoring
Extract N frames spread across the video, score them (mean luminance, entropy, edge density) and keep the best.
- **Pros:** Materially better thumbnails, reliably avoiding black and near-uniform frames. The documented approach when thumbnail quality is itself a product feature.
- **Cons:** N decodes instead of one plus scoring logic and an image library in the worker — real added complexity and runtime, on a worker whose inputs are already up to 10GB, for an automatic thumbnail that Phase 04 lets the user override. Output that feels non-deterministic is harder to assert on in tests.

### Option C: Fixed timestamp, multiple responsive sizes
Option A's frame selection, emitting several renditions (e.g. 320w / 640w / 1280w) from one decode.
- **Pros:** Later responsive grids get correctly sized assets from the start, avoiding a backfill. Cheap — one decode, several scales in a single invocation.
- **Cons:** Triples the objects and bakes a rendition set into the schema and key convention now, when the video interface is out of scope and no consumer exists to validate the breakpoints. The sizes would be guesses.

**Recommendation:** **Option A (single frame at ~10% of duration, one 1280×720 rendition)** at `videos/{videoId}/thumbnail.jpg`, exposed as a single nullable URL field. The automatic thumbnail is a placeholder that Phase 04 lets users replace, so Option B optimises the wrong thing — and its extra decodes are the last thing a worker chewing through 10GB files needs. Option C is genuinely useful but should wait until real layouts define the breakpoints, which is also when a backfill is cheapest since the catalogue is still small; guessing sizes now would be exactly the invented requirement `desafio.md` warns against. Use input seeking (`-ss` before `-i`, per TD-09) so extraction cost is independent of video length, and write to a fixed key so regeneration is idempotent.

**Decision:** A, let's keep it simple
**Revisions:**
- 2026-11-01 — Thumbnail object key is `videos/{videoId}/thumbnail.jpg` inside the **thumbnails** bucket (`streamtube-thumbnails`), not alongside the original, following TD-05's decision of Option B. Rationale: resolves IC-2 of `validation.md` — the recommendation above assumed TD-05 Option A's single-bucket layout.
---

## TD-11: Video Status Cycle, Failure Handling and Worker Idempotency

**Scope:** Backend

**Capability:** `Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"; "Processamento automático do vídeo após upload (extração de duração e metadados)"`

**Context:** `desafio.md` names this decision twice — *"O ciclo de status do vídeo e o que acontece em caso de falha no processamento"* — and fixes the vocabulary in both the persistence requirement (*"status (ex.: rascunho → processando → pronto/erro)"*) and, more bindingly, in the Critérios de Aceite: *"Ciclo de status do vídeo (rascunho → processando → pronto/erro) refletido no banco."* So the graded artefact is those four states, visible in the database. What remains genuinely open is whether that is one column or several, what happens on failure, and how a retried job avoids double-processing — queues retry, so the same video can be handed to the worker twice.

**Options:**

### Option A: Single `status` enum carrying exactly the named cycle
One column: `draft → processing → ready | error`, plus `processing_error` for the failure message and `processing_attempts` for the retry count. Phase 04's publication concern becomes a **separate orthogonal** column later (`visibility`, `published_at`), not new values in this enum.
- **Pros:** Reflects the graded cycle literally and visibly in the database — a reviewer reading the migration sees the four required states. One field for every consumer to read, one enum in the OpenAPI schema. Keeping publication out of this column avoids the conflation that would otherwise force an enum migration in Phase 04, because "published" is a different axis from "processed", not a later stage of it. Retry-safe with a single conditional update.
- **Cons:** The upload sub-states are folded into `draft`, so "created but no bytes yet" and "bytes uploaded, job not yet picked up" are not distinguishable from the status column alone — recoverable from `upload_id`/key being null or set, but not explicit. Slightly less precise than modelling the two concerns separately.

### Option B: Two orthogonal columns — `upload_status` + `processing_status`
`upload_status: awaiting | uploaded | aborted` and `processing_status: pending | processing | ready | failed`, with a derived status exposed in the API.
- **Pros:** Each column has exactly one writer — TD-04's handshake writes the first, the worker the second — so they cannot race on a shared field. Every intermediate state is explicit, and "is this playable?" is a single unambiguous predicate. Reprocessing is a clean `ready → processing → ready`.
- **Cons:** The four named states do not appear as such in the database; they only exist as a derived projection, which reads as a mismatch against a criterion phrased *"refletido no banco"*. Two fields consumers must combine, plus invalid-combination assertions to maintain. More schema surface than the requirement asks for.

### Option C: Separate `video_processing_jobs` table as the source of truth
Status derived from the latest job row; `videos` holds only results.
- **Pros:** Full audit history — every attempt, error and timing is queryable, which is the strongest possible answer to "o que acontece em caso de falha".
- **Cons:** "Is this video ready?" becomes a join or a denormalised cache on what will be the hottest read path in later phases. The chosen queue (TD-07) already persists attempt history in Postgres, so this largely duplicates it. And the status would not be *"refletido no banco"* on the videos table at all, which is what the criterion asks for.

**Recommendation:** **Option A (single `status` enum carrying the four named states)**. The criterion is explicit that the cycle must be reflected in the database, and Option A is the only choice where a reader of the migration sees `draft`, `processing`, `ready`, `error` directly — Option B renders them only as a projection and Option C not at all. The objection to a single enum is real but is about *publication*, not upload: keeping Phase 04's `visibility`/`published_at` as a separate orthogonal column, rather than extending this enum, resolves it without the extra column now. For failure handling, which `desafio.md` asks about specifically: persist `processing_error` and `processing_attempts`, let the queue retry with exponential backoff up to a bounded attempt count, land on `error` as a terminal state, and expose a reprocess path that transitions `error → processing`. For idempotency, make the worker's first action a conditional update — `UPDATE videos SET status='processing' WHERE id=$1 AND status IN ('draft','error')` — and treat zero affected rows as "already handled", so a duplicate delivery is a no-op rather than a second FFmpeg run. Choose Option B instead only if the team prefers precise modelling over literal alignment with the criterion, and then make sure the derived status is documented in OpenAPI so no consumer reimplements the mapping.

**Decision:** Option A. Justification is good enough for me.
**Revisions:**
- 2026-11-01 — Retry policy fixed explicitly on `createQueue`: `retryLimit: 3`, `retryDelay: 60` (seconds), `retryBackoff: true`. Rationale: resolves AMB-2 of `validation.md` — "bounded attempt count" was unspecified, and `pg-boss` has made retries opt-out with `retryLimit: 2` since v10, which is the wrong inherited default for a non-idempotent FFmpeg handler. Terminal state remains `error`, with `processing_error` and `processing_attempts` persisted.
---

## TD-12: How Clients Learn That Processing Finished

**Scope:** Backend

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** After `upload-complete` the video is not yet playable — no duration, no thumbnail. The API must expose some way for a client to learn when `status` reaches `ready` or `error`. With the video interface out of scope, the consumer this phase must satisfy is any API client (the e2e suite, `curl`, a later frontend), so the decision is about what the API offers, not how a UI renders it. Processing a large file takes minutes and concurrent uploads are few, so the real requirement is "observable within a few seconds" for a handful of clients, and it must be testable via `supertest`.

**Options:**

### Option A: Status readable on the existing video resource; clients poll
`GET /videos/{idOrSlug}` returns the current status; a client polls while non-terminal. No new transport.
- **Pros:** Adds nothing — the endpoint exists anyway for later phases and for the e2e suite's assertions. Trivially testable with `supertest`: complete the upload, poll until `ready`, assert duration and thumbnail key. Stateless, so a dropped connection or restarted client just resumes. No interaction with the global JWT guard or the error-envelope filter beyond what every other endpoint already has.
- **Cons:** Wasted requests while idle, and latency bounded by the client's interval — both negligible at this scale but real. Pushes the stop condition and backoff onto the client.

### Option B: Server-Sent Events
`GET /videos/{id}/events` as an SSE stream the worker's completion feeds.
- **Pros:** Near-instant and unidirectional, which matches the need exactly; Nest supports `@Sse` natively and it is plain HTTP.
- **Cons:** The worker is a **separate container** (TD-08) from the API holding the connection, so delivering the event needs a cross-process fan-out — Postgres `LISTEN/NOTIFY` or a pub/sub hop — i.e. new plumbing for one message. Long-lived streaming responses are awkward to assert on in `supertest`, so the DoD suite gets harder to write for no functional gain. Connection lifecycle (reconnect, `Last-Event-ID`, timeouts) becomes project code.

### Option C: WebSocket gateway
`@nestjs/websockets` carrying processing events.
- **Pros:** Bidirectional, and a natural home for the real-time features Phase 06 might want.
- **Cons:** Every drawback of Option B plus a second protocol, a gateway, and an authentication story separate from the JWT guard the rest of the API uses. Substantially over-specified for a single "it's ready" message, and the least testable of the three.

**Recommendation:** **Option A (status on the video resource, clients poll)**. The signal is one low-frequency state change for very few concurrent clients, and polling is the only option needing no new transport, no cross-container fan-out, and no exception to the guard/filter/validation stack every other endpoint uses — while being by far the easiest to assert in the e2e suite that the Definition of Done requires. Options B and C both pay a real plumbing cost specifically because the worker and API are different containers, and both make the DoD suite harder to write. Document a suggested poll interval and the terminal states in OpenAPI so clients do not guess. Revisit SSE if a later phase needs genuine real-time updates for many simultaneous viewers; adding it then is additive rather than a rewrite.

**Decision:** A. Let's keep it simple

---

## TD-13: Unique Public Video URL

**Scope:** Backend

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** `desafio.md` names *"A estratégia de URL única"* as a decision to justify, requires *"o identificador da URL única"* on the videos table, and makes *"URL única por vídeo, sem conflito"* an acceptance criterion. The project plan adds that it should be *"uma URL curta e única que nunca conflite com outro vídeo"*. One forward constraint matters: Phase 05 requires unlisted videos to be reachable only by direct link, so an enumerable identifier would defeat that feature later. This is separate from the primary key and from the storage key (TD-05).

**Options:**

### Option A: Random `nanoid(11)` in a `UNIQUE` column, regenerate on conflict
URL-safe 64-character alphabet; on the vanishingly rare insert conflict, generate again.
- **Pros:** Short, URL-safe without encoding, and **unguessable** — which is what will make Phase 05's unlisted videos actually unlisted. Collision probability is negligible at any realistic catalogue size (nanoid's own figures: ~2.38M ids before a 1% chance at 8 characters, ~9.74B at 12). Decoupled from the primary key, so internal ids can change without breaking URLs. One small, ubiquitous dependency.
- **Cons:** Needs a `UNIQUE` index plus a retry path, both of which must be tested. Not derivable from the id, so it is an extra indexed column and an extra lookup path.

### Option B: `sqids` encoding of the numeric primary key
Encode the id into a YouTube-looking string and decode on read.
- **Pros:** Collision-free by construction — no uniqueness check, no retry, no extra column, since the identifier is a pure function of the id. Decodes straight back to an integer for a fast lookup.
- **Cons:** **Reversible and enumerable.** Anyone can decode one identifier and re-encode its neighbours, exposing catalogue size and making future unlisted videos walkable. Sqids' alphabet shuffle is obfuscation, not a secret — its own documentation says so. That is disqualifying given Phase 05's requirement.

### Option C: The entity's UUID as the public identifier
Reuse a UUID primary key in the URL.
- **Pros:** No extra column, no encoding, no collision handling. A v4 UUID is unguessable.
- **Cons:** 36 characters — the opposite of the "URL curta" the plan asks for. UUIDv7 would be time-ordered and therefore partially enumerable, and it leaks creation time. Couples the public URL to the internal primary key permanently.

### Option D: Base62 encoding of a dedicated Postgres sequence
A sequence plus a hand-written encoder.
- **Pros:** Shortest possible identifiers, collision-free, no dependency.
- **Cons:** Sequential and trivially enumerable — the same disqualifier as Option B — plus an encoder to own and test. The sequence is an extra schema artefact and a contention point with no advantage over Option A.

**Recommendation:** **Option A (`nanoid(11)` in a `UNIQUE` column, regenerate on conflict)**. Unguessability is not optional here: Phase 05 requires unlisted videos to be reachable only by direct link, which eliminates Options B and D outright since both let someone enumerate the catalogue from a single known identifier. Against Option C it wins on the plan's explicit "URL curta" requirement and on keeping the public identifier independent of the internal primary key. Generate it in application code rather than as a database default so it is available in TD-04's draft-creation response, index it `UNIQUE`, and keep the storage key derived from the video id (TD-05) rather than the slug so the two can never drift. Pin `nanoid` in `library-refs.md`.

**Decision:** A
**Libraries:** nanoid

---

## TD-14: Media Delivery — Streaming Playback and Download

**Scope:** Backend

**Capability:** `Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)"; "Download do vídeo pelo usuário"`

**Context:** `desafio.md` names *"a [estratégia] de streaming (ex.: requisições com range / 206 Partial Content)"* as a decision to justify, and the criterion is *"Streaming funcionando (sem exigir download completo) e download do vídeo disponível."* Two capabilities, one mechanism question: how do bytes get from storage to the client, for playback (must support seeking via HTTP `Range`, must start without a full download) and for download (must arrive as a file, i.e. `Content-Disposition: attachment`). They are one TD deliberately — answering them separately risks two inconsistent mechanisms for the same question. Note the access-control shape: Phase 05 will allow anonymous viewing of public videos while unlisted ones stay unlisted, so authorisation is per-video, not per-user, and `status` must be `ready`.

**Options:**

### Option A: API serves the bytes, honouring `Range` with `206 Partial Content`
The endpoint authorises the request, parses `Range`, issues a ranged `GetObject` against storage, and pipes the result back as a `StreamableFile` with `206` and `Content-Range`. Download is the same endpoint with `Content-Disposition: attachment` and no range.
- **Pros:** Matches the mechanism `desafio.md` names in its example, and makes "streaming funcionando" demonstrable in the e2e suite directly: send `Range: bytes=0-1023`, assert `206` and `Content-Range`. Every request is authorised at the moment it is served, with no shareable URL to leak, so unlisted-video access control is airtight and view counting and rate limiting come free. All traffic stays on the API's origin — no storage endpoint exposed, no CORS, no signature-host problem (TD-16 shrinks accordingly).
- **Cons:** Playback bytes transit the Node process. Streaming a range rather than buffering means it does not block the event loop, but a popular video still consumes API bandwidth and sockets — and reads are the dominant traffic for the rest of the project's life. Requires correct `Range` parsing, `Content-Range`, `Accept-Ranges` and `416` handling by hand. Forecloses straightforward CDN offload later.

### Option B: API issues a short-lived presigned GET; storage serves the bytes
The endpoint authorises, then returns (or `302`-redirects to) a presigned `GetObject` URL. Storage honours `Range` and answers `206`. Download reuses the same mechanism with `response-content-disposition=attachment`.
- **Pros:** Keeps Node entirely off the byte path, so a viewer cannot consume API resources at all — the same reasoning that drives TD-03 on the write path, applied to the much higher-volume read path. `Range`/`206`, seeking and concurrency become storage's problem. One query parameter turns the identical mechanism into a download, so both capabilities share one code path. Directly CDN-ready.
- **Cons:** Once issued, the URL is bearer-equivalent until it expires — mitigated by short TTLs, not removed, which is a weaker guarantee for unlisted videos than per-request authorisation. The client must be able to reach the storage endpoint with a signature-valid hostname, which is what makes TD-16 necessary. The `206` is served by MinIO rather than the API, so an e2e test asserting range behaviour is testing storage, not our code — a less direct demonstration of the criterion.

### Option C: HLS/DASH adaptive packaging
Transcode into multiple renditions and serve a manifest plus segments.
- **Pros:** The real answer for production video — adaptive bitrate, fast start, CDN-friendly segments.
- **Cons:** Well outside this phase. The capability only requires playback to start without a full download, which `Range` over a progressive MP4 already satisfies, and Phase 05 asks only for play/pause, volume and a progress bar. It would multiply storage and worker cost per video and change TD-05, TD-10 and TD-11. Nothing in `desafio.md` asks for it, so building it would be an invented requirement.

**Recommendation:** **Option A (API serves `206 Partial Content`)** — a reversal of what I would have recommended while the frontend was in scope, and worth being explicit about why. With a Next.js BFF in the picture, Option A meant two Node hops for every byte and that cost dominated; backend-only, it is one hop. Against that, Option A matches the mechanism `desafio.md` names, is the version a `supertest` assertion can demonstrate directly against our own code, gives per-request authorisation that is strictly stronger than a short-TTL bearer URL for the unlisted-video requirement arriving in Phase 05, and removes the browser-reachable-storage problem from TD-16 entirely. Option B remains the better *architecture* for a real video platform and should be the clear choice the moment a CDN enters the picture or read volume becomes material — it is worth noting in the plan as the intended production direction rather than silently dropping. Option C is out of scope. For implementation: set `Accept-Ranges: bytes`, handle a missing `Range` as a `200` full-body stream and an unsatisfiable one as `416`, pass the byte range through to `GetObject` rather than fetching the whole object and slicing, authorise before opening the stream (status must be `ready`; public allows anonymous, unlisted requires the direct identifier), and reuse the same handler for download with `Content-Disposition: attachment`.

**Decision:** A
**Revisions:**
- 2026-11-01 — Phase 03 authorisation narrowed to what this phase's data model actually contains: the video must have `status = ready`, and access is otherwise open (anonymous reads permitted, matching the project plan's anonymous-viewing requirement). The public/unlisted distinction described in the recommendation above arrives with Phase 04's `visibility` column and must be added to this handler at that point. Rationale: resolves IC-4 of `validation.md` — TD-11 deliberately defers `visibility` to Phase 04, so conditioning Phase 03 authorisation on it would either invent the column (scope creep) or silently drop the rule.

---

## TD-15: Test Strategy for Storage, Queue and FFmpeg

**Scope:** Backend

**Capability:** `Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)"; "Serviço de processamento em segundo plano (filas)"; "Processamento automático do vídeo após upload (extração de duração e metadados)"; "Geração automática de thumbnail a partir de um frame do vídeo"`

**Context:** This phase introduces the project's first non-database external dependencies on the critical path, and `desafio.md` is directive about how to test them: *"Os testes nos níveis adequados (unit, integração com banco/serviços reais, e2e) … Não mocke o que dá para testar de verdade com a infra do Compose"*, plus *"Infra real, testada. Fila, worker e storage precisam subir no Compose e ser exercitados pelos testes: não simule o que dá para rodar de verdade."* The Definition of Done requires `npm test` and `npm run test:e2e` green, `npx tsc --noEmit` at 0, and `npm run lint` passing. `nestjs-project/CLAUDE.md` fixes the suffix contract and mandates `--runInBand`. What remains open is the mechanics: what integration tests connect to, how suites avoid contaminating each other, and what fixture the FFmpeg path runs against.

**Options:**

### Option A: Reuse the Compose services; real FFmpeg against a small committed fixture
Integration tests point at the same MinIO and `db` services developers already run, isolated by a per-suite key prefix and queue name. A small (<100KB, few-second) video is committed and processed by the real binaries. Unit tests mock the `StorageModule`, `QueueModule` and `FfmpegService` seams.
- **Pros:** Exactly what `desafio.md` asks for, and exactly the precedent Phase 02 set with `mailpit` and `src/test/mailpit.ts` — so `docker compose up -d` stays the single setup step and no new tooling enters the project. Exercises the behaviour that actually breaks: presigning, multipart part ordering, `Range`/`206` responses, real `ffprobe` output parsing. `--runInBand` is already mandated, so shared external state is safe. No per-suite container boot, so the suite stays fast enough to run often.
- **Cons:** Requires running infrastructure — already true of every integration test in the project. Suites must be disciplined about unique prefixes and queue names. CI has to start the Compose services.

### Option B: Testcontainers per suite
`testcontainers` boots ephemeral MinIO/Postgres containers from the test process.
- **Pros:** Perfect isolation, no dependence on a developer's running environment, a pristine store per suite.
- **Cons:** A new dependency and an execution model that contradicts the documented "every command runs inside the `nestjs-api` container" rule — Testcontainers inside a container needs Docker-in-Docker or a mounted socket. Seconds of boot per suite, serialised by `--runInBand`. And its best-supported module for this is `@testcontainers/minio`, which targets the now-unavailable `minio/minio` image (TD-01).

### Option C: In-memory fakes for storage and queue; only the DB real
A fake S3 and a synchronous fake queue.
- **Pros:** Fastest and fully deterministic, with no infrastructure.
- **Cons:** **Directly against the assignment**, which twice says not to simulate what the Compose infra can run for real, and makes missing real infra an automatic fail. It would also elide the entire risk surface — presigning, multipart ordering, `Range` semantics, `ffprobe` parsing — so a green suite would be evidence of nothing.

**Recommendation:** **Option A (reuse the Compose services, real FFmpeg against a committed fixture)**, following the `mailpit` precedent: add `src/test/storage.ts` mirroring `src/test/mailpit.ts` to create and tear down a per-suite key prefix, and commit `src/test/fixtures/sample.mp4` with known duration and dimensions to assert against. `desafio.md` effectively mandates this, and it is also the right call on the merits — the bugs in this phase live in behaviours only a real S3 implementation and a real `ffprobe` exhibit. Option B's isolation is attractive but collides with the container-only execution rule and leans on an image that no longer exists. Option C is an automatic fail. Keep the suffix contract intact: `FfmpegService`, `StorageModule` and `QueueModule` each expose a mockable seam for `*.spec.ts` while `*.integration-spec.ts` uses the real services; test the worker by enqueuing a real job and running the handler rather than asserting on mocks; and cover the full upload → process → `ready` → ranged-read path in `*.e2e-spec.ts` via `supertest`.

**Decision:** A. Testing the infra is important

---

## TD-16: Compose Topology and the Storage Endpoint Contract

**Scope:** Repo-wide

**Capability:** `Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)"; "Serviço de processamento em segundo plano (filas)"; "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"`

**Context:** `nestjs-project/compose.yaml` currently runs three services: `nestjs-api`, `db` and `mailpit`. This phase must add MinIO, the bucket-bootstrap sidecar, the video worker, and a queue service if TD-07 selects one needing it — and *"Object storage, fila e worker subindo via docker compose junto com o backend"* is an acceptance criterion. Root `CLAUDE.md` is categorical that Compose service names are the only valid hosts. One wrinkle survives from the upload strategy: under TD-03 Option A a client **outside** the Docker network presigns against the API and then uploads to MinIO, and because SigV4 signs the `host` header, a URL signed for `http://minio:9000` cannot be used from the host — and cannot be rewritten without invalidating the signature. This affects the e2e suite and any manual verification, both of which run from outside the network. (If TD-14 resolves as Option A, this only affects the upload path, not playback.)

**Options:**

### Option A: Single stack; dual storage endpoints (internal + external)
Everything in `nestjs-project/compose.yaml`. `StorageModule` takes `S3_ENDPOINT_INTERNAL` (`http://minio:9000`, for server-side operations) and `S3_ENDPOINT_PUBLIC` (`http://localhost:9000`, used **only** when presigning URLs a caller outside the network will use), with a separate presigner client bound to the public endpoint so the signature matches the host that receives the request.
- **Pros:** Honours the service-name rule for all server-side traffic while making presigned URLs actually usable from the host — the only way to get both without proxy tricks. Two named env keys make the dev/production difference explicit instead of implicit; in production both collapse to the same value, so no code branches. Keeps the existing per-subproject Compose workflow and all documented commands unchanged.
- **Cons:** Two keys to keep consistent, and a `StorageModule` that must be rigorous about which client signs what — using the internal presigner for an external caller fails only at use time, which is a poor place to discover it. Needs a clear comment and a test asserting the presigned host.

### Option B: Single endpoint via a host alias
One `S3_ENDPOINT` value, made to resolve identically inside and outside the network by adding `minio` to the developer's `/etc/hosts` (or using `host.docker.internal` consistently).
- **Pros:** One key, no presigner subtlety, no dual-client discipline.
- **Cons:** Requires an out-of-band change on every developer machine and in CI, which is exactly the kind of undocumented prerequisite that makes "clone and run the suite" fail for a reviewer. `host.docker.internal` is unavailable in many CI environments and violates the service-name rule. Pushes the problem onto the environment instead of solving it in config.

### Option C: Single root `compose.yaml` for the whole monorepo
Collapse the backend and frontend stacks into one file at the repo root.
- **Pros:** One `docker compose up -d` for everything; the natural end state for Phase 07's deploy work.
- **Cons:** The frontend is out of scope this phase, so joining the stacks solves nothing it needs — and it would require rewriting the Compose commands documented in both subprojects' `CLAUDE.md`. Mixes a repository restructuring into a feature phase, against root `CLAUDE.md`'s one-scope-at-a-time rule.

**Recommendation:** **Option A (single backend stack, explicit `S3_ENDPOINT_INTERNAL` / `S3_ENDPOINT_PUBLIC` pair)**. All the new services belong in `nestjs-project/compose.yaml` next to `db` and `mailpit`, keeping every documented command and the service-name rule intact; the frontend stack is untouched, which is correct given it is out of scope. The dual endpoint is not ceremony — it is the only way a presigned upload URL works from the e2e suite and from manual verification, and naming both keys turns a confusing runtime failure into an explicit contract. Option B offloads the problem to undocumented machine setup and would break a reviewer's clean clone. Option C is likely right eventually but belongs to a separate infra task for Phase 07. Add to the env contract, all through `env.validation.ts` (Joi) and a namespaced `storage.config.ts`: `S3_ENDPOINT_INTERNAL`, `S3_ENDPOINT_PUBLIC`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `UPLOAD_MAX_BYTES`, `PRESIGN_TTL_SECONDS`, plus whatever TD-07's queue requires. Give MinIO a healthcheck so `nestjs-api` and `video-worker` can both `depends_on: condition: service_healthy`, and order the bootstrap sidecar after it.

**Decision:** A
**Revisions:**
- 2026-11-01 — `UPLOAD_MAX_BYTES` removed from the canonical env contract. Rationale: resolves IC-3 of `validation.md` — the key existed solely to serve TD-06, which is rejected; no source requires an upload ceiling.
- 2026-11-01 — Singular `S3_BUCKET` replaced by `S3_BUCKET_VIDEOS` and `S3_BUCKET_THUMBNAILS`, following TD-05's decision of Option B. Rationale: resolves IC-2 of `validation.md`.
- 2026-11-01 — Queue connection adds no new env keys: per TD-17 (Option B) `pg-boss` builds its pool from the existing `databaseConfig` factory. Rationale: closes the "plus whatever TD-07's queue requires" placeholder in the recommendation above.

---

## TD-17: pg-boss Database Connection and Schema Ownership

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** TD-07 selected `pg-boss`, justified substantially on **transactional enqueue** — the draft row and its processing job committing together. That is only possible if `pg-boss` can execute its `INSERT` inside the application's open transaction, via its documented `db` option taking `{ async executeSql(sql, values) }`. Separately, `boss.start()` creates and migrates its own `pgboss` schema at runtime. Two questions follow, and neither is answered by TD-07: **where does `pg-boss`'s connection come from**, and **who owns its schema**. Both collide with the inherited phase-01 convention that connection parameters are sourced from a single `databaseConfig` factory and never duplicated, and with the project's versioned-migration discipline (`synchronize` disabled, migrations under `src/database/migrations/`).

**Options:**

### Option A: Reuse the TypeORM `DataSource` for everything; pre-create the schema via a versioned migration
`QueueModule` injects the existing `DataSource` and adapts it (`executeSql: (sql, values) => dataSource.query(sql, values)`). A hand-written TypeORM migration creates the `pgboss` schema, and `pg-boss` runs with migration disabled.
- **Pros:** One connection pool for the whole application. Every schema object appears in the versioned migration history, so the inherited discipline holds literally and `migration:run` fully provisions a fresh database. Transactional enqueue is trivial — the adapter can wrap any `QueryRunner`.
- **Cons:** Hand-porting `pg-boss`'s DDL (tables, functions, indexes, and its own internal version row) into a project migration couples us to the library's internal schema, which it versions itself — a `pg-boss` upgrade silently invalidates our migration. The worker's long-poll and maintenance queries would also contend with request traffic on the same pool.

### Option B: Dedicated pool built from the shared `databaseConfig`; `pg-boss` owns its schema; per-call `db` override for transactional enqueue
`QueueModule` builds a small dedicated `pg` Pool from the **same** `databaseConfig` factory phase 01 established, and lets `boss.start()` create and migrate the `pgboss` schema. Enqueues that must be atomic with application writes pass a per-call `db` adapter wrapping the active TypeORM `QueryRunner`.
- **Pros:** Connection parameters still come from one factory, so the inherited convention is honoured — what is duplicated is the pool, not the configuration. The library owns the schema it versions, so upgrades are its problem, not a stale migration. Worker polling gets its own pool and cannot starve request handling. Transactional enqueue still works, because the `db` option is per-operation and can borrow the request's transaction.
- **Cons:** The `pgboss` schema is created outside the versioned-migration history, so a fresh database needs `boss.start()` to have run before the queue is usable — a documented deviation rather than a silent one. Two pools to size.

### Option C: Fully independent connection from its own env keys
`QUEUE_DATABASE_URL` or a separate `PGBOSS_*` key set, unrelated to `databaseConfig`.
- **Pros:** The queue could later be pointed at a different database with no code change.
- **Cons:** Directly violates the inherited "never duplicated" convention, and creates two sources of truth for the same database's credentials — the exact drift phase 01 set out to prevent. Transactional enqueue becomes impossible across two unrelated connections, removing the main reason TD-07 chose `pg-boss`. No requirement asks for a separate queue database.

**Recommendation:** **Option B.** It is the only option that keeps all three commitments at once: one source of connection configuration (satisfying the inherited convention), transactional enqueue intact (preserving TD-07's central justification), and no hand-maintained copy of a third party's internal DDL. Option A looks tidier against the versioned-migration rule but buys that tidiness by vendoring `pg-boss`'s schema into our migration history, where it will rot on the first library upgrade — and it puts worker polling on the request pool. Option C is eliminated by the convention and by losing transactional enqueue. Record the schema-ownership deviation explicitly in `nestjs-project/CLAUDE.md`: the `pgboss` schema is created by the library at boot, is intentionally absent from `src/database/migrations/`, and `migration:run` alone does not provision it.

**Decision:** Option B — decided on the user's behalf while driving the pipeline unattended (2026-11-01). Chosen because it is the only option that preserves TD-07's transactional-enqueue justification without either duplicating the database configuration (Option C) or vendoring `pg-boss`'s internal DDL into our migration history (Option A). Flag for review if the versioned-migration discipline is considered non-negotiable, in which case Option A is the fallback.
**Libraries:** pg-boss, pg

---
## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Repo-wide | MinIO image sourcing and bucket provisioning | A (`bitnamilegacy/minio:2025.7.23` + `mc` bootstrap sidecar) | **A** |
| TD-02 | Backend | S3 access library and presigning surface | A (`@aws-sdk/client-s3` v3 + presigner, behind `StorageModule`) | **A** |
| TD-03 | Backend | Upload strategy for 10GB files | A (presigned S3 multipart, client direct to storage) | **A** |
| TD-04 | Backend | Upload handshake — draft pre-registration and completion | A (draft-first + completion verified by `HeadObject`) | **A** |
| TD-05 | Backend | Bucket topology and object key convention | A (single bucket, `videos/{videoId}/…`) | **B** |
| ~~TD-06~~ | ~~Backend~~ | ~~Enforcement point for the 10GB limit~~ | ⛔ **REJECTED — invented requirement, no source. Retained for history; do not implement.** | **None** |
| TD-07 | Repo-wide | Background job queue technology | C (`pg-boss` 12 — Postgres-only, transactional enqueue) | **C** |
| TD-08 | Repo-wide | Worker deployment topology | B (separate container, same codebase, `createApplicationContext`) | **B** |
| TD-09 | Backend | FFmpeg / FFprobe invocation strategy | A (direct `spawn` behind `FfmpegService`) | **A** |
| TD-10 | Backend | Thumbnail frame selection and derivative set | A (single frame at ~10% duration, one 1280×720 rendition) | **A** |
| TD-11 | Backend | Status cycle, failure handling and worker idempotency | A (single `status` enum: draft → processing → ready/error) | **A** |
| TD-12 | Backend | How clients learn processing finished | A (status on the video resource; clients poll) | **A** |
| TD-13 | Backend | Unique public video URL | A (`nanoid(11)` in a `UNIQUE` column) | **A** |
| TD-14 | Backend | Media delivery — streaming playback and download | A (API serves `206 Partial Content`; same handler for download) | **A** |
| TD-15 | Backend | Test strategy for storage, queue and FFmpeg | A (reuse Compose services + real FFmpeg on a committed fixture) | **A** |
| TD-16 | Repo-wide | Compose topology and storage endpoint contract | A (single backend stack + dual `S3_ENDPOINT_*` keys) | **A** |
| TD-17 | Backend | pg-boss database connection and schema ownership | B (dedicated pool from shared `databaseConfig`; library owns its schema; per-call `db` override for transactional enqueue) | **B** |

---

## Notes — explicitly out of scope for this phase

Recorded so the plan does not drift into them, and so nothing below is mistaken for an omission:

- **The entire video frontend** — `desafio.md`: *"a interface de vídeo não faz parte do escopo desta fase"* and *"Um frontend Next.js em next-frontend/ (Fases 01–02), fora do escopo desta fase."* No upload UI, no player, no watch page. `next-frontend/` is not modified by this phase. The API contracts defined here are published via OpenAPI for a later phase to consume.
- **Video editing, custom thumbnails, visibility (público/unlisted), draft→publish, management panel, categories** — Phase 04 capabilities, even though they build on this phase's rows and status column.
- **Adaptive bitrate / HLS packaging** — see TD-14 Option C. No capability requires it; progressive MP4 with `Range` satisfies *"sem exigir download completo"*.
- **CDN in front of storage** — Phase 07's production work. TD-14 notes presigned delivery (its Option B) as the intended direction when that happens.
- **Transcoding / format normalisation** — this phase extracts metadata and one thumbnail. Accepting arbitrary containers and serving them back unchanged is in scope; converting them is not.
- **Responsive thumbnail rendition set** — see TD-10; decide when real layouts define breakpoints, while a backfill is still cheap.
- **Storage event notifications as a completion signal** — see TD-04 Option B; additive in production on real S3.
- **Single root `compose.yaml`** — see TD-16 Option C; a separate infra task, sensibly before Phase 07.
- **Joining the backend and frontend Compose networks / the `API_URL` value** — still deferred, and no longer blocking: with the frontend out of scope, nothing in this phase needs cross-stack networking.
