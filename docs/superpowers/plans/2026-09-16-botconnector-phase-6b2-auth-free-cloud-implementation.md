# BotConnector Phase 6B.2 Central Auth + Free Cloud 100K Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-party BotConnector login to Web First, keep Local AI usable anonymously, and enforce a 100,000 AI-inference-token rolling 24-hour ledger using canonical `users.id` UUID. Authentication is required for Cloud Search/Fetch too, but those routes do not directly debit this token ledger.

**Architecture:** `app.botconnector.id` remains a Web BFF/static shell. It redirects unauthenticated Cloud users through the existing central account using a symbolic registered client and exact callback, receives a single-use handoff, creates a host-only `__Host-bc-app` session backed by central Redis, and injects verified identity only after server-side resolution. In Web deployment the BFF and Rust gateway share a mounted secret; Rust enforces an explicit internal-auth/user/request envelope on protected Cloud routes. Cloud AI quota is persisted in PostgreSQL with pre-inference reservations and exactly-once terminal settlement/release; Desktop/Local behavior stays unchanged when Web auth-required mode is off.

**Tech Stack:** Node.js `http`/`node:test`; Rust/Hyper/Reqwest; FastAPI/Python; Redis 7.4.10; PostgreSQL 16; plain SQL migrations; existing BotConnector central account.

**Spec:** `docs/superpowers/specs/2026-09-16-botconnector-phase-6b2-auth-free-cloud-design.md`

## Global Constraints

- Anonymous users may open the Web UI and use Local AI.
- Cloud AI requires login.
- Free Cloud AI entitlement is exactly 100,000 route-specific inference tokens over a rolling 24-hour window: chat input + output, embeddings input, rerank query + documents. Search and Fetch require login but do not directly debit this ledger.
- No message-count cap.
- Canonical identity is existing `users.id` UUID.
- Existing `bc_session` is not widened to `.botconnector.id`.
- Web BFF ↔ central app-auth uses a dedicated mounted credential (`X-BotConnector-App-Internal-Token`), distinct from browser sessions, the BFF→Rust secret, and the future quota credential.
- Rust Web Cloud gateway ↔ central quota mutations use a separate mounted credential configured by `BOTCONNECTOR_QUOTA_INTERNAL_TOKEN_FILE` and sent as `X-BotConnector-Quota-Internal-Token`; only Rust receives it, it fails closed when missing, and it is compared in constant time.
- `POST /v1/app-auth/session/resolve` returns a read-only `cloud` quota snapshot to the BFF using the app-auth credential; do not add a public/general quota-status endpoint or give the BFF the quota-mutation credential.
- Quota reservations expire after exactly 7200 seconds; this protects against stale work and is independent of the rolling 24-hour usage window.
- App cookie is opaque `__Host-bc-app`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`.
- One-time handoff TTL is 90 seconds and single-use.
- Handoff client IDs are `botconnector-web` and `botconnector-web-preview`; server configuration maps each to its exact registered callback. Browser input never supplies a callback URL.
- Web BFF strips incoming `X-BotConnector-Internal-Auth`, `X-BotConnector-User-ID`, and `X-BotConnector-Request-ID`, then injects its mounted server-side secret, canonical UUID, and generated request UUID.
- `BOTCONNECTOR_WEB_AUTH_REQUIRED=1` requires the internal secret (constant-time comparison), canonical UUID, and request UUID on protected Rust Cloud routes. `/v1/models` and `/api/botconnector/health` stay public. CORS is not the trust boundary.
- Every successful quota reservation has exactly one terminal action: settle usage, release before returning a pre-generation error, or settle partial usage on stream error/disconnect. `request_id` makes terminal operations idempotent.
- Draft prompt survives login but is never auto-sent.
- Browser-supplied identity headers are never trusted.
- Existing Ollama-first Web Search + Exa fallback behavior remains unchanged.
- Local Core `127.0.0.1:18764` behavior remains unchanged.
- Desktop/MSIX behavior remains unchanged.
- Do not touch `C:\Users\farij\Projects\BotConnector-AIChat-MSIX`.
- Do not commit or push unless the user explicitly authorizes it.
- Production changes are not applied until local/unit acceptance is green and an explicit deployment approval is given.

---

## Audit conclusions used by this plan

1. `app/cache.py:get_redis()` owns the central Redis connection.
2. Existing central account sessions use `app/security.py` + Redis `SETEX` + PostgreSQL `account_sessions`.
3. Existing auth resolution is `request.cookies[COOKIE_NAME] -> read_session() -> users.id`.
4. Redis runtime is 7.4.10; `GETDEL` is available.
5. Migration convention is paired plain SQL: `migrations/<feature>_up.sql` and `_down.sql`.
6. Web test harness is `web/web.test.cjs` using `node:test`; it is already included by `npm run check`.
7. Current Web BFF has one public gateway allowlist in `web/server.cjs`.
8. Rust request router sends `/v1/chat/completions` to `chat_completions()`.
9. In Rust `chat_completions()`:
   - request headers must be read before body `collect()`;
   - quota reservation belongs after request/model parsing and before line-equivalent `if stream`;
   - non-stream settlement belongs immediately after `chat_completions_inner()` returns and before response construction;
   - streaming currently has no usage event in `ResEvent`, so Phase 6B.2 must settle streamed requests through a conservative server-side estimator unless provider usage is surfaced by the current client abstraction.
10. Current non-stream `ChatCompletionsOutput` already contains `input_tokens` and `output_tokens`, and the OpenAI-compatible response already exposes `prompt_tokens`, `completion_tokens`, and `total_tokens`.
11. Token-metered routes are chat completions, embeddings, and rerank. Search/Fetch are authenticated but do not directly debit the AI token ledger.

---

### Task 1: Freeze the implementation baseline without committing

**Files:**
- Read only: `C:\Users\farij\Projects\BotConnector-AIChat\*`
- Create outside repo: a timestamped checkpoint archive or copy
- Read only on VPS: `/opt/botconnector-backend-core`, platform-home container metadata

**Interfaces:**
- Consumes: current dirty working tree containing all accepted Web First work.
- Produces: a reversible filesystem checkpoint and exact baseline test output.

- [ ] **Step 1: Record current Git state**

Run in PowerShell:

```powershell
Set-Location C:\Users\farij\Projects\BotConnector-AIChat
git status --short
git diff --stat
git rev-parse HEAD
```

Expected: existing dirty worktree is preserved; no reset/checkout/clean commands are allowed.

- [ ] **Step 2: Create a filesystem checkpoint outside the canonical repo**

```powershell
$src = (Resolve-Path -LiteralPath "C:\Users\farij\Projects\BotConnector-AIChat").Path
if ($src -ne "C:\Users\farij\Projects\BotConnector-AIChat") { throw "Wrong canonical source path" }
$ts = Get-Date -Format "yyyyMMddTHHmmss"
$dst = Join-Path (Split-Path -Parent $src) "BotConnector-AIChat-checkpoint-$ts"
if (Test-Path -LiteralPath $dst) { throw "Checkpoint destination already exists; choose a new timestamp" }
if ((Split-Path -Parent $dst) -ne (Split-Path -Parent $src)) { throw "Checkpoint must remain outside the repo as a sibling directory" }
robocopy $src $dst /MIR /XD target node_modules dist .git | Out-Host
if ($LASTEXITCODE -ge 8) { throw "Robocopy checkpoint failed with exit code $LASTEXITCODE" }
Write-Host "CHECKPOINT=$dst"
```

Expected: checkpoint contains source and uncommitted work but excludes generated/heavy directories.

- [ ] **Step 3: Run baseline tests**

```powershell
npm run check
cargo test
```

Expected: current baseline remains green before Phase 6B.2 edits.

- [ ] **Step 4: Resolve canonical platform-home source location without editing**

On VPS:

```bash
sudo docker inspect botconnector-platform-home \
  --format '{{json .Config.Labels}}'

