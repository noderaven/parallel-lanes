# Acme Remote Ingest Implementation Plan (condensed fixture)

> Condensed from the acme remote-ingest plan: every task heading and Files
> block is kept verbatim; step text is cut. Each task's dependencies are carried
> as a bracketed lane predecessor in its heading (from "Lanes and order") and a
> `- Consumes:` line naming the tasks whose contracts it uses.

**Goal:** Teammates push export files to a hosted Acme server through `POST /api/ingest`,
from a web Import page or the `acme push` CLI with ingest-only API tokens.

---

## Shared contracts

### Constants (`acme/ingest.py`, added in T0)
```python
UPLOAD_MAX_FILES = 16
UPLOAD_MAX_FILE_BYTES = 16 * 1024 * 1024
UPLOAD_MAX_REQUEST_BYTES = 32 * 1024 * 1024
```

### Frontend types (T17)
```ts
export interface AppConfig { ingest_enabled: boolean; max_files: number; }
```

---

## Lanes and order

- T0 runs first (shared constants), then lanes A-E run in parallel, each task in order:
  - Lane A (backend): T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12
  - Lane B (Vault hardening): T13a, T13b, T13c
  - Lane C (push client): T14a, T14b, T14c, T15
  - Lane D (frontend): T17, T18, T19a, T19b, T20
  - Lane E (deploy): T21, T22
- Join: merge lanes, then T16 (live push test), T23 (README/DESIGN), T24 (E2E).
- After PR merge (not in the workflow): T25 release 0.2.0, T26 operator demo upgrade.

---

### Task T0: Shared upload caps and public expand_paths

**Files:** Modify `acme/ingest.py`, `tests/test_ingest.py`.

- [ ] Add the upload cap constants; rename `_expand` to `expand_paths`.

### Task T1: Schema v4 migration (spec Section 1) [T0]

**Files:** Modify `acme/db/migrations.py`, `acme/db/schema.sql`; Test `tests/test_migrations.py`.

- [ ] `SCHEMA_VERSION = 4`; `api_token` table and `ingest_run.uploaded_by`.

### Task T2: Token store API (Section 1) [T1]

**Files:** Modify `acme/db/store.py`; Create `tests/test_store_tokens.py`.

- Consumes: T1 (api_token table).
- [ ] create/list/revoke/resolve api tokens.

### Task T3: Ingest attribution in the store (Section 2, Recent ingests) [T2]

**Files:** Modify `acme/db/store.py`, `acme/api/schemas.py`; Test `tests/test_store_web_reads.py` (or the existing file that covers `list_ingest_runs`).

- Consumes: T1 (ingest_run.uploaded_by column).
- [ ] `add_ingest_run(..., uploaded_by=)`; `list_ingest_runs` returns the uploader.

### Task T4: ACME_INGEST setting (Section 6) [T3]

**Files:** Modify `acme/api/app.py`; Create `tests/test_api_settings.py`.

- [ ] `_ingest_enabled()`; `app.state.ingest_enabled`.

### Task T5: Store write lock (Section 2, Concurrency) [T4]

**Files:** Modify `acme/db/store.py`, `acme/api/routes/write.py`; Test `tests/test_api_write.py`, `tests/test_store_lifecycle.py`.

