---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-01T17:50:36+0000"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-01T15:06:04+0000"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-01T11:29:11+0000"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-01T17:45:47+0000"
issues:
  - id: IC-1
    status: resolved
    summary: "TD-05 decided B but its Recommendation prose argues and specifies Option A"
    resolved_by: phase-03-videos/TD-05
  - id: IC-2
    status: resolved
    summary: "TD-05=B (two buckets) vs single-bucket layout assumed by TD-01, TD-10, TD-16"
    resolved_by: phase-03-videos/TD-01, phase-03-videos/TD-10, phase-03-videos/TD-16
  - id: IC-3
    status: resolved
    summary: "UPLOAD_MAX_BYTES still in TD-16 env contract though rejected TD-06 voided it"
    resolved_by: phase-03-videos/TD-16
  - id: IC-4
    status: resolved
    summary: "TD-14 authorises on public/unlisted visibility, a column TD-11 defers to Phase 04"
    resolved_by: phase-03-videos/TD-14
  - id: IC-5
    status: resolved
    summary: "TDs instruct pinning libs in library-refs.md but every Libraries cell is empty"
    resolved_by: phase-03-videos/TD-02, phase-03-videos/TD-07, phase-03-videos/TD-13, phase-03-videos/TD-17
  - id: AMB-1
    status: resolved
    summary: "'extração de duração e metadados' — which metadata fields get persisted?"
    resolved_by: phase-03-videos/TD-09
  - id: AMB-2
    status: resolved
    summary: "TD-11 says 'bounded attempt count' for retries without naming the bound"
    resolved_by: phase-03-videos/TD-11
  - id: MD-1
    status: resolved
    summary: "No TD decides how pg-boss obtains its DB connection and owns its schema"
    resolved_by: phase-03-videos/TD-17
  - id: ICC-1
    status: resolved
    summary: "pg-boss opens its own connection, against phase-01's single-databaseConfig rule"
    resolved_by: phase-03-videos/TD-17
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._ All 9 capability bullets in `## Capability Coverage` map to at least one decided TD. The error-response format the new endpoints need is inherited (`phase-02-auth/TD-07`), and the OpenAPI artifact strategy comes from the correlator-confirmed `openapi-docs-nestjs/TD-01..TD-03`. The shared-types contract-sync check (Decisão #29) does not fire: `## UI Inventory` is absent, so `ui_in_scope: false` and there is no frontend to sync a contract with.

### Dependency Gaps

_None._ Every prerequisite this phase implies is delivered by a prior phase and present in context: channel ownership for videos (phase 02 `ChannelsModule`, 1:1 with user), the global JWT guard for the upload endpoints (`phase-02-auth/TD-02`), the domain exception filter and error envelope (`phase-02-auth/TD-07`), rate limiting (`phase-02-auth/TD-08`), and the namespaced-config + Joi env foundation (`phase-01-configuracao-base/TD-01..TD-04`). TD-17 confirms the queue reuses that same `databaseConfig` factory rather than introducing a parallel connection path.

### Inherited Constraint Conflicts

_None._ The one conflict found in the prior revision (`ICC-1`) is resolved — see `## Resolved Issues`.

### Unresolved Open Questions

_None._ All 17 TDs in `## Decisions Index` carry a resolved status: 16 `decided` and 1 `rejected` (TD-06). No `## UI Inventory` section exists, so no inventory open questions are ingested.

### UI Coverage Gaps

_None._ `## UI Inventory` is absent — Phase 03 is backend-only per `desafio.md`, and `next-frontend` is a deferred subproject. `UIG-N` is not a concept without active UI scope, and no `Scope: Frontend` TD exists that the Scope-Subsection orphan check could flag (all 17 are `Backend` or `Repo-wide`).

### Capability Consistency (slicing, phase mode only)

_Omitted — phase 03 has exactly one phase-scope decisions doc, so Check 8 is suppressed by construction._

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-05)_ — TD-05's decision (B) contradicted its own Recommendation prose (A). A `**Revisions:**` block now states the operative convention under B — `streamtube-videos/videos/{videoId}/original{ext}` and `streamtube-thumbnails/videos/{videoId}/thumbnail.jpg`, both bucket names and both keys persisted on the `videos` row — and `## Decisions Detail` carries an explicit precedence rule that a revision governs where it disagrees with the original recommendation. The Option-A prose is retained deliberately as the record of the original analysis.

