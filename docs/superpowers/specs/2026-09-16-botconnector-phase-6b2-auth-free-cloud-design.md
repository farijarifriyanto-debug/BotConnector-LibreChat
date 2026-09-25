# Phase 6B.2 — BotConnector Web First Central Auth + Free Cloud 100K Design

**Date:** 2026-09-16  
**Status:** Approved design with Phase 6B.2 contract decisions incorporated  
**Scope:** `BotConnector-AIChat` Web First + existing BotConnector central account  
**Canonical identity:** `users.id` UUID  
**Implementation status:** Not started

## 1. Product decisions

- Anonymous visitors may open and explore `app.botconnector.id`.
- Local AI remains usable without BotConnector login.
- Cloud AI execution requires BotConnector login.
- Login activates **100,000 AI inference tokens per rolling 24 hours**.
- Quota is token-based, not message-count-based. Authentication and token metering are separate policies: authenticated Cloud features do not necessarily debit the AI token ledger.
- Chat accounts input + output tokens; embeddings account input tokens; rerank accounts query + document input tokens. Embeddings and rerank have zero output tokens.
- Use provider-reported actual usage where the current abstraction provides it; otherwise use a conservative server-side estimator.
- Returning from login restores the prompt draft but **must not auto-send** it.
- The user explicitly clicks Send again after authentication.
- BotConnector central account remains the only account/identity authority.
- The app must not create a second user-account system.
- Canonical user identity is the existing `users.id` UUID.
- Existing Ollama Web Search behavior and Local Core behavior must remain unchanged except where Cloud authentication/quota enforcement explicitly applies.

## 2. Current proven state

- `botconnector-backend-api` is restored and healthy.
- PostgreSQL and Redis are healthy from the central backend.
- Central login succeeds.
- `/v1/me` and `/v1/me/products` succeed for an authenticated central session.
- `botconnector-platform-home` `/api/auth/check` returns authenticated state.
- `X-BotConnector-User-ID` is sourced from `current_user()["id"]`.
- `users.id` is PostgreSQL `uuid`.
- The UUID emitted by the platform authentication boundary exists in canonical `users.id`.

Identity proof is complete for this design.

## 3. Architecture

```text
Browser
  |
  v
app.botconnector.id
  |
  | Web BFF auth/session boundary
  v
BotConnector Cloud gateway
  |
  v
Cloud providers

Local AI:
Browser -> Local Core 127.0.0.1:18764
No BotConnector account required.
```

### Preview central isolation

Preview HTTPS acceptance must use an isolated central-account stack. The
existing `app-preview.botconnector.id` Web/Rust services remain in place;
preview account traffic is served by `account-preview.botconnector.id` and
separate preview platform-home, backend, PostgreSQL, and Redis services under
the Compose project `botconnector-preview-central`. Preview PostgreSQL and
Redis use private `preview_data` storage with no host ports and are never
attached to `botconnector-core-net`. Preview backend/platform-home use
preview-only configuration and mounted secrets; production central
persistence, users, credentials, and services are never used for preview
tests.

Central identity remains:

```text
botconnector.id
  |
  v
platform-home / central account
  |
  v
botconnector-backend-api
  |
  +-- PostgreSQL canonical users.id UUID
  +-- Redis session/handoff state
```

Anonymous users may load the Web shell, inspect Cloud models, type prompts, and use Local AI. Cloud inference, Web Search, and Web Fetch require an authenticated Web session. Only token-consuming AI inference routes debit the 100K token ledger; Search and Fetch do not directly debit it.

CTA:

> **100K token Cloud AI gratis**  
> Masuk dengan akun BotConnector untuk mengaktifkan akses Cloud. Local AI tetap dapat digunakan tanpa login.

## 4. Central login handoff

Do not widen the existing `bc_session` cookie to `.botconnector.id`.

Use a first-party authorization-code-like handoff:

```text
1. GET https://app.botconnector.id/api/auth/start?client_id=botconnector-web
2. App BFF creates fresh random state.
3. Draft/UI state is preserved in sessionStorage.
4. Redirect to exact central login/handoff URL.
5. Existing central `bc_session` is verified, or user logs in.
6. Central backend creates opaque one-time handoff code.
7. Handoff TTL: 90 seconds.
8. Resolve the symbolic client server-side and bind the handoff to user UUID, state hash, client ID, exact callback URL, audience, issue time, and expiry.
9. Redirect only to the exact callback registered for that client.
10. App BFF validates state.
11. App BFF atomically exchanges/consumes code.
12. App BFF creates fresh app-specific opaque session.
13. Set `__Host-bc-app`.
14. Redirect back to clean app URL.
15. Restore draft.
16. Do not auto-send.
```

Registered clients and exact callbacks:

```text
botconnector-web         -> https://app.botconnector.id/api/auth/callback
botconnector-web-preview -> https://app-preview.botconnector.id/api/auth/callback
```

The browser may select only a registered symbolic client ID; it cannot submit a callback URL. Tests may inject a dedicated callback configuration. Handoff creation resolves the exact callback server-side. Exchange accepts only code, state, and client ID; the backend resolves the expected callback URL from that client and compares it with the stored transaction. Any mismatch rejects without creating an app session. GETDEL consumes the code before binding checks, so all failed/mismatched exchanges also consume it.

Logical handoff state:

```text
botconnector:app-handoff:<sha256(code)>
  user_id
  state_hash
  client_id
  callback_url
  audience
  issued_at
  expires_at
```

Consumption must be single-use and atomic. Redis `GETDEL` is suitable if represented as one string value; an equivalent transaction/script is acceptable if needed.

Redirect rules:
- exact callback matching;
- no arbitrary `return_url`;
- internal return path allowlist only;
- no open redirect;
- never log handoff codes;
- unpredictable transaction-specific `state`.

## 5. App session

Cookie:

```text
Set-Cookie: __Host-bc-app=<opaque-random-id>;
            Secure;
            HttpOnly;
            SameSite=Lax;
            Path=/
```

Rules:
- no `Domain`;
- token is opaque;
- no UUID/email/role/quota in cookie;
- server-side expiry is authoritative;
- logout revokes server session and expires browser cookie;
- issue a fresh session after authentication.

Logical state:

```text
botconnector:app-session:<sha256(session_token)>
  user_id
  created_at
  expires_at
```

Session identifier must be CSPRNG-generated with at least 128 bits of entropy.

## 6. Web BFF endpoint contract

### `GET /api/auth/start?client_id=...`
- create fresh auth state;
- accept only `botconnector-web` or `botconnector-web-preview`;
- preserve only allowlisted internal return path;
- persist state server-side with short TTL;
- redirect to central login/handoff with the symbolic client ID; never send a browser-selected callback URL.

### `GET /api/auth/callback?code=...&state=...`
- validate state;
- retrieve the pending symbolic client ID from the BFF's server-side state and atomically exchange only code + state + client ID; the central backend resolves and checks the exact callback URL itself;
- reject expired/replayed/mismatched code;
- do not create an app session on any mismatch;
- obtain canonical UUID;
- create app session;
- set `__Host-bc-app`;
- redirect to clean URL without code/state.

### `GET /api/auth/me`

Example:

```json
{
  "authenticated": true,
  "user": { "id": "<canonical-uuid>" },
  "cloud": {
    "limit_tokens_24h": 100000,
    "used_tokens_24h": 17600,
    "remaining_tokens_24h": 82400
  }
}
```

### `POST /api/auth/logout`
- CSRF/origin checks;
- revoke server-side app session;
- expire `__Host-bc-app`;
- do not leak token values.

## 7. Central backend endpoint responsibilities

Names may follow existing conventions, but responsibilities are fixed.

### App-auth internal service credential

Use a dedicated Web BFF → central app-auth credential, distinct from `bc_session`, `__Host-bc-app`, the BFF → Rust gateway secret, and any future quota credential. The central backend reads `BOTCONNECTOR_APP_AUTH_INTERNAL_TOKEN_FILE`; the Web BFF reads the same mounted secret via `BOTCONNECTOR_ACCOUNT_INTERNAL_TOKEN_FILE`. The value is a random opaque secret with at least 32 random bytes, never stored in source, an image, browser configuration, URL, or logs. Missing configuration fails closed. Verify the exact `X-BotConnector-App-Internal-Token` header with `secrets.compare_digest()` or an equivalent constant-time comparison. Do not reuse or generalize the SmartBiz `X-Internal-Token` guard.

