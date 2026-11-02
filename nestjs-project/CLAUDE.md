# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage, S3 API `9000`, console `9001`, user/password `streamtube`
- `minio-bootstrap` — one-shot sidecar creating the `streamtube-videos` and `streamtube-thumbnails` buckets; exits 0 and is idempotent
- `video-worker` — background video processing (FFmpeg); no HTTP listener

## Videos module (Phase 03)

`VideosModule` owns the video domain. Seven endpoints, all under `/videos`:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /videos` | owner | Pre-registers the video as a `draft` and returns the server-authoritative `uploadKey` + `part_size_bytes` |
| `POST /videos/:id/upload/sign` | owner | Signs **one** S3 operation; the `key` in the body is untrusted and re-checked against the draft every time |
| `POST /videos/:id/upload-complete` | owner | `HeadObject` integrity check, then `draft → processing` + enqueue in one transaction |
| `GET /videos/:slug` | public (owner-only when not `ready`) | Polling surface; serves `404` rather than `403` to hide a draft's existence |
| `POST /videos/:slug/reprocess` | owner | `error → processing` + re-enqueue, same transactional pattern |
| `GET /videos/:slug/stream` | public | `206 Partial Content` range streaming |
| `GET /videos/:slug/download` | public | Same handler, plus `Content-Disposition: attachment` |

Status cycle: `draft → processing → ready | error`. Publication is **not** in this enum — `visibility` / `published_at` is Phase 04's orthogonal axis.

**No video bytes ever pass through the API on upload.** The client PUTs directly to object storage with presigned URLs; the API only signs and verifies. Delivery is the opposite — the API *does* serve the bytes, pushing the byte range down to storage rather than buffering the object.

**The worker is a separate container with no HTTP listener.** `src/main.worker.ts` boots `WorkerModule` via `createApplicationContext`, so a multi-minute FFmpeg run cannot occupy the API's event loop. Run it with `npm run start:worker:dev` (or `start:worker:prod` against `dist/`). `WorkerModule` must declare the **whole entity relation graph** (`User`, `Channel`, `Video`), not just `Video` — TypeORM resolves inverse relation sides at initialization and the container fails to boot otherwise.

### Running the video test suites

ffmpeg/ffprobe exist **only** in the `video-worker` image, so the suites under `src/worker/` must run there:

```bash
docker compose exec video-worker npx jest --runInBand src/worker/
```

`video-worker` is a superset of `nestjs-api` (same code, same `node_modules`, plus the binaries), so it is also the simplest place to run the **whole** suite in one go:

```bash
docker compose exec video-worker npm test -- --runInBand
docker compose exec video-worker npm run test:e2e
```

## Video Infrastructure — accepted constraints

Three deliberate constraints introduced by Phase 03. They are documented here because each is a deviation a future reader would otherwise mistake for a bug.

**1. The MinIO image is frozen and receives no security patches.** `compose.yaml` pins `bitnamilegacy/minio:2025.7.23`. The upstream `minio/minio` repository is **no longer distributed on Docker Hub** (the community edition was archived 2026-04-25), so `image: minio/minio` does not pull at all. `bitnamilegacy` is the pullable mirror with real version tags, frozen at the July 2025 release. Accepted because storage is a local-development-only dependency here — production uses managed S3, which is why `StorageModule` is written against the S3 API rather than a MinIO client.

**2. The `pgboss` schema is created at application boot, not by a migration.** `pg-boss` owns and versions its own schema and creates it during `boss.start()`. It is intentionally **absent** from `src/database/migrations/`, so `npm run migration:run` alone does **not** provision a working queue — the application (or the worker) must have booted at least once. This is a conscious exception to the project's versioned-migration discipline: vendoring a third party's internal DDL into our migration history would rot on the first library upgrade.

**3. This MinIO build does not support `AbortIncompleteMultipartUpload`, so orphaned uploads are reaped by a job, not by a bucket lifecycle rule.** Verified at SI-03.1.2 against both `mc ilm import` and `aws s3api put-bucket-lifecycle-configuration`: a lifecycle rule whose only action is `AbortIncompleteMultipartUpload` is rejected with *"XML … did not validate against our published schema"* for every `Filter` shape (absent, `{}`, `{Prefix:""}`, and legacy rule-level `Prefix`); when combined with an `Expiration` action the server accepts the request but **silently drops the Abort clause**. The cleanup requirement therefore moves to the `draft-reaper` queue job, which enumerates stale uploads via `ListMultipartUploads` (filtering on each upload's `Initiated` timestamp) and removes them via `AbortMultipartUpload`. Both APIs are fully supported by this build and were verified end-to-end.

**4. This MinIO build also ignores the `Prefix` parameter of `ListMultipartUploads`.** The value is echoed back in the response and the result set comes back **empty**, even when matching uploads exist (verified: the same uploads are returned when the parameter is omitted). Any code that filters in-flight multipart uploads server-side is therefore a silent no-op — list without `Prefix` and filter client-side. `src/storage/storage.test-harness.ts`'s `listOwnUploads` is the single place that does this; `StorageService.listStaleUploads` is unaffected because the reaper sweeps the whole bucket by design.

**FFmpeg version.** The `video-worker` stage installs Debian's `ffmpeg` package; the resolved version is **`5.1.9-0+deb12u1`** (ffmpeg and ffprobe both). It is present **only** in the worker image — `Dockerfile.dev` is multi-stage and `compose.yaml` declares an explicit `target:` per service (`base` for `nestjs-api`, `worker` for `video-worker`). Dropping that `target:` would silently hand ffmpeg to the API, because Docker builds the last stage by default.

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands

**Which container matters for tests.** From Phase 03 on, two suites under
`src/worker/` drive the real `ffmpeg`/`ffprobe`, which exist **only** in the
`video-worker` image (`Dockerfile.dev` is multi-stage and `compose.yaml` picks a
`target:` per service — deliberate, per TD-08).

Those two suites **skip themselves** when the binaries are absent, so `npm test` is
green in either container:

| Container | Result |
|---|---|
| `nestjs-api` | 335 passed, **20 skipped** (2 suites) — the skip names the reason |
| `video-worker` | **355 passed, 0 skipped** |

Run the Definition of Done in `video-worker`, where nothing skips — that is what
keeps the skip from quietly eroding coverage. The gate lives in
`src/worker/ffmpeg-available.ts`, which probes the binaries synchronously (it has to
resolve before Jest collects the suite). The e2e suites need no binaries and are
fully green in both containers.

```bash
# Tests — run in video-worker
docker compose exec video-worker npm test -- --runInBand        # unit + integration
docker compose exec video-worker npm run test:e2e               # e2e (maxWorkers: 1 in its config)
docker compose exec video-worker npm run test:cov -- --runInBand # coverage
docker compose exec video-worker npx jest --runInBand src/worker/ # just the worker suites