- **IC-2** _(resolved_by phase-03-videos/TD-01, TD-10, TD-16)_ — Three TDs assumed the single-bucket layout TD-05's decision rejects. Revisions applied: TD-01's sidecar now creates **two** buckets, each with its own abort-incomplete-multipart lifecycle rule; TD-10's thumbnail key is located in the thumbnails bucket rather than alongside the original; TD-16 replaces the singular `S3_BUCKET` with `S3_BUCKET_VIDEOS` and `S3_BUCKET_THUMBNAILS`.

- **IC-3** _(resolved_by phase-03-videos/TD-16)_ — `UPLOAD_MAX_BYTES` existed solely to serve the rejected TD-06. It is removed from TD-16's env-contract list and the removal is recorded as a revision, so the rejected requirement cannot re-enter through the env schema.

- **IC-4** _(resolved_by phase-03-videos/TD-14)_ — TD-14 conditioned authorisation on a `visibility` column that TD-11 deliberately defers to Phase 04. Phase 03 authorisation is narrowed to what the data model contains — `status = ready`, otherwise open (anonymous reads permitted, matching the project plan's anonymous-viewing requirement) — with the public/unlisted gate explicitly scheduled for the phase that adds the column.

- **IC-5** _(resolved_by phase-03-videos/TD-02, TD-07, TD-13, TD-17)_ — Three recommendations instructed pinning in `library-refs.md` while every `Libraries` cell read `—`, which would have left `plan-resolve` with no entry point to materialise the library cache (its *Fill pending TD* path requires a pending TD; its library-cache-only mode requires a non-empty `Libraries`). `**Libraries:**` lines are now present: `@aws-sdk/client-s3, @aws-sdk/s3-request-presigner` (TD-02), `pg-boss` (TD-07), `nanoid` (TD-13), `pg-boss, pg` (TD-17). Non-npm pins — the `bitnamilegacy/minio:2025.7.23` image tag, the `mc` bootstrap image, and the `ffmpeg` version installed in the worker stage — are recorded in `library-refs.md` prose, since the `Libraries` field is for packages the Context7 fetch can resolve.

- **AMB-1** _(resolved_by phase-03-videos/TD-09)_ — The capability said "duração e metadados" without enumerating fields, leaving the Data Model underspecified. The persisted set is now fixed: `duration_seconds`, `width`, `height`, `codec_name`, `container_format`, `bitrate_bps`, `size_bytes` — all from a single `ffprobe -v error -print_format json -show_format -show_streams` call, with absent fields persisting as NULL rather than failing the job.

- **AMB-2** _(resolved_by phase-03-videos/TD-11)_ — "bounded attempt count" named no bound. Fixed explicitly on `createQueue`: `retryLimit: 3`, `retryDelay: 60` seconds, `retryBackoff: true`. This is load-bearing rather than cosmetic — `pg-boss` has made retries opt-out with `retryLimit: 2` since v10, which is the wrong inherited default for a non-idempotent FFmpeg handler.

- **MD-1** _(resolved_by phase-03-videos/TD-17)_ — No TD decided how `pg-boss` obtains its database connection or who owns its schema, both load-bearing for TD-07's transactional-enqueue justification. TD-17 was added and decided **Option B**: a dedicated pool built from the existing `databaseConfig` factory, the library owning the `pgboss` schema it versions itself, and a per-call `db` adapter wrapping the active TypeORM `QueryRunner` for atomic enqueue. The schema-ownership deviation — `pgboss` is created at boot and is intentionally absent from `src/database/migrations/`, so `migration:run` alone does not provision it — is recorded for `nestjs-project/CLAUDE.md`.

- **ICC-1** _(resolved_by phase-03-videos/TD-17)_ — `pg-boss` introducing a second database client conflicted with the inherited phase-01 convention that connection parameters come from a single `databaseConfig` factory and are never duplicated. TD-17 Option B resolves it: what is duplicated is the connection *pool* (deliberately, so worker long-polling cannot starve request handling), not the *configuration*, which still has one source.

## Notes for the next stage

Two items for `/plan-build` to carry rather than rediscover:

- **Revision precedence.** Seven TDs (TD-01, TD-05, TD-09, TD-10, TD-11, TD-14, TD-16) have a `**Revisions:**` block whose content supersedes part of the original `**Recommendation:**` prose. `## Decisions Detail` states the precedence rule explicitly. TD-05 and TD-16 are the two where ignoring the revision would produce materially wrong output (single bucket instead of two; a reintroduced `UPLOAD_MAX_BYTES`).
- **TD-17's decision was made on the user's behalf** while the pipeline ran unattended, and its `**Decision:**` field says so. Option A (pre-create the `pgboss` schema via a versioned TypeORM migration) is the recorded fallback if the versioned-migration discipline is treated as non-negotiable.