sudo docker inspect botconnector-platform-home \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

If no host source mount exists, use the compose labels/project working directory to identify the canonical source used to build `botconnector-platform-home`. Do not edit the running container filesystem as the canonical source.

**Acceptance:** baseline recorded; checkpoint exists; canonical platform-home source path is known; no product file changed.

---

### Task 2: Add central app-auth handoff and app-session primitives

**Files:**
- Create on central backend source: `app/app_auth.py`
- Modify: `app/main.py`
- Modify if needed for request/response models: `app/models.py`
- Test: `tests/test_app_auth.py` (create if backend test directory is absent)

**Interfaces:**
- Produces:
  - `create_app_handoff(user_id: str, state: str, client_id: str) -> tuple[str, str]` (opaque code, exact registered callback URL)
  - `consume_app_handoff(code: str, state: str, client_id: str) -> str` (callback is resolved server-side)
  - `create_app_session(user_id: str) -> tuple[str, AppSessionData]`
  - `resolve_app_session(token: str | None) -> AppSessionData | None`
  - `revoke_app_session(token: str | None) -> None`
- Redis keys:
  - `botconnector:app-handoff:<sha256(code)>`
  - `botconnector:app-session:<sha256(token)>`
- Registered callback configuration:
  - `botconnector-web` -> `https://app.botconnector.id/api/auth/callback`
  - `botconnector-web-preview` -> `https://app-preview.botconnector.id/api/auth/callback`
  - tests inject an isolated test callback mapping; no caller-provided callback is accepted.
- Dedicated app-auth service credential:
  - central backend reads `BOTCONNECTOR_APP_AUTH_INTERNAL_TOKEN_FILE`;
  - Web BFF reads the same mounted value from `BOTCONNECTOR_ACCOUNT_INTERNAL_TOKEN_FILE`;
  - header is exactly `X-BotConnector-App-Internal-Token`;
  - token is opaque, generated with at least 32 random bytes, and is never written to repository, image, browser config, URL, or logs;
  - Task 2 must not create or modify the production secret; tests use dummy credentials and temporary files only;
  - missing/unreadable/empty configuration fails closed;
  - do not reuse SmartBiz `X-Internal-Token`, central `bc_session`, `__Host-bc-app`, BFF→Rust secret, or future quota credential.

- [ ] **Step 1: Write unit tests for one-time handoff**

Tests must prove:
- HANDOFF-01 create produces an opaque non-empty code;
- HANDOFF-02 Redis key contains only SHA-256(code), and stored value never contains raw code;
- HANDOFF-03 Redis TTL is exactly 90 seconds;
- stored transaction contains canonical `user_id`, SHA-256 of state, exact symbolic `client_id`, resolved `callback_url`, audience, `issued_at`, and `expires_at`;
- HANDOFF-04 correct state/client/callback consumes successfully;
- HANDOFF-05 wrong state, HANDOFF-06 wrong client, HANDOFF-07 stored callback mismatch, and HANDOFF-08 expired code reject;
- HANDOFF-09 replay rejects because the first GETDEL/equivalent consumption is atomic;
- HANDOFF-10 rejected exchange creates no app session;
- CALLBACK-01 exchange request cannot choose `callback_url`; CALLBACK-02 client ID resolves callback server-side;
- CALLBACK-03 stored callback mismatch consumes then rejects; CALLBACK-04 arbitrary redirect URL cannot be introduced.

Use `unittest.mock` to mock `get_redis()`; do not add `fakeredis`.

- [ ] **Step 2: Implement handoff helpers**

Core shape:

```python
HANDOFF_TTL_SECONDS = 90
HANDOFF_AUDIENCE = "botconnector-web"
REGISTERED_CLIENT_CALLBACKS = {
    "botconnector-web": "https://app.botconnector.id/api/auth/callback",
    "botconnector-web-preview": "https://app-preview.botconnector.id/api/auth/callback",
}

def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

def create_app_handoff(user_id: str, state: str, client_id: str) -> tuple[str, str]:
    callback_url = REGISTERED_CLIENT_CALLBACKS[client_id]  # reject unknown client
    code = secrets.token_urlsafe(48)
    now = int(time.time())
    payload = {
        "user_id": user_id,
        "state_hash": _digest(state),
        "client_id": client_id,
        "callback_url": callback_url,
        "audience": HANDOFF_AUDIENCE,
        "issued_at": now,
        "expires_at": now + HANDOFF_TTL_SECONDS,
    }
    get_redis().setex(
        f"botconnector:app-handoff:{_digest(code)}",
        HANDOFF_TTL_SECONDS,
        json.dumps(payload, separators=(",", ":")),
    )
    return code, callback_url
```

