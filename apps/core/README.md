# Canvas MCP service

An invite-only, read-only gateway from one Hanyang HY-ON Canvas account to an authenticated remote MCP client. It uses Canvas REST APIs rather than browser automation and never asks for a campus username or password.

The service has three public surfaces:

- A small account site at `/`, `/setup`, `/login`, `/account`, `/privacy`, and `/terms`.
- A streamable HTTP MCP endpoint at `/mcp`.
- OAuth 2.1 metadata and endpoints used by remote MCP clients.

## Policy gate

The current Instructure Canvas API Policy (effective August 12, 2025) lists access through MCP servers or other technologies not approved by Instructure as a prohibited use. Building and deploying this private pilot does not supply that approval. Do not issue production invitations or connect real student PATs until Instructure and the relevant institution have approved the integration. See [Instructure API Policy](https://www.instructure.com/policies/canvas-api-policy).

## Security model

- Enrollment requires a single-use invitation bound to Hanyang. This private release enforces exactly one connected owner at the database layer because the linked Lecture archive is also single-owner.
- The user supplies a Canvas personal access token (PAT) over HTTPS. The browser sends it only in a POST body and does not persist it in URL state, cookies, `localStorage`, or `sessionStorage`.
- The server validates the PAT against the invitation's fixed Canvas host, encrypts it with `MASTER_KEY_BASE64`, and stores only the encrypted value.
- Account sign-in uses WebAuthn passkeys. Only public-key credential material is stored; the authenticator private key never reaches the server.
- MCP clients use authorization code + PKCE. Access tokens are short-lived and scoped to `canvas.read`; enabling the private Lecture integration additionally requires `lecture.read`. Refresh tokens are rotated or revoked by the server implementation.
- Canvas endpoints and redirect targets are allowlisted. Never follow a Canvas redirect to another host while retaining the `Authorization` header.
- The MCP tool surface is read-only. Tool results mark course-authored content as untrusted data, not instructions.

Read [SECURITY.md](./SECURITY.md) before operating the service outside localhost.

## Requirements

- Node.js 22 or later and npm.
- A persistent SQLite volume.
- A stable HTTPS origin for production. WebAuthn will not work on an insecure non-localhost origin.
- A reverse proxy that preserves the original HTTPS scheme and client address according to the configured `TRUST_PROXY` hop count.

## Configuration

Configuration is read from environment variables. Secret values belong in a deployment secret store or an untracked, access-restricted `.env` file; never commit them.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PUBLIC_ORIGIN` | yes | none | Bare public origin, such as `https://study.siyidu.com`; no path, query, or credentials. |
| `MASTER_KEY_BASE64` | yes | none | Canonical base64 for exactly 32 random bytes; encrypts stored Canvas PATs. |
| `WEBAUTHN_RP_ID` | yes | none | WebAuthn relying-party domain, normally `study.siyidu.com`; v1 requires an exact match with the public host. |
| `PORT` | no | `8794` | Internal HTTP listener. |
| `DATABASE_PATH` | no | `./data/canvas.sqlite` | SQLite path; use `/data/canvas.sqlite` in the example container. |
| `WEBAUTHN_RP_NAME` | no | `Study` | Human-readable name shown in passkey prompts. |
| `TRUST_PROXY` | no | `1` | Number of trusted reverse-proxy hops. Use `0` only with no proxy. |
| `COOKIE_SECURE` | no | `true` | Keep `true` in production; localhost HTTP development may use `false`. |
| `LOG_LEVEL` | no | `info` | One of `debug`, `info`, `warn`, or `error`. Debug logging still must redact secrets. |
| `STUDY_SERVICE_TOKEN` | yes | none | Dedicated bearer secret accepted only by the internal Lecture course-catalog endpoint. Use at least 32 random characters. |
| `LECTURE_API_URL` | no | empty | Exact HTTPS origin for the private Study Record site, currently `https://lecture.siyidu.com`. Must be set together with `LECTURE_SERVICE_TOKEN`. |
| `LECTURE_SERVICE_TOKEN` | no | empty | Separate bearer secret used only for Study-to-Lecture transcript reads. Use at least 32 random characters. |
| `LECTURE_SITE_AUTH_TOKEN` | no | empty | Sites dispatch bypass token used only by Core for identity-less server-to-server calls to the private Record site. Required when `LECTURE_API_URL` is protected by Sites sign-in. |
| `COURSE_SYNC_MIN_INTERVAL_SECONDS` | no | `300` | Minimum interval between live active+completed Hanyang course catalog refreshes. |
| `LEARNINGX_ENABLED` | no | `false` | Registers the Hanyang-only LearningX attendance, weekly-module, and Board tools. Enable only after the target deployment passes the read-only integration checklist. |
| `OAUTH_ADDITIONAL_REDIRECT_URIS` | no | empty | Comma/whitespace-separated exact redirect URIs for explicitly trusted non-ChatGPT clients. |
| `OAUTH_DCR_ENABLED` | no | `true` | Exposes dynamic client registration. Disable it after the intended private ChatGPT/Codex connections have registered. |
| `OAUTH_MAX_CLIENTS` | no | `8` | Maximum distinct, strictly allowlisted OAuth client registrations for the private pilot. |
| `INVITE_TTL_SECONDS` | no | `604800` | Invitation lifetime. |
| `SETUP_FLOW_TTL_SECONDS` | no | `600` | Pending invite/PAT validation flow lifetime. |
| `WEBAUTHN_FLOW_TTL_SECONDS` | no | `300` | Passkey challenge lifetime. |
| `STEP_UP_FLOW_TTL_SECONDS` | no | `300` | Passkey assertion challenge lifetime for sensitive account changes. |
| `STEP_UP_TOKEN_TTL_SECONDS` | no | `120` | One-time, operation-bound authorization lifetime after step-up. |
| `SESSION_TTL_SECONDS` | no | `43200` | Account-site session lifetime. |
| `OAUTH_CODE_TTL_SECONDS` | no | `300` | Authorization-code lifetime. |
| `ACCESS_TOKEN_TTL_SECONDS` | no | `3600` | MCP access-token lifetime. |
| `REFRESH_TOKEN_TTL_SECONDS` | no | `2592000` | Maximum refresh-token lifetime. |

Generate a master key locally and move it directly into the secret store:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Losing this key makes stored Canvas tokens unrecoverable. Exposing it requires revoking every stored Canvas token and re-enrolling users. Do not print it in CI logs or health endpoints.

## Local development

Install, validate, and start the service from this directory:

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

For localhost, set `PUBLIC_ORIGIN=http://localhost:8794`, `WEBAUTHN_RP_ID=localhost`, and `COOKIE_SECURE=false`. Supply a newly generated development-only master key. Never reuse the production database, production master key, or a production Canvas PAT in local development.

Create invitations with the compiled server CLI after the database and environment are configured. Run `npm run build` first for a local checkout; the production image already contains the compiled CLI:

```sh
npm run create-invite -- --institution hanyang
```

For the example Compose deployment, run the same command inside the service container:

```sh
docker compose --env-file .env -f docker-compose.example.yml exec canvas npm run create-invite -- --institution hanyang
```

Treat the emitted invitation URL as a short-lived credential. Deliver it privately and do not paste it into chat, tickets, analytics, or logs.

## Browser route and API contract

`src/web/assets/auth.js` contains the single `API_ENDPOINTS` object used by all browser pages. If server routes change, update that object rather than scattering paths across HTML files.

Every state-changing browser request is same-origin `POST`, includes cookies where needed, and is rejected when the exact `Origin` header is missing or different. Responses are JSON and must include only safe error messages. Do not return, reflect, or log PATs, invitation tokens, WebAuthn challenges, session identifiers, OAuth codes, or bearer tokens.

### Session bootstrap

`GET /auth/session` returns:

```json
{
  "authenticated": false,
  "redirectTo": "/login"
}
```

`redirectTo` is optional and must be a same-origin relative path. Authenticated responses may include a safe user summary, but never a Canvas PAT.

### Initial enrollment

Open invitations as `/setup#token=...`. The fragment is never sent in an HTTP request or Referer; the page copies it into memory and immediately removes it from the visible URL with `history.replaceState`. Query-string invitation tokens are intentionally rejected because they can enter proxy and access logs. The page sends:

```text
POST /auth/register/options
Content-Type: application/json
{ "inviteToken": "...", "pat": "...", "deviceName": "My laptop" }
```

The invitation—not a client-supplied field—selects the institution and Canvas base URL. The server must reject a PAT that does not identify the invited user's own account. A successful response has a short-lived server-side flow ID and SimpleWebAuthn-compatible JSON options:

```json
{
  "flowId": "opaque-flow-id",
  "options": {
    "challenge": "base64url",
    "rp": { "id": "study.siyidu.com", "name": "Canvas" },
    "user": { "id": "base64url", "name": "user", "displayName": "User" },
    "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }]
  }
}
```

The browser then calls `navigator.credentials.create()` and sends:

```text
POST /auth/register/verify

{ "flowId": "opaque-flow-id", "credential": { "...": "WebAuthn registration JSON" } }
```

The server verifies challenge, origin, RP ID, user presence, and replay resistance before creating the session. The pending flow must expire and be single-use whether verification succeeds or fails.

### Passkey login

- `POST /auth/login/options` with `{}` returns `{ flowId, options }`.
- `POST /auth/login/verify` with `{ flowId, credential }` verifies the assertion, advances the credential counter where applicable, creates a new session, and may return `{ redirectTo: "/account" }`.
- `POST /auth/logout` with `{}` revokes the current server-side session and clears the cookie.

### Account page

`GET /api/account` returns a safe projection such as:

```json
{
  "user": {
    "displayName": "Student",
    "institution": "hanyang"
  },
  "canvas": {
    "canvasName": "Student",
    "baseUrl": "https://learning.hanyang.ac.kr",
    "updatedAt": 1786996800000
  },
  "passkeys": [
    { "deviceName": "Laptop", "createdAt": 1786996800000, "lastUsedAt": null }
  ]
}
```

- `POST /api/account/canvas-token` with `{ "pat": "..." }` validates and atomically replaces the encrypted PAT. Never use a GET/query parameter for this operation.
- Sensitive account changes first call `POST /api/account/step-up/options` with an operation (`add_passkey` or `delete_account`), verify an existing passkey at `/api/account/step-up/verify`, and receive a short-lived, one-use `stepUpToken` bound to that operation and browser session.
- `POST /api/account/passkeys/options` with `{ "deviceName": "Phone", "stepUpToken": "..." }`, followed by `/api/account/passkeys/verify`, adds another passkey without accepting an invite or PAT.
- `POST /api/account/delete` with `{ "confirmation": "DELETE", "stepUpToken": "..." }` revokes sessions and OAuth grants, deletes the encrypted Canvas connection and account records, and clears the session cookie.

If an account-management endpoint is not implemented, remove or disable its UI control before deployment; do not leave a misleading control in production.

### Private Lecture integration

`GET /internal/lecture/courses` is a server-to-server endpoint for the Lecture container. It accepts only `Authorization: Bearer STUDY_SERVICE_TOKEN`, derives the owner from the sole Hanyang connection, refreshes active and completed courses subject to `COURSE_SYNC_MIN_INTERVAL_SECONDS`, and returns `{ courses, syncedAt, stale }`. The browser never receives either service token or the Canvas PAT.

When `LECTURE_API_URL` and `LECTURE_SERVICE_TOKEN` are both configured, the MCP also registers `list_lecture_sessions`, `get_lecture_transcript`, and `search_lecture_transcripts`. Those tools call only the configured Lecture origin under `/internal/mcp/lecture/` and are annotated read-only. Canvas tools require only `canvas.read`; Lecture tool calls additionally require `lecture.read`. Existing canvas-only grants continue to work, while using Lecture tools requires reconnecting once to grant the additional scope. If Record is private on Sites, Core also sends `LECTURE_SITE_AUTH_TOKEN` in `OAI-Sites-Authorization`; it never exposes that token to MCP clients.

## Container deployment

The Docker image compiles TypeScript, copies static web assets into `dist/web`, prunes development dependencies, and runs as the unprivileged `node` user. The compose example additionally drops Linux capabilities, uses a read-only root filesystem, mounts only `/data`, and binds the app to loopback so a TLS reverse proxy is required.

1. Copy `docker-compose.example.yml` to the private deployment configuration. The retained `study_internal` network is only needed for the Core-to-course-catalog compatibility endpoint; Record itself now runs on Sites.
2. Create an untracked `.env` with `MASTER_KEY_BASE64` and any non-default settings. Limit it to the deployment account.
3. Back up the SQLite volume and master key separately, with equivalent access controls.
4. Start the service with `docker compose --env-file .env -f docker-compose.example.yml up -d --build canvas`.
5. Terminate TLS at a trusted reverse proxy and forward to `127.0.0.1:8794`.
6. Verify the public origin, passkey enrollment/login, OAuth metadata, MCP authorization, legal pages, and all security headers before issuing invitations.

Do not use Cloudflare Flexible SSL for a public reverse-proxy origin. This deployment instead uses a Cloudflare Tunnel terminating on the same host and forwards only over loopback to `127.0.0.1:8794`. If the proxy hop topology changes, set `TRUST_PROXY` to the exact trusted hop count rather than accepting arbitrary forwarded headers.

SQLite needs write access to the directory containing the database for WAL and shared-memory files. Do not mount only the database file read-write while making its directory read-only.

## Read-only tool surface

The standard Canvas surface covers connection status, courses, the authenticated student's imported Hanyang Portal timetable, assignments, course-wide submissions and instructor feedback, Inbox conversations, posted grades, announcements, modules, course tabs, quizzes, discussions, pages, file metadata and contents, calendar events, planner work, and a bounded weekly summary. `get_timetable` returns the official recurring 2026-semester-2 class times, rooms, and stable Canvas course mappings; date-specific notices remain separate overlays for the matching course and stated date range. Inbox detail reads explicitly disable Canvas's default automatic mark-as-read behavior. `list_files` returns metadata and `get_file` returns a short-lived MCP file reference backed by a size-limited server relay; Canvas verifier URLs and PATs are never returned. Rich text and file contents remain untrusted data.

The codebase also contains a Hanyang-only LearningX pilot for attendance items, watched-seconds metadata, Weekly Learning modules, and Board lists/posts. It is feature-gated by `LEARNINGX_ENABLED=false`. The pilot derives an external-tool ID from the student's visible course tabs, confines the Canvas PAT to the configured Canvas origin, permits the signed LTI form only on allowlisted Hanyang/Xinics HTTPS origins, and confines the resulting short-lived JWT to same-origin `/learningx/api/` reads. A 2026-08-30 read-only production audit confirmed the live `Lecture/Attendance`, `Weekly Learning`, and `Board` labels, module response shape, and course-scoped Board path; the deployment must still remain private and comply with applicable Canvas, Hanyang, and course policies.

## Connecting clients

### Codex

The sibling `canvas` plugin maps its app name through `.app.json` to the registered Canvas application. Install it from the repo-scoped marketplace and use the existing account-level OAuth connection. Keep write-tool approval policies locked down; the initial server publishes only read-only tools.

### ChatGPT

ChatGPT uses the registered remote MCP connection:

1. Deploy the public HTTPS server and verify OAuth discovery from `https://study.siyidu.com/mcp`.
2. Enable Developer mode under ChatGPT **Settings → Security and login**.
3. In **ChatGPT Plugins**, add the MCP server URL and complete its connection details.
4. Copy the generated application ID. ChatGPT URLs may show it with a `plugin_` compatibility prefix; `.app.json` stores the underlying `asdk_app_...` value.
5. Add `plugins/canvas/.app.json` mapping a stable local app name to that exact application ID, then add `"apps": "./.app.json"` to `plugins/canvas/.codex-plugin/plugin.json`.
6. Add a local marketplace entry, refresh ChatGPT, install the plugin from that local source, and test in a new chat.

After the intended private connection has completed DCR, set `OAUTH_DCR_ENABLED=false` and restart the service. Existing client IDs and refresh-token families remain valid; briefly re-enable registration only when deliberately adding a new connection.

This repository includes the real `.app.json` mapping created for the private Canvas development app. Do not replace it with an invented ID or a raw MCP URL.

Official packaging and test references:

- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [Plugin security and privacy](https://developers.openai.com/plugins/guides/security-privacy)

## Release checks

Before a deployment or plugin package is shared:

```sh
npm ci
npm run typecheck
npm test
npm run build
node --check src/web/assets/auth.js
```

Also validate the `canvas` plugin and its skill with the current OpenAI-provided plugin/skill validators, inspect the final container as the non-root user, and perform one end-to-end OAuth session using a non-production test Canvas account. Passing source checks is not proof that DNS, TLS, reverse-proxy headers, WebAuthn RP configuration, or the remote OAuth flow works live.