### `POST /v1/app-auth/handoffs`
Requires the existing canonical central user session and existing CSRF protection (`require_csrf`); it does not use the app-auth service credential. The body contains only `state` and a registered symbolic `client_id`; never accept `user_id` or a callback URL. Derive the user from `CurrentUser.id`, resolve the exact callback server-side, and create a one-time code bound to user UUID, state hash, client ID, callback URL, audience, issued_at, expires_at, and short TTL. It returns the opaque code and resolved callback URL for platform-home to redirect to.

### `POST /v1/app-auth/exchange`
Requires `X-BotConnector-App-Internal-Token`. The body contains only `code`, `state`, and `client_id`; it does not accept `callback_url`. Atomically consume the hashed-code key with GETDEL/equivalent first, then validate code existence, expiry, state hash, audience, client ID, and exact callback URL resolved server-side from the client registry against the stored transaction. Any mismatch rejects and creates no app session; failed/mismatched exchanges consume the code. Return canonical UUID plus an opaque app-session token only to the BFF, never to the browser.

### `POST /v1/app-auth/session/resolve`
Requires `X-BotConnector-App-Internal-Token`. Resolve the submitted app-session token server-side and return canonical `user_id` UUID, non-secret session metadata, and a read-only quota snapshot:

```json
{
  "cloud": {
    "limit_tokens_24h": 100000,
    "used_tokens_24h": 0,
    "remaining_tokens_24h": 100000
  }
}
```

The BFF uses the app-auth credential for this read. It does not receive the quota-mutation credential. Never return or expose the central browser `bc_session`.

### `POST /v1/app-auth/session/revoke`
Requires `X-BotConnector-App-Internal-Token`. Delete/invalidate the submitted app session immediately.

The app-auth service credential is exclusively for the Web BFF and central app-auth endpoints. Cloud quota mutation endpoints use a separate mounted credential at `BOTCONNECTOR_QUOTA_INTERNAL_TOKEN_FILE` and the exact `X-BotConnector-Quota-Internal-Token` header, verified server-side with constant-time comparison. Only the Rust Web Cloud gateway calls those mutation endpoints. Missing configuration fails closed. Do not reuse the SmartBiz token, app-auth credential, central or app browser session, or BFF → Rust credential.

## 8. Cloud quota design

```text
limit = 100000 total tokens
window = rolling 24 hours
accounting = route-specific AI token usage
message_count_limit = none
subject = canonical users.id UUID
CLOUD_QUOTA_RESERVATION_TTL_SECONDS = 7200
```

The 7200-second reservation TTL limits stale/crashed requests; it is separate from the rolling 24-hour user usage window.

Quota coverage:

| Route | Authentication required | 100K AI token ledger | Accounted usage |
|---|---:|---:|---|
| `/v1/chat/completions` | yes | yes | input + output |
| `/v1/embeddings` | yes | yes | input; output = 0 |
| `/v1/rerank` | yes | yes | query + document input; output = 0 |
| `/api/botconnector/web/search` | yes | no direct debit | no AI-token debit |
| `/api/botconnector/web/fetch` | yes | no direct debit | no AI-token debit |

Authentication gates access to each protected Cloud route. Token metering applies only to the three token-consuming AI inference routes above. Search and Fetch remain server-side authenticated Cloud features; their resource controls are separate from this 100K token ledger.

The Web UI reads `limit_tokens_24h`, `used_tokens_24h`, and `remaining_tokens_24h` through the authenticated `POST /v1/app-auth/session/resolve` response, whose caller uses the app-auth credential. Do not add a public/general quota-status endpoint. Quota mutation is limited to `POST /v1/cloud-quota/reserve`, `/settle`, and `/release`; these require the dedicated quota credential and trusted Rust caller identity/request-ID headers. Outstanding reservations reduce admission capacity but are excluded from displayed `used_tokens_24h`.

Persistent ledger:

```sql
cloud_usage_events
------------------
id                 uuid primary key
request_id         uuid unique not null
user_id            uuid not null references users(id)
provider           text not null
model              text not null
input_tokens       integer not null
output_tokens      integer not null
total_tokens       integer not null
cost               numeric null
created_at         timestamptz not null

index (user_id, created_at)
```

Reservation table:

```sql
cloud_quota_reservations
------------------------
request_id         uuid primary key
user_id            uuid not null references users(id)
reserved_tokens    integer not null
created_at         timestamptz not null
expires_at         timestamptz not null
```

Admission before provider call on each token-metered route:

```text
BEGIN
lock quota subject
used = settled total tokens from last 24h
reserved = unexpired outstanding reservations
requested = conservative estimated route input + configured maximum output (chat only)

if used + reserved + requested > 100000:
    reject before provider call
else:
    create reservation
COMMIT
```

Settlement:
1. use provider-reported actual usage where the current abstraction provides it;
2. otherwise use a conservative server-side estimator;
3. chat records input + output, embeddings records input + zero output, and rerank records query + document input + zero output;
4. after reservation succeeds, every path performs exactly one terminal action: success settles actual/estimated usage; failure before generation releases before returning the error; partial stream failure or client disconnect settles partial actual/estimated usage before ending;
5. a unique `request_id` makes terminal actions idempotent and prevents double settlement/charge.

No provider call after reservation may use an early `?`/propagation path that bypasses release or settlement. Non-stream provider errors explicitly release before returning. Streaming tracks whether output began and guarantees exactly one release-or-settle action.

Rolling semantics:

```text
SUM(total_tokens)
WHERE user_id = current_user
  AND created_at > now() - interval '24 hours'
```

This is not a midnight reset.

## 9. Route enforcement

Public:
```text
/api/botconnector/health
/v1/models
static Web shell
auth start/callback/me as appropriate
```

Authenticated Cloud routes (authentication is required, but token metering depends on route):
```text
/v1/chat/completions
/v1/embeddings
/v1/rerank
/api/botconnector/web/search
/api/botconnector/web/fetch
```

100K token-metered AI inference routes:
```text
/v1/chat/completions   input + output
/v1/embeddings         input only; output = 0
/v1/rerank             query + document input; output = 0
```

Web Search and Web Fetch require authentication but do not directly debit the AI token ledger.

Local Core remains outside Cloud policy.

The BFF must remove client-supplied `X-BotConnector-Internal-Auth`, `X-BotConnector-User-ID`, and `X-BotConnector-Request-ID`, resolve the app session server-side, and then inject a server-loaded internal secret, canonical user UUID, and generated request UUID. CORS is not an authentication boundary.

In Web deployment set `BOTCONNECTOR_WEB_AUTH_REQUIRED=1` and mount the shared BFF/gateway secret at the path in `BOTCONNECTOR_WEB_BFF_SECRET_FILE`. Both services read the secret server-side; it is never included in browser-visible configuration or logs. Web startup fails closed if auth is required and the secret file is missing, unreadable, or empty. Rust must reject protected Cloud routes unless the internal secret matches in constant time and valid canonical user and request UUIDs are present. Protected routes are chat, embeddings, rerank, search, and fetch. `/v1/models` and `/api/botconnector/health` remain public. When `BOTCONNECTOR_WEB_AUTH_REQUIRED` is absent or false, Desktop/local behavior remains unchanged.

## 10. CSRF/request-origin policy

For authenticated mutating requests:
- require the exact configured Web `Origin` (`https://app.botconnector.id` in production or `https://app-preview.botconnector.id` in preview); never trust a wildcard;
- require a dedicated custom Web request header;
- use `Sec-Fetch-Site` as defense-in-depth;
- reject obvious cross-site requests;
- do not rely on SameSite alone.

## 11. Client UX

Anonymous Cloud Send:
1. do not call provider;
2. save draft/minimal UI state in `sessionStorage`;
3. show 100K free-token login CTA;
4. allow Login or Cancel.

After login:
- restore draft and safe model selection;
- refresh `/api/auth/me`;
- show quota;
- **never auto-send**;
- require explicit Send.

Quota UI:
```text
Cloud Free
82.4K / 100K token tersedia
Dihitung secara rolling 24 jam
```