Consumption must atomically consume the hashed-code key with Redis `GETDEL` (or equivalent) first. Then validate payload shape, expiry, state hash, audience, exact client ID, and the exact callback URL resolved from the server-side registry. Any mismatch rejects without creating a session, and the code remains consumed. Never store or log raw code. The platform-home browser entry accepts only a symbolic client ID; central configuration resolves the callback and returns it alongside the one-time code.

- [ ] **Step 3: Write unit tests for app sessions**

Tests must prove:
- SESSION-01 opaque session token is generated;
- SESSION-02 Redis key contains only SHA-256(token);
- SESSION-03 canonical user UUID is stored server-side;
- SESSION-04 valid session resolves;
- SESSION-05 expired session is rejected;
- SESSION-06 revoke invalidates the session;
- SESSION-07 malformed stored payload fails closed.

- [ ] **Step 4: Implement app-session helpers**

Use `secrets.token_urlsafe(48)` and existing `SESSION_TTL_SECONDS`.

```python
@dataclass(frozen=True)
class AppSessionData:
    user_id: str
    created_at: int
    expires_at: int
```

Do not reuse the browser `bc_session`; this is a distinct app session namespace. Session token is opaque; its value carries no identity or business data.

- [ ] **Step 5: Write failing app-auth route and service-auth tests**

Use FastAPI's existing test harness and dependency overrides where available. Use test-only dummy tokens and mocked Redis; never contact production Redis.

Prove:
- INTERNAL-AUTH-01 missing credential and INTERNAL-AUTH-02 wrong credential return 401/403;
- INTERNAL-AUTH-03 correct credential is accepted for exchange/resolve/revoke;
- INTERNAL-AUTH-04 verifier calls `secrets.compare_digest()` or equivalent constant-time comparator;
- INTERNAL-AUTH-05 raw service token is absent from captured logs and error responses;
- absent/unreadable/empty configured secret fails closed;
- INTERNAL-AUTH-06 `/handoffs` still depends on authenticated `CurrentUser` and existing `require_csrf`, not the service token;
- INTERNAL-AUTH-07 `/handoffs` derives `user_id` from `CurrentUser.id` and rejects/forbids a body `user_id`;
- ROUTE-01 handoff user ID is derived from authenticated `CurrentUser`; ROUTE-02 browser/request data cannot choose an arbitrary callback;
- ROUTE-03 raw code/session token/service token is absent from logs and errors;
- exchange accepts only `code`, `state`, and `client_id`; a body `callback_url` is rejected (for example, strict request-model extra-field validation) and cannot affect callback resolution;
- session resolve/revoke require the app-auth service credential.

**Test result before implementation:** run the focused tests and observe expected failures because the routes/helper are not implemented yet. Fix test-harness errors until the failures identify missing behavior.

- [ ] **Step 6: Implement focused app-auth service verification and routes**

Add exact responsibilities in `app/main.py`:

```text
POST /v1/app-auth/handoffs
POST /v1/app-auth/exchange
POST /v1/app-auth/session/resolve
POST /v1/app-auth/session/revoke
```

`/handoffs` requires the existing canonical central user session plus existing CSRF protection (`require_csrf`); it does not accept the app-auth service token as a substitute. Body fields are only `state` and `client_id`. Derive `user_id` from `CurrentUser.id`, resolve the callback from the registered client map, and return `{code, callback_url}`.

`/exchange` requires `X-BotConnector-App-Internal-Token`; body fields are only `code`, `state`, and `client_id` (no `callback_url`, with extra fields rejected). It atomically consumes the code first, resolves the expected callback server-side, and verifies all stored bindings before creating a new app session. Any mismatch rejects without creating a session. It returns only to the server-side caller:
```json
{
  "user_id": "<uuid>",
  "session_token": "<opaque>",
  "expires_at": 0
}
```

`/resolve` requires the app-auth service token, accepts the opaque app-session token server-to-server, and returns only canonical user UUID and non-secret session metadata.

`/revoke` requires the app-auth service token and deletes that app session immediately. These app-auth endpoints must not return the raw central browser `bc_session`.

Implement a focused reusable app-auth internal dependency/helper. Read the expected token from `BOTCONNECTOR_APP_AUTH_INTERNAL_TOKEN_FILE` and compare `X-BotConnector-App-Internal-Token` with `secrets.compare_digest()` (or equivalent). Do not reuse/generalize the SmartBiz guard. Missing/unreadable/empty secret configuration fails closed. Never log supplied or expected values.

The BFF will read the same mounted credential using `BOTCONNECTOR_ACCOUNT_INTERNAL_TOKEN_FILE`. Keep this credential distinct from the BFF→Rust Web gateway secret and from the future Rust→Cloud quota credential (`BOTCONNECTOR_QUOTA_INTERNAL_TOKEN_FILE`); Task 2 does not implement quota authentication.

- [ ] **Step 7: Run focused and existing backend tests**

Use the backend's existing Python environment/container. If the source image has no test runner command yet, run:

```bash
python -m pytest -q tests/test_app_auth.py
```

Expected: all app-auth tests PASS.

Also run the existing central-backend unit/regression suite in its available test environment. Inspect Task-2 diff and captured output for credentials/session/handoff values; test fixtures may contain only dummy values. Do not print secret values or contact production Redis/database.

**Acceptance:** handoff is atomic/single-use and exact-client-bound; app session is separate from `bc_session`; internal routes require the dedicated constant-time app-auth service credential; `/handoffs` still uses user+CSRF auth; failed exchange creates no session; raw codes/tokens/credentials are absent from logs.

---

### Task 3: Add Cloud quota persistence and central quota service

**Files:**
- Create: `migrations/cloud_free_v0_1_up.sql`
- Create: `migrations/cloud_free_v0_1_down.sql`
- Create: `app/cloud_quota.py`
- Modify: `app/main.py`
- Modify: `app/app_auth.py` (add the typed quota snapshot to session resolution)
- Test: `tests/test_cloud_quota.py`
- Update: `tests/test_app_auth.py` (keep Task 2 route tests isolated from quota persistence)

**Interfaces:**
- Produces:
  - `quota_status(user_id: str) -> QuotaStatus`
  - `reserve_quota(user_id: str, request_id: UUID, requested_tokens: int) -> QuotaReservation`
  - `settle_quota(user_id: str, request_id: UUID, input_tokens: int, output_tokens: int, provider: str, model: str, cost: Decimal | None) -> QuotaStatus`
  - `release_quota(user_id: str, request_id: UUID) -> None`
