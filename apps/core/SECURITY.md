# Security policy

Canvas handles high-value educational data and a Canvas bearer token. Security is part of the product contract, not an optional deployment mode.

## Reporting a vulnerability

Do not open a public issue containing a vulnerability, invitation URL, Canvas token, session cookie, OAuth token or code, WebAuthn payload, student record, or production log excerpt.

During the invite-only pilot, report concerns through the private channel that issued the invitation. Before any public availability, the operator must publish a monitored security contact at the service domain and a `/.well-known/security.txt` file. Include only:

- A concise description and affected endpoint or component.
- Reproduction steps using synthetic data and a test account.
- The security impact and any safe mitigation you identified.
- A way to contact you.

Never include a working production credential. The operator should acknowledge a report promptly, preserve evidence without broadening access, and coordinate remediation and disclosure privately.

## Supported versions

Only the currently deployed invite-only release receives security fixes. Local forks and older deployments are not supported by the service operator. Do not expose a development build to the internet.

## Protected assets

The highest-sensitivity assets are:

- `MASTER_KEY_BASE64` and decrypted Canvas PATs.
- `STUDY_SERVICE_TOKEN` and `LECTURE_SERVICE_TOKEN` used between the two private containers.
- Encrypted Canvas PAT records and their user/institution binding.
- Invitation tokens and pending setup flows.
- WebAuthn challenges, credential public keys, and session cookies.
- OAuth authorization codes, access tokens, refresh tokens, registered redirect URIs, and PKCE state.
- Course, assignment, submission, grade, and announcement data returned from Canvas.

The master key must live outside the image and repository. Restrict it to the production service identity, back it up separately from the database, and never expose it through diagnostics. A suspected master-key compromise requires stopping the service, revoking every affected Canvas token and OAuth grant, replacing the key, and re-enrolling users.

## Required controls

### Canvas token isolation

- Accept a PAT only in an HTTPS POST body. Never accept it from a URL, query string, fragment, cookie, command line, or MCP tool argument.
- Never request or accept a university password, SSO password, MFA code, recovery code, or browser cookie.
- Bind each invitation to an exact institution on the server. Ignore a browser-supplied base URL or institution override.
- Allow outbound Canvas API traffic only to the static institution hosts defined in the application domain model.
- Construct request URLs from trusted bases and relative API paths. Reject absolute user-provided URLs, credentials in URLs, non-HTTPS origins, unexpected ports, and host-changing redirects.
- Attach the Canvas `Authorization` header only after the destination host has passed the allowlist check. Never forward it across a redirect.

### LearningX pilot isolation

- Keep `LEARNINGX_ENABLED=false` until a Hanyang course and institution terms have been reviewed.
- Send the Canvas PAT only to the fixed Hanyang Canvas origin and only on `/api/` paths.
- Accept verifier and LTI form destinations only on explicit Hanyang/Xinics HTTPS suffix allowlists; require the signed form action to remain on the verifier origin.
- Send the short-lived `xn_api_token` only to the fixed Hanyang origin under `/learningx/api/` and never return it, cookies, raw LCMS links, or media URLs through MCP.
- Do not download LearningX content, forge attendance, play media, or update progress in the read-only pilot.
- Encrypt PATs with an authenticated encryption construction and unique nonces. Do not implement deterministic encryption or reuse nonces.

### Browser sessions and passkeys

- Require HTTPS and validate the exact WebAuthn origin and configured RP ID.
- Generate challenges with a cryptographically secure random source, bind them to the pending flow and intended ceremony, set a short expiration, and consume them once.
- Require user presence. Prefer user verification where supported and handle signature counters without locking out authenticators that legitimately report zero.
- Set production cookies `Secure`, `HttpOnly`, `SameSite=Lax` or stricter, with `Path=/`; use the `__Host-` prefix when its constraints are satisfied.
- Rotate the session identifier after authentication. Store only a one-way digest of opaque session tokens and revoke them on logout, account deletion, and security resets.
- Require exact same-origin `Origin` checks for every browser POST, reject requests with a missing origin, keep session cookies `SameSite`, and use non-simple JSON requests where applicable. Do not treat CORS as CSRF protection.
- Disable caching on authenticated and secret-bearing responses. Do not embed account data or credentials in static HTML.

