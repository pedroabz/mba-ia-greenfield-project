---
kind: phase
name: phase-03-videos
libs:
  "@aws-sdk/client-s3": "3.1161.0"
  "@aws-sdk/s3-request-presigner": "3.1161.0"
  pg-boss: "12.38.0"
  nanoid: "3.3.11"
  pg: "^8.20.0"
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-01T15:12:06+0000"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-01T15:06:04+0000"
---

# phase-03-videos — Library References

Libraries newly decided in this phase, with the versions to pin and the API facts that matter at implementation time. Verified against the npm registry and the upstream docs on 2026-11-01.

> **Module-format constraint governing every pin below.** `nestjs-project` is **CommonJS** — `package.json` has no `type` field and `tsconfig.json` sets `module: nodenext`, so emitted output is CJS. The runtime is `node:25.6.0-slim`. Node ≥ 22.12 can `require()` an ESM package that has no top-level await, but TypeScript under `nodenext` resolves the package's `exports` conditions, and a package with **no `require` condition** will be rejected at compile time even when the runtime could load it. This is the deciding factor for the `nanoid` pin.

---

### @aws-sdk/client-s3

**Version:** `3.1161.0`

**Decided by:** `phase-03-videos/TD-02` (also underpins TD-03, TD-04, TD-14)
**Module format:** CommonJS (no `type` field) — safe for this project, no spike needed.
**Engines:** `node >= 20.0.0`.

**Configuration for MinIO (dev) and S3 (prod) from one build** — per TD-02 and TD-16:

```ts
new S3Client({
  region: cfg.region,
  endpoint: cfg.endpointInternal,   // http://minio:9000 in dev; AWS default in prod
  forcePathStyle: true,             // required for MinIO; harmless on S3
  credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
})
```

A **second client bound to `S3_ENDPOINT_PUBLIC`** is needed solely for presigning URLs handed to callers outside the Docker network (TD-16). SigV4 signs the `host` header, so a URL signed for the internal endpoint cannot be used from the host — this is not a rewrite you can do after the fact.