- Constant: `FREE_CLOUD_LIMIT_TOKENS = 100_000`
- Window: exact rolling `24 hours`.
- Reservation TTL: `CLOUD_QUOTA_RESERVATION_TTL_SECONDS = 7200`.
- `quota_status` returns `limit_tokens_24h`, `used_tokens_24h`, and `remaining_tokens_24h`; active reservations count for admission but are not displayed as used.

- [ ] **Step 1: Write migration**

`cloud_free_v0_1_up.sql`:

```sql
CREATE TABLE cloud_usage_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL UNIQUE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    model text NOT NULL,
    input_tokens integer NOT NULL CHECK (input_tokens >= 0),
    output_tokens integer NOT NULL CHECK (output_tokens >= 0),
    total_tokens integer NOT NULL CHECK (
        total_tokens >= 0
        AND total_tokens = input_tokens + output_tokens
    ),
    cost numeric NULL CHECK (cost IS NULL OR cost >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cloud_usage_events_user_window_idx
    ON cloud_usage_events (user_id, created_at DESC);

CREATE TABLE cloud_quota_subjects (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE cloud_quota_reservations (
    request_id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reserved_tokens integer NOT NULL CHECK (reserved_tokens > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > created_at)
);

CREATE INDEX cloud_quota_reservations_user_active_idx
    ON cloud_quota_reservations (user_id, expires_at);
```

Down migration drops reservation, subject, then usage tables.

- [ ] **Step 2: Write failing quota tests**

Cover QUOTA-01..QUOTA-18 from the spec, including rolling-window boundaries, rejection without a reservation, settlement after reservation expiry, idempotency, and active-reservation display/admission semantics. Run a real PostgreSQL concurrency test with two simultaneous 60000-token reservations for one subject; exactly one succeeds and total active reservations stays at or below 100000. Do not rely on a mocked cursor for this proof.

Cover AUTH-QUOTA-01..05 for the dedicated quota credential, including missing/wrong/correct dummy token, constant-time comparison, and secret-free errors/logs. Cover APP-SESSION-QUOTA-01..03: session resolve returns the read-only snapshot, continues to require the app-auth credential, and never receives the quota mutation credential.

Cover MIGRATION-01..03: apply UP, apply DOWN, then apply UP again in an ephemeral PostgreSQL 16 test database. Verify the quota router exposes only the three authenticated mutation routes; authenticated Search/Fetch remain outside this central token ledger and do not invoke these mutations (their request-path behavior is covered by the Rust Web route tests in Task 6). Never connect test code to production PostgreSQL or Redis.

- [ ] **Step 3: Implement quota service**

Admission transaction must:
1. `INSERT ... ON CONFLICT DO NOTHING` into `cloud_quota_subjects`;
2. `SELECT user_id ... FOR UPDATE`;
3. sum settled events where `created_at > now() - interval '24 hours'`;
4. sum unexpired reservations;
5. reject if `used + reserved + requested > 100000`;
6. insert reservation and commit.

- [ ] **Step 4: Add internal quota endpoints**

```text
POST /v1/cloud-quota/reserve
POST /v1/cloud-quota/settle
POST /v1/cloud-quota/release
```

Only these mutation routes exist; there is no `GET /v1/cloud-quota`. The Web UI reads its non-secret snapshot from `POST /v1/app-auth/session/resolve`, authenticated with the app-auth service credential. These mutation routes require `X-BotConnector-Quota-Internal-Token`, whose expected value is read from `BOTCONNECTOR_QUOTA_INTERNAL_TOKEN_FILE` and compared in constant time; missing/unreadable/empty configuration fails closed. This credential is distinct from SmartBiz, app-auth, browser sessions, and BFF→Rust authentication, and is provided only to the Rust Web Cloud gateway. Rust sends canonical `X-BotConnector-User-ID` and `X-BotConnector-Request-ID` values established by the trusted Web BFF; browser bodies/headers are not an identity source. Rust calls reserve/settle/release only for chat, embeddings, and rerank. Search/Fetch remain authenticated but do not call quota mutations or directly debit the AI-token ledger.

- [ ] **Step 5: Run migration against a disposable/test database and run tests**

Expected: up migration applies, tests pass, down migration reverses cleanly, up migration reapplies cleanly.

**Acceptance:** rolling window, reservation, idempotency, and over-quota rejection are proven in tests.

---

### Task 4: Add the central login handoff entry to platform-home

**Files:**
- Modify canonical platform-home source file corresponding to container `/app/app/main.py`
- Test in that project's existing test location or add a minimal route test

**Interfaces:**
- Consumes existing `current_user(request)`.
- Consumes central backend `/v1/app-auth/handoffs`.
- Produces browser entry:
  - `GET /app-login/start?state=<state>&client_id=botconnector-web|botconnector-web-preview`
- Redirect target is returned by the authenticated central handoff API after it resolves the symbolic client to its exact registered callback:
  - production `botconnector-web` -> `https://app.botconnector.id/api/auth/callback`
  - preview `botconnector-web-preview` -> `https://app-preview.botconnector.id/api/auth/callback`

- [ ] **Step 1: Write route tests**

Prove:
- missing/invalid state -> 400;
- unknown symbolic client -> reject;
- unauthenticated user -> existing `/login` flow using only the validated `app_client_id` and `app_state` continuation fields; these values travel through platform-home's internal login form/redirect hops and are validated on every hop;
- authenticated user -> central handoff created;
- callback URL is resolved centrally from the symbolic client; arbitrary callback query/body values are rejected;
- central handoff response returns its exact resolved callback URL and platform-home appends only code/state;
- code/state are not logged.

- [ ] **Step 2: Implement app-login state preservation**

Preserve the continuation only as `app_client_id` and `app_state` through platform-home's internal `/login` form and redirect. Validate the symbolic client ID against the two registered clients and validate `app_state` with `^[A-Za-z0-9_-]{32,128}$` on every hop. Render valid values as hidden escaped form inputs on `GET /login`; preserve them on failed login; after success redirect only to `/app-login/start?client_id=<encoded-client>&state=<encoded-state>`. Do not use a signed continuation cookie, arbitrary callback URL, `callback_url`, `redirect_uri`, `return_url`, or `next` parameter, and do not store identity or session material in the continuation.

