# Study deployment and recovery

## Study Core

Study Core remains on the existing VPS under `/home/ubuntu/siyi/canvas` and binds only to `127.0.0.1:8794`. Cloudflare Tunnel provides `https://study.siyidu.com`.

Before a Core release:

1. Create an online SQLite backup and verify `PRAGMA integrity_check` is `ok`.
2. Back up the active Compose and environment configuration without printing secrets.
3. Build the replacement image before recreating the single service.
4. Verify local `/readyz`, public HTTPS, OAuth metadata, Canvas tools with a canvas-only token, and Lecture tools with a `lecture.read` token.
5. If the application health check fails, restore the prior image/config. Do not overwrite a database that may have received new writes.

The private Sites deployment requires Core to send both:

- `Authorization: Bearer <LECTURE_SERVICE_TOKEN>` to the Record internal API.
- `OAI-Sites-Authorization: Bearer <LECTURE_SITE_AUTH_TOKEN>` to pass Sites dispatch.

## Study Record

Record is built from `apps/record` and deployed privately with OpenAI Sites. Its `DB` binding is D1. The browser identity comes only from Sites `oai-authenticated-user-*` headers.

Required Sites secrets/environment:

- `OPENAI_API_KEY` (secret)
- `STUDY_API_URL=https://study.siyidu.com`
- `STUDY_SERVICE_TOKEN` (secret)
- `LECTURE_SERVICE_TOKEN` (secret)

The internal MCP read API still verifies `LECTURE_SERVICE_TOKEN`; Sites private access is an additional outer boundary. The browser never receives any of these values or the Canvas PAT.

## SQLite to D1 cutover

The migration is one-way only after verification:

1. Stop new Record writes or take a final consistent SQLite online backup.
2. Export courses, metadata, sessions, and ordered transcript segments without logging transcript text or secrets.
3. Import into a fresh Sites D1 deployment.
4. Compare row counts and representative hashes, then exercise list/detail/search and a complete create-checkpoint-finish cycle.
5. Point Core `LECTURE_API_URL` to the Sites URL and set `LECTURE_SITE_AUTH_TOKEN`.
6. Keep the old SQLite backup and old container stopped until the D1 deployment has been verified.

Raw audio is not part of this migration because Study Record does not persist it.