**Commands this phase uses:** `CreateMultipartUploadCommand`, `UploadPartCommand`, `ListPartsCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `HeadObjectCommand`, `GetObjectCommand` (with `Range`), `PutObjectCommand`.

**`@aws-sdk/lib-storage` is deliberately NOT pinned.** TD-02 scoped it to "only if TD-03 selects a server-side-upload option"; TD-03 decided client-direct, so it is not a dependency.

### @aws-sdk/s3-request-presigner

**Version:** `3.1161.0`

**Decided by:** `phase-03-videos/TD-02`
**Module format:** CommonJS — safe.
Used via `getSignedUrl(client, command, { expiresIn })` for every operation TD-03 signs. `expiresIn` comes from `PRESIGN_TTL_SECONDS`.

#### S3 multipart limits that constrain TD-03

Verified against the [Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) page, not from memory:

| Limit | Value |
|---|---|
| Maximum parts per upload | **10,000** (part numbers 1–10,000) |
| Part size | **5 MiB – 5 GiB**; no minimum on the **last** part |
| Maximum parts returned per `ListParts` request | **1,000** |
| Maximum object size | 48.8 TiB |

Two consequences that are easy to get wrong:

1. **Use a fixed part size.** 8 MiB → 1,280 parts for 10 GiB, comfortably inside the 10,000-part ceiling (and that part size would carry a 78 GiB file). A fixed size also keeps resume correct, since skipping already-uploaded parts only works if part boundaries are reproducible.
2. **`ListParts` is paginated at 1,000, and a 10 GiB upload exceeds one page.** At 1,280 parts, a resume implementation that reads only the first page concludes ~280 parts are missing and re-uploads them. Paginate it with the continuation token, and sign `ListParts` repeatedly rather than once.

> **Context7 coverage gap — recorded deliberately.** Context7 has no entry for the AWS SDK for JavaScript v3; a lookup for `@aws-sdk/client-s3` returns other-language and third-party clients (`s3-lite-client`, `async-aws/s3`, `awscr-s3`). The authoritative sources are therefore the [AWS SDK for JavaScript v3 API reference](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/) and the S3 service docs linked above. Use those at implementation time rather than a Context7 lookup, so the `CLAUDE.md` documentation-before-implementation rule is satisfied by a real source rather than a near-miss.

---

### pg-boss

**Version:** `12.38.0`

**Decided by:** `phase-03-videos/TD-07` and `TD-17`
**Module format:** ⚠️ **ESM-only** — `"type": "module"`, engines `node >= 22.12.0`.
**History:** first released 2016-03-18, 305 releases — the most mature option in the Postgres-queue category.

> **Spike this before committing.** The engines floor of exactly `22.12.0` is the Node version that enabled `require(esm)` unflagged, which reads as deliberate support for CommonJS consumers, and the runtime here is Node 25.6. But verify an actual `import { PgBoss } from 'pg-boss'` compiles under `module: nodenext` **and** runs under `ts-jest` before building on it. **Fallback:** pin `11.0.2` (2025-09-29, CommonJS, `node >= 22`) — one major behind, but it removes the question entirely.

**API surface — the whole thing is six calls:**

```ts
const boss = new PgBoss({ /* connection from databaseConfig, per TD-17 */ })
boss.on('error', err => logger.error(err))        // it emits, it does not throw
await boss.start()                                 // creates + migrates the `pgboss` schema
await boss.createQueue('video-processing', {
  retryLimit: 3, retryDelay: 60, retryBackoff: true,   // per TD-11 revision
  deadLetter: 'video-processing-dlq',
})
await boss.send('video-processing', { videoId }, { /* opts */ })
await boss.work('video-processing', async ([job]) => { /* ... */ })   // NOTE: array
await boss.stop()
```

**Four behaviours that bite if unknown:**

1. **Retries are opt-out since v10, default `retryLimit: 2`.** TD-11's revision sets it explicitly to 3 for exactly this reason — an inherited default of 2 on a non-idempotent FFmpeg handler silently reprocesses. TD-11's conditional-update idempotency guard (`UPDATE … WHERE status IN ('draft','error')`) is load-bearing, not defensive.
2. **`createQueue` is mandatory since v10 and never updates an existing queue.** Changing `retryLimit` later does not apply to queues already created — they must be altered explicitly.
3. **The `work()` handler always receives an array**, even at batch size 1. Hence `async ([job]) => {}`.
4. **Transactional enqueue is real** and is TD-07's central justification: `send()` accepts `{ db: { async executeSql(sql, values) } }`, documented as the mechanism for atomic job insertion. Per TD-17 (Option B), wrap the active TypeORM `QueryRunner` in that adapter so the draft row and its job commit together.

**Schema ownership (TD-17, Option B):** `boss.start()` creates and migrates the `pgboss` schema at boot. It is **intentionally absent** from `src/database/migrations/`, so `npm run migration:run` alone does not provision it — record this in `nestjs-project/CLAUDE.md`.

**Docs:** [pg-boss DeepWiki](https://deepwiki.com/timgit/pg-boss) · [releases / breaking changes](https://github.com/timgit/pg-boss/releases)

---

### nanoid

**Version:** `3.3.11` _(deliberately not the latest — see below)_

**Decided by:** `phase-03-videos/TD-13`
**Module format:** dual CJS/ESM — its `exports` map has a full `require` condition pointing at `index.cjs`, with `.d.cts` types.

> **Why v3 and not v6 — a pin chosen on the user's behalf.** `nanoid@6.0.2` is **ESM-only with no `require` condition at all**; its `exports["."]` offers only `types` / `browser` / `default` / `react-native`. In a CommonJS project under `module: nodenext`, TypeScript resolves those conditions and has no CJS entry point to use, so the import is rejected at compile time regardless of whether Node 25 could `require()` it at runtime. v5 has the same shape. **v3.3.11 is the maintained line for CommonJS consumers** and its API is identical for what TD-13 needs:
>
> ```ts
> import { nanoid } from 'nanoid'   // resolves to index.cjs under require
> const slug = nanoid(11)
> ```
>
> Flag for review if you would rather carry `nanoid@6` and absorb the ESM spike, or drop the dependency entirely — TD-13 only requires 11 URL-safe random characters, which `crypto.randomBytes` can produce in about five lines. The *strategy* TD-13 decided (unguessable fixed-length slug in a `UNIQUE` column, regenerate on conflict) is unaffected by either choice.

**Collision budget** (nanoid's own figures, for the `UNIQUE`-index retry path): ~2.38M ids before a 1% collision chance at 8 characters, ~9.74B at 12. At 11 characters the retry path is effectively dead code but must still exist and be tested.

---

### pg

**Version:** `^8.20.0` — **already installed**; no new dependency.

**Decided by:** `phase-03-videos/TD-17`
**Module format:** CommonJS — safe.

Already present as TypeORM's PostgreSQL driver (`nestjs-project/package.json` → `"pg": "^8.20.0"`). TD-17 Option B uses it **directly** for one purpose: constructing `pg-boss`'s dedicated connection `Pool` from the same `databaseConfig` factory the application uses, so the queue duplicates the pool but not the configuration (satisfying the inherited phase-01 single-factory convention).

It is listed here because the new code imports `pg` explicitly rather than only through TypeORM — not because it needs installing.

---

## Non-npm pins

These are not packages, so they carry no `Libraries:` field — but they are versioned dependencies of this phase and belong here.

| Dependency | Pin | Decided by | Note |
|---|---|---|---|
| MinIO server image | `bitnamilegacy/minio:2025.7.23` | TD-01 | `minio/minio` is **gone from Docker Hub** — verified `401` / Hub "object not found" against a `200` control on `library/postgres`. `bitnamilegacy` is pullable with 1027 real version tags. Frozen at MinIO 2025-07-23; no further security patches, accepted because it is a local-only dev dependency replaced by managed S3 in production. `chainguard/minio` is the patched alternative but publishes only moving tags on the free tier, losing reproducibility. |
| MinIO client (bootstrap sidecar) | `bitnamilegacy/minio-client` | TD-01 | One-shot `mc alias set` + `mc mb --ignore-existing` for **two** buckets (per TD-05=B), plus the abort-incomplete-multipart lifecycle rule on each. |
| FFmpeg / FFprobe | whatever `apt install ffmpeg` resolves to in the worker stage — **record the resolved version** in `nestjs-project/CLAUDE.md` once built | TD-09 | Installed only in the worker image (TD-08), never in the API image. `fluent-ffmpeg` is **not** a dependency: upstream was archived 2025-05-22 and TD-09 chose direct `child_process.spawn`. |
| `pg` | `^8.20.0` — **already installed** | TD-17 | No new install. TD-17's dedicated pool is built from the existing dependency and the existing `databaseConfig` factory. |

---

## Install command

```bash
docker compose exec nestjs-api npm install \
  @aws-sdk/client-s3@3.1161.0 \
  @aws-sdk/s3-request-presigner@3.1161.0 \
  pg-boss@12.38.0 \
  nanoid@3.3.11
```

Run it **inside the container** per `nestjs-project/CLAUDE.md` — a host `npm install` on macOS breaks native binaries in the Linux container. If the `pg-boss` ESM spike fails, substitute `pg-boss@11.0.2`.