- [ ] **Step 3: Implement authenticated handoff issuance**

After central authentication, call `/v1/app-auth/handoffs` under the existing authenticated central user session and CSRF contract, with only state and symbolic client ID. The backend derives user ID and resolves the callback. Redirect to the exact callback URL returned by central configuration. Exchange later receives only code + state + client ID; the backend atomically consumes the handoff, resolves the expected callback from its registered client configuration, and checks exact equality against the stored callback. The request never sends `callback_url`. A mismatch creates no app session and the consumed code cannot be replayed.

- [ ] **Step 4: Run platform-home tests**

Expected: authenticated and unauthenticated login paths both return to the exact app callback and preserve state.

**Acceptance:** existing central login remains authoritative; no cross-subdomain sharing of `bc_session`.

---

### Task 5: Turn `web/server.cjs` into the Web auth BFF

**Files:**
- Modify: `web/server.cjs`
- Modify: `web/web.test.cjs`

**Interfaces:**
- New endpoints:
  - `GET /api/auth/start?client_id=botconnector-web|botconnector-web-preview`
  - `GET /api/auth/callback`
  - `GET /api/auth/me`
  - `POST /api/auth/logout`
- Cookie: `__Host-bc-app`
- Trusted outbound headers:
  - `X-BotConnector-Internal-Auth` (secret loaded server-side from mounted file)
  - `X-BotConnector-User-ID`
  - `X-BotConnector-Request-ID` (server-generated UUID)
- Web gateway environment:
  - `BOTCONNECTOR_WEB_AUTH_REQUIRED=1`
  - `BOTCONNECTOR_WEB_BFF_SECRET_FILE=<mounted-secret-path>`
  - `BOTCONNECTOR_APP_CLIENT_ID=botconnector-web` in production or `botconnector-web-preview` in preview
- New route sets:
  - `publicRoutes`
  - `authenticatedCloudRoutes`
  - `tokenMeteredRoutes` (chat, embeddings, rerank only)

- [ ] **Step 1: Change tests first**

Update the existing assertion so:

```js
assert.equal(publicRoutes.has('/v1/chat/completions'), false);
assert.equal(authenticatedCloudRoutes.has('/v1/chat/completions'), true);
```

Add tests proving:
- anonymous `/v1/chat/completions` = 401 and upstream call count = 0;
- anonymous `/v1/models` remains allowed;
- local-management paths remain 404;
- forged incoming internal-auth, user-ID, and request-ID headers are stripped/replaced;
- authenticated proxy injects server-loaded internal secret, server-resolved canonical UUID, and generated request UUID;
- unauthenticated Search/Fetch are rejected before gateway call but authenticated Search/Fetch do not invoke token quota;
- `/api/auth/logout` rejects wrong Origin;
- callback sets a `__Host-bc-app` cookie with `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`.

- [ ] **Step 2: Add strict cookie utilities**

Implement minimal parser/setter in `web/server.cjs`; do not add a dependency.

Cookie output must be exactly host-only and opaque.

- [ ] **Step 3: Add central API helper**

Add an internal HTTP helper using env:

```text
BOTCONNECTOR_ACCOUNT_API_BASE=http://botconnector-backend-api:8050
BOTCONNECTOR_CENTRAL_LOGIN_URL=https://botconnector.id/app-login/start
BOTCONNECTOR_APP_ORIGIN=https://app.botconnector.id
BOTCONNECTOR_ACCOUNT_INTERNAL_TOKEN_FILE=/run/secrets/botconnector_app_auth_internal_token
BOTCONNECTOR_WEB_AUTH_REQUIRED=1
BOTCONNECTOR_WEB_BFF_SECRET_FILE=/run/secrets/botconnector_web_bff_secret
```

`BOTCONNECTOR_ACCOUNT_INTERNAL_TOKEN_FILE` supplies the dedicated app-auth credential for BFF calls to central exchange/resolve/revoke; it is distinct from `BOTCONNECTOR_WEB_BFF_SECRET_FILE`, which authenticates BFF→Rust. Read the app-auth token only server-side, never log it or include it in browser configuration, and fail closed if absent. Read and validate the Rust gateway secret at startup when Web auth is required. Never forward `__Host-bc-app` to arbitrary upstreams.

Store the pending handoff state server-side with its symbolic client ID and exact configured callback URL. The callback uses that stored transaction; it never trusts callback/client values supplied in the browser callback request. Exchange sends only code, state, and client ID; the central backend resolves the exact callback from its registered client configuration and compares it with the consumed transaction.

- [ ] **Step 4: Implement `/api/auth/start`**

Generate state with `crypto.randomBytes(32).toString('base64url')`.

Store state server-side through central Redis/backend or in a short-lived HttpOnly host-only state cookie whose value is only random state. Redirect to central login with exact URL.

- [ ] **Step 5: Implement callback**

Validate state, obtain the pending symbolic client ID from server-side transaction state, and call central exchange server-to-server using the dedicated app-auth token and body `{code,state,client_id}` (never send `callback_url`). Set `__Host-bc-app`, then issue `303 Location: /`.

Never return raw `session_token` in response body.

- [ ] **Step 6: Implement `/api/auth/me` and logout**

`/api/auth/me` resolves app session server-side and returns canonical UUID + current Cloud quota.

Logout revokes central app session then expires cookie.

- [ ] **Step 7: Split public and authenticated route policy**

Public:
```text
/v1/models
/api/botconnector/health
```

Authenticated Cloud:
```text
/v1/chat/completions
/v1/embeddings
/v1/rerank
/api/botconnector/web/search
/api/botconnector/web/fetch
```

These five routes require an authenticated Web session and the BFF-to-Rust trust envelope. Only chat, embeddings, and rerank are token-metered. Search/Fetch do not call reserve/settle and do not directly debit the 100K ledger. `/v1/models` and `/api/botconnector/health` stay public.

- [ ] **Step 8: Enforce origin for mutating browser requests**

For authenticated browser POSTs, require the exact configured `BOTCONNECTOR_APP_ORIGIN` and custom header:

```text
X-BotConnector-Web: 1
```

Use `Sec-Fetch-Site` only as additional defense.