# Everything else — either container; nestjs-api by convention
docker compose exec nestjs-api npm run start:dev    # Dev server with hot-reload
docker compose exec nestjs-api npm run build        # Compile to dist/
docker compose exec nestjs-api npm run start:prod   # Run compiled build
docker compose exec nestjs-api npx tsc --noEmit     # Type-check (required before done)
docker compose exec nestjs-api npm run lint         # ESLint with auto-fix
docker compose exec nestjs-api npm run format       # Prettier formatting

# The worker process itself (no HTTP listener)
docker compose exec video-worker npm run start:worker:dev
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec video-worker npm test -- --runInBand
docker compose exec video-worker npm run test:e2e   # config pins maxWorkers: 1
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

`video-worker` rather than `nestjs-api` because it is the only container where **nothing skips** — see the table under "Container-only commands". Both containers are green; only the worker runs the FFmpeg suites for real, so that is where the Definition of Done has to be measured.

`npm test` needs `--runInBand` passed explicitly; `test:e2e` does not, because `test/jest-e2e.json` sets `maxWorkers: 1`. That was added in Phase 03 — before it, the e2e suites ran in parallel workers against one database and truncated each other's rows, which stayed invisible while only `app` and `swagger` existed and broke the moment table-touching suites were added.

**From Phase 03 on, the integration and e2e suites also require `minio` to be up**, not just `db`. They exercise the real object storage and the real `pg-boss` queue through `src/storage/storage.test-harness.ts` and `src/test/queue.ts` (the same precedent `src/test/mailpit.ts` set — drive the real service, do not simulate it). The storage harness lives inside `src/storage/` rather than under `src/test/` on purpose: it needs the AWS SDK, and TD-02 forbids importing `@aws-sdk/` anywhere outside that directory. Keeping it there lets the encapsulation test stay a single unqualified assertion with no exemption list. Bring the stack up with `docker compose up -d` before running them; a suite against a stopped `minio` fails on connection refused, not on a clear message.

Two cross-suite hazards these helpers exist to prevent:

- **Object collisions.** Suites share one storage service, so `createTestStorage('<suite>')` scopes every key under a unique per-suite prefix and `cleanup()` removes objects **and** in-flight multipart uploads under it. Never write to a bare key like `videos/<id>/original.mp4` from a test.
- **Leftover jobs.** `pg-boss`'s own `deleteQueuedJobs` deletes only jobs in the *queued* state and leaves *active* ones behind. Use `QueueService.drain` (which calls `deleteAllJobs`) or the `drainQueues` helper, in `beforeEach`.

Also beware of concurrent DDL in test setup: `DROP TABLE ... CASCADE` takes an AccessExclusive lock on the target **and** on every table referencing it, so issuing several through one pool with `Promise.all` deadlocks and **hangs** the suite instead of failing it. Drop tables sequentially. Dropping a table does not drop its columns' enum types either — enumerate them from `pg_type` rather than listing them by name, or a crashed run leaves an orphan type that makes the next `CREATE TYPE` fail.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