### OAuth and MCP

- Use authorization code with PKCE S256. Do not support an implicit flow or a client secret for public dynamic clients.
- Compare redirect URIs exactly against the registered allowlist. ChatGPT callbacks are limited to the documented HTTPS host/path patterns; additional clients require explicit configuration.
- Bind authorization codes to client ID, redirect URI, resource, user, scope, and PKCE challenge. Make codes short-lived and single-use.
- Issue audience/resource-bound access tokens. The Canvas-only mode uses `canvas.read`; the combined private Study resource requires `canvas.read lecture.read` on every tool because both data sources share one MCP endpoint. Store token digests rather than plaintext bearer tokens.
- Rotate refresh tokens and revoke the token family on replay or account deletion.
- Require bearer authentication on every MCP request and bind each stateless MCP server instance to the authenticated user before resolving the Canvas connection.
- Keep the two internal service tokens separate: Lecture uses `STUDY_SERVICE_TOKEN` only for the course catalog, while Study uses `LECTURE_SERVICE_TOKEN` only for transcript reads. Never expose either token to browser code.
- Keep tool annotations honest. Adding a write tool requires a new threat review, explicit confirmation design, authorization changes, and updated public disclosures.

### Untrusted Canvas content

Course names, syllabi, announcements, assignment descriptions, module content, filenames, and URLs are untrusted input. They may contain prompt injection, scripts, misleading instructions, or hostile markup.

- Strip active HTML and unsafe URL schemes before returning text.
- Tell the MCP client that returned content is data, never system or developer instructions.
- Do not execute links, download arbitrary attachments, render remote HTML, or let Canvas content choose tool calls.
- Preserve source identifiers and timestamps so a user can verify consequential information in Canvas.
- Limit response sizes, pagination, concurrency, and date ranges to prevent resource exhaustion.

### Logging and diagnostics

Use structured allowlist logging. A redaction blacklist is insufficient. Logs may contain a request ID, route template, status, duration, safe error code, and coarse operational metadata. Logs must not contain:

- Request or response bodies from auth, OAuth, token, Canvas, or MCP routes.
- `Authorization`, `Cookie`, `Set-Cookie`, CSRF, or WebAuthn headers and payloads.
- Query strings from `/setup`, OAuth callbacks, or any route that can carry an opaque credential.
- Canvas PATs, invitation tokens, session/OAuth values, master keys, or decrypted database fields.
- Full Canvas response objects or student record content.

Protect log access, define a short retention period, and test redaction. Debug mode does not relax these rules.

### Deployment

- Run the process as an unprivileged user with a read-only root filesystem, no Linux capabilities, and a dedicated writable data volume.
- Bind the service to loopback behind a TLS reverse proxy. Do not expose the raw Node listener to the public internet.
- Set `TRUST_PROXY` to the exact topology and reject untrusted forwarded-host or forwarded-proto input.
- Keep Node.js and production dependencies patched. Review lockfile changes and run tests before rebuilding.
- Back up the SQLite database and master key separately. Encrypt backups, restrict restore access, document retention, and test restoration.
- Monitor authentication failures, invite abuse, OAuth anomalies, Canvas 401/403 spikes, rate limiting, and unexpected outbound destinations without logging sensitive payloads.
- Ensure privacy, terms, and account deletion pages remain reachable and accurate before onboarding users.

## Security review required before launch

The operator must complete all of the following before issuing production invitations:

- Confirm live DNS, certificate chain, HSTS, CSP, frame protections, MIME sniffing protections, referrer policy, and cache headers.
- Confirm the public origin and WebAuthn RP configuration from at least two authenticator types.
- Test invitation reuse, challenge replay, session fixation, CSRF, OAuth redirect manipulation, PKCE failure, refresh-token replay, and account deletion.
- Verify outbound destination enforcement and Canvas authorization-header stripping on every redirect path.
- Search production build artifacts and logs for placeholder or real secrets.
- Exercise every MCP tool with least-privilege test data and verify it performs no write request.
- Have privacy and terms text reviewed for the actual operator, jurisdiction, subprocessors, retention, and contact details.

Source-level tests cannot prove that the live proxy, TLS, DNS, OAuth registration, WebAuthn authenticators, or Canvas tenant behavior is correct. Record those as separate deployment verification evidence.