- [ ] **Step 9: Run Web tests**

```powershell
node --test web/web.test.cjs
npm run check
```

Expected: all tests PASS.

**Acceptance:** anonymous Cloud provider call count remains zero; forged identity never reaches gateway.

---

### Task 6: Add quota reserve/settle integration to shared Rust core without breaking Desktop

**Files:**
- Create: `src/cloud_quota.rs`
- Modify: `src/main.rs` or module root to register module
- Modify: `src/serve.rs`
- Test: Rust tests adjacent to quota module / existing `serve.rs` test module

**Interfaces:**
- `BOTCONNECTOR_WEB_AUTH_REQUIRED=1` enforces the full internal-auth/user/request envelope on every protected Cloud route, including Search/Fetch.
- Quota reserve/settle is active only on chat, embeddings, and rerank after the trust envelope has been verified.
- When `BOTCONNECTOR_WEB_AUTH_REQUIRED` is absent or false, Desktop/local behavior remains unchanged.
- CORS is not an authentication or trust boundary.
- Internal account API base comes from `BOTCONNECTOR_ACCOUNT_API_BASE`.
- The BFF→Rust trust secret is read from `BOTCONNECTOR_WEB_BFF_SECRET_FILE` and is shared only by those two services.
- The Rust→Cloud quota API credential is read from `BOTCONNECTOR_QUOTA_INTERNAL_TOKEN_FILE`; it is distinct from the app-auth service token and the BFF→Rust secret. Task 6 must not reuse `BOTCONNECTOR_ACCOUNT_INTERNAL_TOKEN_FILE` or `BOTCONNECTOR_APP_AUTH_INTERNAL_TOKEN_FILE` for quota calls.

- [ ] **Step 1: Write Rust tests for header-bound quota mode**

Tests:
- for each protected route (chat, embeddings, rerank, search, fetch), Web auth required + missing internal secret -> rejected;
- wrong internal secret -> rejected on every protected route;
- valid secret + canonical user UUID + request UUID -> accepted;
- missing user UUID or request UUID, or malformed UUID values -> rejected;
- absent/false Web auth-required mode preserves Desktop/default behavior;
- authenticated Search/Fetch do not call quota reserve/settle;
- valid trusted envelope on chat/embeddings/rerank -> reserve called once;
- over-quota reserve response -> provider mock call count 0;
- provider error before generation -> release called once;
- embeddings reserve/settle counts input only and zero output;
- rerank reserve/settle counts query + document input and zero output.

- [ ] **Step 2: Implement `CloudQuotaClient`**

Interface:

```rust
pub struct CloudQuotaContext {
    pub user_id: uuid::Uuid,
    pub request_id: uuid::Uuid,
}

pub struct CloudQuotaReservation {
    pub reserved_tokens: u64,
}

pub struct CloudQuotaUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl CloudQuotaClient {
    pub async fn reserve(
        &self,
        ctx: &CloudQuotaContext,
        model: &str,
        requested_tokens: u64,
    ) -> Result<CloudQuotaReservation>;

    pub async fn settle(
        &self,
        ctx: &CloudQuotaContext,
        model: &str,
        provider: &str,
        usage: CloudQuotaUsage,
    ) -> Result<()>;

    pub async fn release(&self, ctx: &CloudQuotaContext) -> Result<()>;
}
```

- [ ] **Step 3: Extract trusted headers before body collection**

At protected route entry, extract and validate the internal-auth/user/request envelope before body collection. In `chat_completions()` read headers before:

```rust
let req_body = req.collect().await?.to_bytes();
```

The BFF strips client versions of all three internal headers before injection. In Web auth-required mode, direct Rust gateway calls missing the shared secret or canonical UUID envelope are rejected. In Desktop/default mode, requests keep legacy behavior.

- [ ] **Step 4: Reserve after model/request normalization and before provider invocation**

For chat, the current correct boundary is after:
- request body parsed;
- selected model resolved;
- `patch_messages()` applied;
- `ChatCompletionsData` constructed;

and immediately before current `if stream { ... }`.

Reservation estimates by operation:

```text
estimated_input = conservative server-side estimate of normalized messages + tools
requested_output = min(request max_tokens or model/default max, configured Free Cloud output ceiling)
requested_tokens = estimated_input + requested_output
```

Do not trust browser-supplied token counts.

For embeddings reserve conservative estimated normalized input only and settle input usage with output = 0. For rerank reserve conservative estimates for normalized query + documents only and settle that input usage with output = 0. Search and Fetch do not reserve token quota.

Apply the same pre-provider reservation and terminal-action discipline at the existing normalized request boundaries in `embeddings()` and `rerank()`. Use provider-reported usage when those route abstractions expose it; otherwise use conservative estimates from the normalized server-side input.

- [ ] **Step 5: Settle non-stream from actual `ChatCompletionsOutput`**

Current boundary is immediately after `chat_completions_inner()` returns and before response construction. Do not propagate any preparation/provider error with `?` after reservation in a way that bypasses cleanup. Use an explicit match: on success settle once with provider-reported usage where the current abstraction provides it (otherwise estimate conservatively server-side), then build `ret_non_stream(...)`; on any failure before generation release the reservation first, then return the error. Embeddings usage is input with output = 0; rerank usage is query + document input with output = 0.

- [ ] **Step 6: Settle streaming requests**

Current `ResEvent` does not expose token usage. For Phase 6B.2:
- accumulate normalized input estimate before dispatch;
- accumulate emitted assistant text/tool-call payload length during `ResEvent::Text` / `ResEvent::ToolCalls`;
- on `ResEvent::Done`, convert accumulated output through the server-side conservative estimator and settle exactly once;
- track whether any output started;
- count text and tool-call output as generation started;
- on task/provider failure or disconnect before first generated content, release exactly once before returning/closing;
- on stream error after partial generation, settle partial actual/estimated usage exactly once before finishing/erroring;
- on client disconnect after partial generation, settle partial usage exactly once;
- on successful stream, settle exactly once.

If a provider adapter already exposes actual streamed usage through the existing client abstraction during implementation, prefer that actual usage; otherwise estimator settlement is the approved fallback.

OpenRouter-specific provider responses already include final streaming usage, but this task must not make quota correctness depend on OpenRouter alone.

- [ ] **Step 7: Add idempotency test**

