# Study Lecture project instructions

## Product boundary

- This is the Hanyang-only Study Lecture PWA and transcript service.
- Academic courses come only from Study Core. Never add a production hardcoded course catalog.
- The only local course option is `daily`.
- Do not save or persist raw classroom audio.
- Do not add Berkeley profiles or a profile switcher.

## Security

- This service must never receive or store a Canvas PAT.
- The user explicitly approved a public browser product for this single-owner deployment. Production may run without browser login only when `LECTURE_AUTH_MODE=public` is set exactly; missing or unknown modes must fail closed.
- Public browser requests map to one fixed internal owner. Do not add accounts, tenant selection, or trust identity headers supplied by the browser or proxy.
- Development Vite and API listeners stay on `127.0.0.1`; never expose the loopback-trust development authenticator through a LAN-facing proxy.
- Development browser APIs must also reject any Host other than `127.0.0.1:<localPort>` or `localhost:<localPort>`; loopback socket checks alone do not stop DNS rebinding.
- MCP reads use the independent `LECTURE_SERVICE_TOKEN` and must not expose `created_by_email`.
- `STUDY_API_URL` and the public origin are exact allowlisted hosts; do not add wildcard routing.
- Keep the Canvas PAT, OpenAI master key, and both internal service tokens server-side. Public browsers may receive only the bounded, short-lived OpenAI ephemeral secret needed to start transcription.
- Never commit `.env`, API keys, service tokens, or user email values.

## Data compatibility

- Keep the first migration on `/data/jiahuan.sqlite`; changing the product name must not change the production database filename.
- Existing course metadata is historical evidence. Preserve it and mark old academic rows `legacy_unmatched` until explicitly mapped.
- Archive records logically; do not physically delete transcript history.
- Only `ready` sessions may be archived. Loading an unfinished session is read-only; taking over its writer lease requires explicit confirmation and the revision the browser actually observed.
- Keep raw writer lease tokens only in browser memory and return them only from create/resume. Persist only their hash; every checkpoint/fail/complete write must compare both the lease and expected revision.
- Never auto-archive duplicate unfinished rows during migration. Preserve them and require explicit user resolution.
- Do not mount one writable SQLite database into multiple writer processes.

## Commands

- Install: `npm.cmd install`
- Develop: `npm.cmd run dev`
- Test: `npm.cmd test`
- Build: `npm.cmd run build`

## Architecture

- `src/App.tsx`: recording lifecycle, course picker, recovery, autosave, records and document UI.
- `src/lib/realtime*.ts`: WebRTC transcription/translation and bounded `stopAndFlush`.
- Realtime startup must remain cancellable across microphone permission, client-secret, SDP and data-channel readiness. Autosave must retain bounded fetches and at most one in-flight plus one coalesced pending checkpoint.
- `server/study.ts`: exact internal Study course client.
- `server/auth.ts`: explicit browser auth-mode selection, fixed public-owner mapping, optional legacy Access verification, and service-token verification.
- `server/db.ts`: course cache, legacy-compatible sessions, checkpoints and FTS search.
- `server/app.ts`: browser API plus private MCP read API.

## Deployment

- Existing service/container name: `jiahuan_web`.
- Existing data directory: `/opt/jiahuan/data`.
- Canonical Compose root: `/home/ubuntu/siyi`; env file: `/home/ubuntu/siyi/jiahuan.env`.
- Existing local bind: `127.0.0.1:8091`.
- Expected Study Core URL on the internal network: `http://canvas:8794`.
- Public origin: `https://lecture.gaid.studio` after its Cloudflare Tunnel hostname route is configured.
- Production deploy paths are fixed: app `/opt/jiahuan/app`, data `/opt/jiahuan/data`, backups `/opt/jiahuan/backups`, Compose `/home/ubuntu/siyi`, service `jiahuan_web`.
- Before any migration-capable restart, create and integrity-check a SQLite online backup and snapshot the old app. A failed local health check must restore the old app release; never automatically overwrite a live database during rollback.