- Consumes: T2 (wrap resolve_api_token's update in the lock).
- [ ] `Store.write_lock`; `_locked(store)` raising 503.

### Task T6: Bearer principal for ingest (Section 1, Section 2 Endpoint) [T5]

**Files:** Create `acme/api/ingest_auth.py`; Modify `acme/api/auth.py` (only to expose a
helper that records an IP failure and checks the IP limit); Test `tests/test_api_ingest_auth.py`.

- Consumes: T2 (resolve_api_token).
- [ ] `ingest_principal(request)` dependency.

### Task T7: /api/tokens routes (Section 1, Section 5) [T6]

**Files:** Create `acme/api/routes/tokens.py`; Modify `acme/api/app.py` (include router), `acme/api/schemas.py`; Test `tests/test_api_tokens.py`.

- Consumes: T2 (token store), T4 (ingest_enabled), T5 (_locked).
- [ ] Tokens HTTP API contract.

### Task T8: GET /api/config (Section 5) [T7]

**Files:** Modify `acme/api/routes/read.py`, `acme/api/schemas.py`; Test `tests/test_api_read.py`.

- Consumes: T0 (upload caps), T2 (MAX_TOKEN_NAME_LEN), T4 (ingest_enabled).
- [ ] Config HTTP API contract.

### Task T9: import_paths results, attribution, per-file lock (Section 2 Processing) [T8]

**Files:** Modify `acme/ingest.py`; Test `tests/test_ingest.py`.

- Consumes: T3 (add_ingest_run uploaded_by), T5 (Store.write_lock).
- [ ] `ImportSummary.results`, `uploaded_by`, `display_names`.

### Task T10: Streaming multipart staging (Section 2 Streaming, Filenames) [T9]

**Files:** Create `acme/api/upload.py`; Test `tests/test_upload_staging.py`.

- Consumes: T0 (upload caps).
- [ ] `stage_upload(request) -> StagedUpload`.

### Task T11: POST /api/ingest wiring (Section 2) [T10]

**Files:** Create `acme/api/routes/ingest.py`; Modify `acme/api/app.py` (include router before the SPA mount); Test `tests/test_api_ingest.py`.

- Consumes: T4 (ingest_enabled), T6 (ingest_principal), T9 (import_paths), T10 (stage_upload).
- [ ] Ingest HTTP API contract.

### Task T12: Ingest rate limit and concurrency cap (Section 2 Rate limits) [T11]

**Files:** Modify `acme/api/routes/ingest.py`; Test `tests/test_api_ingest.py`.

- [ ] Per-user window and app-wide semaphore.

### Task T13a: Untrusted SQLite open (Section 3 steps 1-5) [T0]

**Files:** Create `acme/parsers/_sqlite_safe.py`, `tests/test_sqlite_safe.py`; Modify `tests/test_architecture.py` (CORE_MODULES).

- [ ] `open_untrusted_sqlite(path, *, budget_s)`.

### Task T13b: Schema gate and authorizer (Section 3) [T13a]

**Files:** Modify `acme/parsers/_sqlite_safe.py`, `tests/test_sqlite_safe.py`.

- [ ] `table_kinds`, `require_plain_tables`, `lock_down`.

### Task T13c: Vault parser integration (Section 3 Parser changes) [T13b]

**Files:** Modify `acme/parsers/vault.py`; Create `tests/test_parsers_vault_hostile.py`.

- Consumes: T13a (open_untrusted_sqlite), T13b (require_plain_tables, lock_down).
- [ ] Harden `can_handle` and `parse`.

### Task T14a: Push settings (Section 4 Settings) [T0]

**Files:** Create `acme/push.py`, `tests/test_push.py`; Modify `tests/test_architecture.py`.

- [ ] `PushError`, `PushSettings`, `load_settings`.

### Task T14b: Push planning and multipart encoding (Section 4 Planning, HTTP body) [T14a]

**Files:** Modify `acme/push.py`, `tests/test_push.py`.

- Consumes: T0 (expand_paths and upload caps).
- [ ] `plan`, `batches`, `encoded_length`, `iter_multipart`.

### Task T14c: Push transport and orchestration (Section 4 HTTP, Output, Exit codes) [T14b]

**Files:** Modify `acme/push.py`, `tests/test_push.py`.

- [ ] `Transport`, `UrllibTransport`, `push(...) -> PushReport`.

### Task T15: `acme push` command (Section 4 Command, Output) [T14c]

**Files:** Modify `acme/cli.py`; Create `tests/test_cli_push.py`.

- Consumes: T14a (PushError exit codes), T14c (push, PushReport).
- [ ] Typer command `push`.

### Task T16 (join): Live push test with real TLS [T12, T13c, T15, T20, T22]

**Files:** Create `tests/test_push_live.py`.

- Consumes: T2 (minted token), T11 (POST /api/ingest), T15 (acme push).
- [ ] uvicorn over http and tls.

### Task T17: Frontend types, client, config hook, msw defaults (Section 5) [T0]

**Files:** Modify `frontend/src/api/types.ts`, `frontend/src/api/client.ts`, `frontend/src/test/handlers.ts`, `frontend/src/api/client.test.ts`; Create `frontend/src/api/useAppConfig.ts`.

- Consumes: T3 (IngestRun uploaded_by), T7 (Tokens HTTP API), T8 (Config HTTP API), T11 (Ingest HTTP API).
- [ ] Types, client calls, `useAppConfig()`, msw defaults.

### Task T18: API tokens page (Section 5) [T17]

**Files:** Create `frontend/src/pages/ApiTokens.tsx`, `frontend/src/pages/ApiTokens.test.tsx`; Modify `frontend/src/App.tsx` (route `tokens`).

- Consumes: T17 (token client, useAppConfig).
- [ ] List, create, revoke; IngestDisabled notice.

### Task T19a: File picker and pre-upload checks (Section 5 Import page) [T18]

**Files:** Create `frontend/src/components/FileDropZone.tsx`, `frontend/src/pages/Import.tsx` (initial), `frontend/src/pages/Import.test.tsx`; Modify `frontend/src/App.tsx` (route `import`).

- Consumes: T17 (useAppConfig).
- [ ] Drop zone, de-dup, cap checks.

### Task T19b: Upload, progress, results, errors (Section 5 Import page) [T19a]

**Files:** Modify `frontend/src/pages/Import.tsx`, `frontend/src/pages/Import.test.tsx`; Create `frontend/src/components/IngestResults.tsx`.

- Consumes: T17 (uploadIngest), T3 (uploader in recent ingests).
- [ ] Upload, progress, results table, error mapping.

### Task T20: Navigation and disabled state (Section 5) [T19b]

**Files:** Modify `frontend/src/components/Sidebar.tsx`; Create `frontend/src/components/Sidebar.test.tsx`, `frontend/src/components/IngestDisabled.tsx` (if not created by T18).

- Consumes: T17 (useAppConfig), T18 (IngestDisabled if created there).
- [ ] Sidebar links only when ingest is enabled.

### Task T21: Deploy examples (Section 6 nginx, settings) [T0]

**Files:** Modify `deploy/nginx-acme.conf.example`, `.env.example`, `docker-compose.yml` (env comment only); Create `tests/test_deploy_examples.py`.

- Consumes: T0 (UPLOAD_MAX_REQUEST_BYTES), T4 (ACME_INGEST).
- [ ] nginx ingest location; `ACME_INGEST=1` example.

### Task T22: DEPLOY.md (Section 6 Docs) [T21]

**Files:** Modify `DEPLOY.md`.

- [ ] ACME_INGEST row, ingest location, remote ingest and upgrade section.

### Task T23 (join): README and DESIGN [T16]

**Files:** Modify `README.md`, `DESIGN.md`.

- [ ] Import page, API tokens, `acme push`, Vault limits.

### Task T24 (join): End-to-end verification [T23]

**Files:** none committed (scratch only).

- [ ] Build the wheel, run the spec E2E checklist, report pass/fail.

### Task T25 (after merge): release 0.2.0 [T24]
Bump `pyproject.toml` and `uv.lock` to 0.2.0, commit `release: 0.2.0`, annotated tag
`v0.2.0`, push.

### Task T26 (operator): live demo upgrade [T25]
Per spec Section 6 "Live demo".
