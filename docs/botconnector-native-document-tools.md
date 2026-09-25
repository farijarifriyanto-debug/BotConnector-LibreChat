# BotConnector native document tools

BotConnector's LibreChat deployment uses LibreChat's native file-search and code-execution paths for document work.

## Runtime contract

- Generic document uploads use `llmDeliveryPath: none` so large files are not injected wholesale into the model context.
- `textFallbackWithoutTools: true` remains enabled so a file can still fall back to extracted text when no compatible file tool is enabled.
- Native `file_search` handles retrieval/summarization over uploaded documents through the LibreChat RAG API.
- Native `execute_code` handles deterministic transformations such as DOCX/TXT to PDF through the BotConnector Code API.
- The Code API base URL is `http://127.0.0.1:18112/v1`.
- Code API authentication uses LibreChat-minted short-lived JWTs. Signing material is runtime-only and must never be committed.

## Safe environment template

The production environment must define these names with deployment-specific values:

```dotenv
LIBRECHAT_CODE_BASEURL=http://127.0.0.1:18112/v1
CODEAPI_AUTH_PROVIDER=librechat-jwt
CODEAPI_JWT_ENABLED=true
CODEAPI_JWT_ALGORITHM=EdDSA
CODEAPI_JWT_KID=<match-code-adapter>
CODEAPI_JWT_ISSUER=<match-code-adapter>
CODEAPI_JWT_AUDIENCE=<match-code-adapter>
CODEAPI_JWT_TTL_SECONDS=300
CODEAPI_JWT_MINT_CACHE_SECONDS=30
CODEAPI_JWT_SINGLE_TENANT_ID=legacy
CODEAPI_JWT_PRIVATE_KEY_BASE64=<runtime-secret>
```

The private key value belongs only in the protected production environment.

## OpenSandbox dependency

The code adapter runs office conversion inside OpenSandbox. The Docker runtime `runsc-poc` currently resolves to `/home/botadmin/gvisor-poc/runsc`. Do not treat that directory as disposable build output while Docker or OpenSandbox still references it.

The production runtime restored on 2026-09-25 is the official gVisor `release-20260921.0` x86_64 bundle, verified against the release SHA256SUMS.

## Acceptance checks

A deployment is ready only when all of these pass:

1. LibreChat and the RAG API are healthy.
2. `GET http://127.0.0.1:18112/health` reports the OpenSandbox/gVisor code adapter UP.
3. A JWT-authenticated Code API execution returns `42` for a simple Python smoke test.
4. A DOCX uploaded to Code API can be converted by LibreOffice inside the sandbox and returns a generated PDF file reference.
5. A DOCX uploaded through LibreChat with `tool_resource=file_search` is stored with `embedded: true`.
6. A RAG query against that file id returns a matching document chunk.
7. Smoke-test files are deleted after validation.