Ensure settle/release is tied to central unique `request_id`; every reservation reaches one terminal action and duplicate terminal attempts cannot double-settle or double-charge. The central terminal operation is transactional: settle atomically records the unique usage event and removes the active reservation; release removes the active reservation without a usage event. An already completed request ID cannot transition to a second terminal state or be charged twice.

- [ ] **Step 8: Run Rust suite**

```powershell
cargo test
cargo build
```

Expected: existing Web Search/Ollama fallback tests remain green and new quota tests pass.

**Acceptance:** route-specific usage is counted; post-reservation errors cannot skip cleanup; pre-generation failure releases once; partial stream error/disconnect settles partial usage once; successful stream settles once; duplicate terminal actions are idempotent; Desktop without Web auth-required mode remains unchanged.

---

### Task 7: Add login/quota UX while preserving Local AI

**Files:**
- Modify: `assets/botconnector/app.js`
- Modify: `assets/botconnector/index.html`
- Modify: `assets/botconnector/app.css`
- Modify: `web/build.cjs` only if build metadata/cache version must change
- Modify: `web/web.test.cjs`

**Interfaces:**
- Auth bootstrap: `GET /api/auth/me`
- Login: browser navigation to `/api/auth/start`
- Draft keys in `sessionStorage`:
  - `botconnector.cloudDraft`
  - `botconnector.cloudModel`
- No auth token/session/UUID stored in Web Storage.

- [ ] **Step 1: Add source-level UX tests**

Tests must verify generated Web bundle contains:
- exact CTA phrase `100K token Cloud AI gratis`;
- no auth/session secrets;
- draft uses `sessionStorage`;
- no code path auto-submits on callback/auth bootstrap.

- [ ] **Step 2: Bootstrap auth state**

On app load:
- call `/api/auth/me`;
- if authenticated show remaining/100K;
- if anonymous keep UI usable and Local AI untouched.

- [ ] **Step 3: Gate Cloud Send only**

Before existing Cloud send fetch:
- if anonymous, store draft + selected Cloud model in `sessionStorage`;
- show login CTA;
- do not invoke Cloud endpoint.

Local model/send path must not use this gate.

- [ ] **Step 4: Restore draft after authentication**

After `/api/auth/me` shows authenticated:
- restore draft/model;
- delete recovery keys after successful restoration;
- do not call Send.

- [ ] **Step 5: Add quota UI**

Use copy:

```text
Cloud Free
82.4K / 100K token tersedia
Dihitung secara rolling 24 jam
```

On quota exhaustion, show:

```text
Kuota Cloud gratis dalam periode 24 jam Anda sudah digunakan.
Local AI tetap dapat digunakan menggunakan perangkat Anda.
```

- [ ] **Step 6: Bump PWA shell cache version**

Change existing `botconnector-web-shell-v5` to the next version so deployed clients receive auth UX changes.

Update corresponding `web/web.test.cjs` expectation.

- [ ] **Step 7: Run Web build/tests**

```powershell
npm run web:build
npm run check
```

Expected: PASS.

**Acceptance:** anonymous user can explore/use Local; Cloud shows login incentive; returning login restores draft but never auto-sends.

---

### Task 8: Protect authenticated Web Search and Fetch routes

**Files:**
- Modify: `web/server.cjs`
- Tests: `web/web.test.cjs`
- Preserve: `src/serve.rs` Web Search provider logic

**Interfaces:**
- `/api/botconnector/web/search` and `/api/botconnector/web/fetch` require app auth.
- They require the BFF-to-Rust trust envelope but do not directly debit the 100K AI token ledger.
- Existing Ollama -> Exa fallback behavior is untouched.

- [ ] **Step 1: Add BFF tests**

Prove anonymous search/fetch:
- returns 401;
- does not hit gateway.

Authenticated search/fetch:
- is proxied normally;
- preserves response shape.

- [ ] **Step 2: Keep provider code unchanged**

Do not rewrite `web_search_with_providers()`, Ollama auth behavior, fallback rules, timeout behavior, or Exa fallback.

- [ ] **Step 3: Run existing Rust/Web Search tests**

```powershell
cargo test
npm run check
```

Expected: prior Web Search acceptance stays green.

**Acceptance:** authentication boundary changes; search/fetch do not create AI-token ledger events; search engine behavior does not change.

---

### Task 9: Local automated and integration acceptance

Task-9.1 adds server-only Search endpoint overrides for deterministic local
and staging harnesses: `BOTCONNECTOR_OLLAMA_WEB_SEARCH_URL` and
`BOTCONNECTOR_EXA_SEARCH_URL`. The production defaults remain the existing
Ollama and Exa HTTPS endpoints, and browser/request data cannot select these
endpoints. Explicit overrides are restricted to HTTPS or loopback HTTP and
fail closed when invalid.

**Files:** no product code unless a failing acceptance test reveals a scoped defect.

This task runs local automated/unit/integration acceptance. It does not require local HTTPS infrastructure or a real browser proving persistence of a Secure cookie over HTTP.

- [ ] **Step 1: Anonymous acceptance**

Verify:
- Web shell 200;
- `/v1/models` 200;
- Local AI works;
- Cloud chat 401 before provider;
- Web Search 401 before provider.

- [ ] **Step 2: Handoff acceptance**