Quota exhausted:
> Kuota Cloud gratis dalam periode 24 jam Anda sudah digunakan. Local AI tetap dapat digunakan menggunakan perangkat Anda.

Do not call Local AI universally unlimited; practical capacity depends on hardware/runtime.

## 12. Source mapping

### `web/server.cjs`
Add:
- app auth endpoints;
- cookie parsing/setting;
- auth middleware;
- stripping of all client-supplied internal-auth, user-ID, and request-ID headers;
- server-side internal secret loading and trusted secret/canonical identity/generated request-ID injection;
- CSRF/origin checks;
- Cloud route policy split.

### `assets/botconnector/app.js`
Add:
- auth bootstrap via `/api/auth/me`;
- Cloud-vs-Local Send policy;
- login CTA;
- draft persistence/restoration;
- quota display;
- no-auto-send behavior.

### `src/serve.rs`
Add/integrate:
- Web-mode trust enforcement on protected Cloud routes using `BOTCONNECTOR_WEB_AUTH_REQUIRED` and the mounted secret file; constant-time secret comparison plus valid canonical user/request UUIDs;
- quota reserve before provider call for chat, embeddings, and rerank only;
- route-specific actual/estimated usage settlement;
- exactly-once release or settlement on every post-reservation path, including early provider error, partial stream, and disconnect;
- idempotent request ID handling.

Preserve existing Ollama-first Web Search + Exa fallback behavior.

### Central backend
Add only the minimal handoff/session/quota responsibilities above following existing project conventions.

## 13. Explicit non-goals

Do not:
- create a second account database;
- share `bc_session` across all subdomains;
- use a browser JWT as canonical identity;
- put UUID into app session cookie;
- store auth tokens in localStorage/sessionStorage;
- create anonymous 100K quota;
- use IP as product identity;
- alter Local Core auth semantics;
- redesign desktop/MSIX;
- rewrite existing Web Search provider behavior;
- do unrelated refactors.

## 14. Acceptance criteria

```text
AUTH-01  anonymous app shell opens
AUTH-02  anonymous Local AI works
AUTH-03  anonymous model discovery works
AUTH-04  anonymous Cloud inference blocked
AUTH-05  blocked anonymous Cloud calls provider 0x

AUTH-06  CTA advertises 100K Cloud tokens after login
AUTH-07  auth start creates fresh unpredictable state
AUTH-08  existing central account login works
AUTH-09  callback state mismatch rejected
AUTH-10  handoff expiry enforced
AUTH-11  handoff replay rejected
AUTH-12  callback URL cleaned after exchange

AUTH-13  app cookie has Secure
AUTH-14  app cookie has HttpOnly
AUTH-15  app cookie has Path=/
AUTH-16  app cookie has no Domain
AUTH-17  app cookie contains no UUID/email/quota

IDENTITY-01 /api/auth/me resolves canonical UUID
IDENTITY-02 UUID matches users.id
IDENTITY-03 forged client identity header ignored

QUOTA-01 eligible authenticated subject has 100000-token window
QUOTA-02 no message-count hard cap
QUOTA-03 chat input usage counted
QUOTA-04 chat output usage counted
QUOTA-05 actual provider usage settled
QUOTA-06 streamed final usage settled
QUOTA-07 rolling 24h behavior correct
QUOTA-08 reservations prevent concurrent overspend
QUOTA-09 exhausted quota calls provider 0x
QUOTA-10 pre-generation failure releases the reservation with zero usage
QUOTA-11 duplicate request_id does not double-charge
QUOTA-12 embeddings input usage counted; output usage is zero
QUOTA-13 rerank query + document input usage counted; output usage is zero

UX-01 draft survives login
UX-02 callback never auto-sends
UX-03 explicit Send required after login
UX-04 quota remaining visible

SEARCH-01 anonymous Web Search and Fetch are blocked before gateway/provider calls
SEARCH-02 authenticated Web Search works and does not directly debit the 100K AI token ledger
SEARCH-03 existing Ollama->Exa fallback unchanged
SEARCH-04 authenticated Web Fetch works and does not directly debit the 100K AI token ledger

TRUST-01 Web auth-required mode rejects protected Cloud routes without internal secret
TRUST-02 Web auth-required mode rejects wrong internal secret
TRUST-03 valid internal secret + canonical user UUID + request UUID is accepted
TRUST-04 BFF replaces forged browser internal-auth/user/request headers
TRUST-05 Desktop/default mode remains backward-compatible when Web auth is not required
TRUST-06 missing or malformed canonical user/request UUID is rejected in Web auth-required mode

HANDOFF-01 symbolic client resolves to its exact registered callback
HANDOFF-02 arbitrary callback URL is rejected
HANDOFF-03 code/state/client/callback mismatch creates no app session
CALLBACK-01 exchange body cannot choose callback_url
CALLBACK-02 client_id resolves callback server-side
CALLBACK-03 stored callback mismatch consumes/rejects handoff
CALLBACK-04 arbitrary redirect URL cannot be introduced

INTERNAL-AUTH-01 missing app-auth service token rejected
INTERNAL-AUTH-02 wrong service token rejected
INTERNAL-AUTH-03 correct service token accepted
INTERNAL-AUTH-04 comparison uses a constant-time helper
INTERNAL-AUTH-05 raw service token absent from logs/errors
INTERNAL-AUTH-06 /handoffs still requires user + CSRF
INTERNAL-AUTH-07 /handoffs never accepts body user_id

QUOTA-14 pre-generation provider error releases reservation exactly once
QUOTA-15 partial stream error settles partial usage exactly once
QUOTA-16 successful stream settles exactly once
QUOTA-17 duplicate terminal action for request_id cannot double-settle

LOGOUT-01 logout revokes server-side app session
LOGOUT-02 logout expires browser cookie
LOGOUT-03 Cloud request after logout blocked

REGRESSION-01 Local Core unchanged
REGRESSION-02 desktop behavior unchanged
REGRESSION-03 MSIX working directory untouched
REGRESSION-04 existing Web Search tests green
REGRESSION-05 secrets/session/handoff codes absent from logs
```

