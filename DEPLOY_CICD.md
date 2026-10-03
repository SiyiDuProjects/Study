# Study deployment and recovery

The maintained entry point is [docs/release-workflow.md](docs/release-workflow.md). Run `release:status`, `release:check`, and `release:prepare` from the repository root. Use `scripts/release/core-release.sh` with the prepared release ID, expected live image and archive SHA256. Do not start from historical date-specific scripts under `.deploy`.

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

Record is built from `apps/record` and deployed to the existing OpenAI Sites project. Preserve its inspected access mode. Its `DB` binding is D1. The browser identity comes only from Sites `oai-authenticated-user-*` headers and must match `STUDY_OWNER_EMAIL`. The canonical origin is `https://lecture.siyidu.com`; the former `lecture.gaid.studio` domain no longer resolves.

Required Sites secrets/environment:

- `OPENAI_API_KEY` (secret)
- `STUDY_API_URL=https://study.siyidu.com`
- `STUDY_SERVICE_TOKEN` (secret)
- `LECTURE_SERVICE_TOKEN` (secret)
- `STUDY_OWNER_EMAIL` (owner identity, server environment only)

The internal MCP read API still verifies `LECTURE_SERVICE_TOKEN`; Sites private access is an additional outer boundary. The browser never receives any of these values or the Canvas PAT.

## Coordinated release of the paged read contract

The September 2026 optimization changes Canvas collections to `{items,nextCursor}` and the Core/Record lecture reads to the shared paged schemas in `apps/core/src/lecture/types.ts`. The internal API negotiates `X-Study-Lecture-Contract: paged-v1`; missing header retains legacy `{sessions}`, `{session.segments}` and `{query,hits}` responses. Deploy the compatible Record version first and verify both contracts while old Core is still live, then activate Core. Roll back Core first, verify legacy reads still work with the compatible Record, then restore the old Record only with no active recording clients. Updating the local plugin package alone does not publish either service or refresh existing tool snapshots.

Before activation, take fresh Core data/config and Sites D1 backups and retain both currently deployed artifacts. Validate the Core candidate and built Record Worker against disposable copied data, including old model metadata, daily records, long-transcript continuation, partial-record warnings, owner rejection and service authentication. Use `npm run test:worker --prefix apps/record` for the disposable built-Worker smoke; this is separate from production verification.

Use a coordinated maintenance window for the two service activations and reload Record clients afterward. Avoid switching an actively recording client. No database migration or replay of writes is required for the read contract; retain writer leases, revisions, transcript segments and message request IDs. Confirm both local/private health and public authenticated reads independently. If either service cannot complete the paired release, restore both previous artifacts/configuration while preserving current databases.

Before switching or rolling back, re-read every live session and verify no unfinished recording or pending writer. The old v7 Worker replaces all segments on checkpoint, while the current browser sends changed segments only. A cached new browser writing to the old Worker can erase segments. Do not roll back while recording clients are active; reload clients after both artifacts are switched. Never repair this by marking sessions complete or replaying checkpoints without authorization.

The current D1 logical backup covers all columns and rows in `app_metadata`, `courses`, `school_caption_courses`, `sessions` and `transcript_segments`, including leases and revisions. Store it with owner-only permissions; verify with `scripts/release/verify-d1-backup.py` and the unchanged migration SQL. This is a user-table logical export, not a native D1 snapshot. Re-read sessions after export to detect concurrent writes. Keep the prior Sites version and source commit for coordinated rollback.

After activation, start a new plugin task and verify the actual tools/list and accessible read calls. Check Planner against the exact submission record, continue an Inbox page, read daily/historical lectures, and traverse a long transcript. LearningX attendance and weekly modules remain separate upstream collections; do not claim their coverage is equivalent. Real message delivery, phone recording and Passkey/account flows require their own authorized acceptance sessions.

## SQLite to D1 cutover

The migration is one-way only after verification:

1. Stop new Record writes or take a final consistent SQLite online backup.
2. Export courses, metadata, sessions, and ordered transcript segments without logging transcript text or secrets.
3. Import into a fresh Sites D1 deployment.
4. Compare row counts and representative hashes, then exercise list/detail/search and a complete create-checkpoint-finish cycle.
5. Point Core `LECTURE_API_URL` to the Sites URL and set `LECTURE_SITE_AUTH_TOKEN`.
6. Keep the old SQLite backup and old container stopped until the D1 deployment has been verified.

Raw audio is not part of this migration because Study Record does not persist it.