Verify:
- fresh state every attempt;
- mocked central handoff/exchange verifies wrong state, expiry, single-use, exact symbolic client/callback binding, and mismatch rejection without session creation;
- local response `Set-Cookie` header has `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, and opaque value;
- unit test verifies callback removes `code`/`state` from the redirect target.

Real browser redirect/handoff, actual Secure `__Host-bc-app` persistence, cleaned callback URL, and logout-cookie expiry are verified on HTTPS staging in Task 10.

- [ ] **Step 3: Identity acceptance**

Verify `/api/auth/me` UUID exactly matches canonical `users.id`.

Attempt browser-supplied forged identity header and prove it is ignored.

- [ ] **Step 4: Quota acceptance**

With a disposable test user:
- initial remaining 100000;
- make non-stream request and verify exact usage debit;
- verify chat input + output, embeddings input-only, and rerank query+document input-only accounting;
- verify authenticated Search/Fetch do not directly debit token quota;
- pre-generation provider error releases exactly once;
- partial stream error settles partial usage exactly once;
- successful stream settles exactly once;
- client disconnect after partial output settles partial usage exactly once;
- duplicate terminal attempt cannot double-settle;
- duplicate request ID does not double charge;
- create near-limit fixture and verify next over-budget request calls provider zero times;
- age an event beyond 24h in test DB and prove it falls out of rolling window.

- [ ] **Step 5: UX acceptance**

Type draft before login, authenticate, verify draft restored and no automatic provider request occurs.

- [ ] **Step 6: Full regression**

```powershell
npm run check
cargo test
cargo build
```

Expected: all green.

**Acceptance:** every Phase 6B.2 acceptance item from the spec has evidence.

---

### Task 10A: Provision isolated preview central-account infrastructure

**Topology:**
- Keep `app-preview.botconnector.id` Web/Rust services unchanged.
- Add `account-preview.botconnector.id` -> preview platform-home on
  `127.0.0.1:18020`.
- Add preview backend on `127.0.0.1:18050`.
- Run preview PostgreSQL and Redis under Compose project
  `botconnector-preview-central` on private `preview_data` with no host
  ports; use a separate `preview_front` network for HTTP services.
- Never attach preview data services to `botconnector-core-net` or use
  production PostgreSQL, Redis, users, credentials, or persistence.

**Bootstrap gate:** establish a repository-owned fresh central schema
bootstrap before provisioning. If no canonical bootstrap exists, stop and
request an explicitly reviewed schema-only production read; do not run a
production dump or apply the Cloud migration to production.

**Deployment:** create versioned preview-only backend/platform-home images,
mount distinct app-auth, BFF/Rust, quota, PostgreSQL, Redis, and any required
session secrets as read-only files, apply the canonical schema and
`cloud_free_v0_1_up.sql` only to preview PostgreSQL, and prove loopback health
before any `account-preview.botconnector.id` Nginx/DNS change. Existing Web
preview services and their release rollback target remain available.

**Acceptance:** preview DB/Redis containers, volumes, host bindings, and
service endpoints are distinct from production; preview backend and
platform-home use only preview persistence; production services and routes
remain unchanged. Stop at the DNS/TLS gate or schema-bootstrap blocker.

### Task 10: Staging deployment, then production only after explicit approval

**Files/config:**
- Web First service/container environment
- mounted Web BFF/gateway shared secret file and `BOTCONNECTOR_WEB_AUTH_REQUIRED=1`
- one dedicated app-auth token file mounted into Web BFF and central backend under their respective `*_TOKEN_FILE` settings; never reuse the Rust gateway or future quota credential
- Central backend rebuilt image
- platform-home rebuilt image
- PostgreSQL migration
- reverse proxy only as required by existing deployment topology

**Interfaces:**
- Internal DNS: `botconnector-backend-api:8050` over `botconnector-core-net`
- Web BFF must be able to reach central backend internally.
- Rust/Web gateway must be internal-only behind Web BFF in the Web deployment.

- [ ] **Step 1: Build versioned images/artifacts without replacing production**

Use versioned tags; do not overwrite the currently running image tags.

- [ ] **Step 2: Apply migration to staging/test DB first**

Run up migration, smoke quota endpoints, then rollback/reapply to prove reversibility.

- [ ] **Step 3: Deploy to `app-preview.botconnector.id`**

Keep `botconnector.id` marketing/central login behavior unchanged except the new handoff entry.

- [ ] **Step 4: Run staging acceptance matrix**

At `https://app-preview.botconnector.id`, run real browser acceptance for:
- central login redirect and one-time handoff using `botconnector-web-preview` and its exact registered callback;
- Secure `__Host-bc-app` cookie persistence, cleaned callback URL, and logout-cookie expiry;
- Cloud authentication/quota behavior, including Web-mode direct Rust rejection without the BFF envelope;
- AUTH, IDENTITY, route-specific QUOTA, UX, SEARCH, LOGOUT, and REGRESSION checks from the spec.

Production promotion is blocked until this preview HTTPS acceptance passes. Do not create the production app hostname or promote production as part of this plan without separate explicit approval.

- [ ] **Step 5: Stop for explicit production approval**

Do not promote to `app.botconnector.id` or alter production routing until the user explicitly approves the staging evidence.

---

## Self-review

### Spec coverage
- Anonymous UI + Local AI: Tasks 5, 7, 9.
- Central identity/handoff: Tasks 2, 4, 5.
- Host-only app session: Tasks 2, 5.
- Rolling 100K quota: Tasks 3, 6.
- Authentication vs. token accounting: Task 5 gates all five protected Cloud routes; Tasks 3/6 meter only chat, embeddings, and rerank; Task 8 proves Search/Fetch do not directly debit the AI token ledger.
- Reservation/settlement/idempotency: Tasks 3, 6.
- BFF-to-Rust trust boundary: Tasks 5, 6.
- Exact symbolic-client callback binding: Tasks 2, 4, 5, 10.
- Draft/no auto-send: Task 7.
- Web Search auth without provider rewrite: Task 8.
- Logout/session revocation: Tasks 2, 5, 9.
- Production regression/deployment gate: Tasks 9, 10.

### Type/interface consistency
- Canonical `user_id` is UUID throughout.
- App session/handoff tokens are opaque strings; Redis keys store SHA-256 digests.
- `request_id` is UUID and unique in reservations/usage.
- Chat meters input + output; embeddings meter input only; rerank meters query + document input; Search/Fetch require authentication and do not directly meter AI tokens.

### Security checks
- No `.botconnector.id` cookie domain.
- No browser bearer token.
- No UUID inside app cookie.
- No raw handoff/session token logging.
- Exact callback URL only.
- Redis handoff is single-use.
- Quota is server-side and provider calls are blocked before overspend.
- Web auth-required mode validates a mounted internal secret in constant time plus canonical user/request UUIDs; CORS is not trusted for authentication.
- Every successful reservation reaches one idempotent terminal action; no post-reservation error propagation skips cleanup.
- Local Task 9 checks cookie attributes and mocked handoff; actual Secure cookie/browser flow is a required Task 10 HTTPS staging gate before production promotion.

## Execution handoff

Execution follows the user's current authorization: Task 1 is accepted; complete Task 2 only, then stop before Task 3. Preserve the accepted dirty canonical working tree in place; do not reset/clean or touch the separate MSIX directory.