## 15. Security basis

This design follows:
- RFC 9700: exact redirect URI matching and no open redirectors.
- MDN: `__Host-` cookie uses Secure, no Domain, Path=/.
- OWASP Session Management: opaque random session IDs, server-side state, CSPRNG, regeneration after authentication, server-side expiry/revocation.
- OWASP CSRF Prevention: SameSite is defense-in-depth; Origin/Fetch Metadata/custom-header controls add protection.
- Redis GETDEL: atomic retrieve-and-delete for one-time string handoff.
- OpenRouter usage accounting: streamed responses can expose prompt/completion/total token usage for settlement.

## 16. Proven implementation conventions

The current source audit establishes:
1. Central Redis/session helpers are `app/cache.py:get_redis()`, `app/security.py`, and `app/dependencies.py`.
2. Central sessions use opaque tokens, Redis `SETEX`, and PostgreSQL `account_sessions`; app sessions use a separate Redis namespace.
3. Migrations are paired `migrations/<feature>_up.sql` and `_down.sql` files.
4. The Web BFF tests use `web/web.test.cjs` with `node:test`.
5. `src/serve.rs` routes chat to `chat_completions()`; reserve is before the provider branch after normalization, non-stream terminal handling is after `chat_completions_inner()`, and streaming currently exposes Text/ToolCalls/Done without a generic usage event.
6. The non-stream chat abstraction exposes input/output token usage. Embeddings and rerank route usage must be verified against their current provider abstractions during implementation; use conservative server-side estimates when actual usage is unavailable.
7. Runtime deployment wiring and mounted secret paths are environment-specific and must be set for staging in Task 10 without exposing secret values.

Task 1 re-verifies the canonical checkout and resolves the platform-home source path read-only. Runtime secret mount paths are deployment configuration for Task 10 and must not be guessed or committed.

## 17. Implementation gate

This approved design is implemented by `docs/superpowers/plans/2026-09-16-botconnector-phase-6b2-auth-free-cloud-implementation.md`. Task 1 records and checkpoints the current dirty baseline before any product-source edits. Local implementation and automated acceptance precede HTTPS preview acceptance. Production promotion remains blocked until preview HTTPS acceptance passes and receives separate explicit approval. No commit or push is authorized by this document.
