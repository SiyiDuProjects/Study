# AGENTS.md

## Project

This repo is a React + Vite + TypeScript PWA plus a Node/Express API for Korean class live subtitles, shared transcript storage, and Markdown/AI-context export.

## Commands

- Install: `npm.cmd install`
- Dev server: `npm.cmd run dev`
- Build: `npm.cmd run build`
- Test: `npm.cmd run test`
- Sites dev: `npm.cmd run sites:dev`
- Sites build: `npm.cmd run sites:build`
- D1 migration: `npm.cmd run db:generate`
- Apply local D1 migrations: `npm.cmd run sites:db:apply`

Use `npm.cmd` on Windows PowerShell because plain `npm` may be blocked by execution policy.

## Change Hygiene

- Follow the global documentation and context rules in `/Users/bytedance/.codex/AGENTS.md`.
- Keep this file focused on Jiahuan-specific realtime, storage, deployment, and verification details.

## Architecture

- `src/App.tsx`: app composition, live subtitle workflow, records and document views.
- `src/lib/realtimeTranscriptionTranslation.ts`: default classroom client; OpenAI Realtime transcription streams Korean first, then server-side text translation adds Chinese.
- `src/lib/classicRealtimeTranslation.ts`: fallback low-latency OpenAI Realtime Translation WebSocket client.
- `src/lib/audio.ts`: 24 kHz PCM16 microphone frame conversion for classic WebSocket mode.
- `src/lib/realtimeTranslation.ts`: fallback OpenAI Realtime Translation WebRTC client.
- `src/lib/realtimeWebRtc.ts`: shared OpenAI Realtime WebRTC transport.
- `src/lib/transcriptReducer.ts`: source/translation delta merging and segment commit logic.
- `src/lib/storage.ts`: local settings and IndexedDB pending-session sync queue.
- `src/lib/markdown.ts`: Markdown export and AI-context transcript builders.
- `server/app.ts`: Express API for courses, config, OpenAI client secrets, translation, and sessions.
- `server/openai.ts`: server-side OpenAI client secret and Responses API integration.
- `server/db.ts`: SQLite session repository.
- `worker/index.ts`: Sites/Cloudflare Worker API with the same browser-facing `/api` contract.
- `worker/db.ts`: D1 session repository used only by the Sites runtime.
- `db/schema.ts` and `drizzle/`: Sites D1 schema and generated migrations.
- `vite.sites.config.mts`: Sites-compatible Worker/static-assets build; normal VPS builds continue using `vite.config.mts`.
- `.openai/hosting.json`: Sites project handle plus logical D1/R2 bindings only.

## Constraints

- Do not save or persist raw classroom audio.
- Keep the live screen subtitle-first and uncluttered.
- Keep OpenAI API keys on the server. The browser receives only short-lived Realtime client secrets.
- OpenAI model names are server configuration; do not hardcode new model names in browser UI or schemas.
- Live recording requires a server API key that supports OpenAI Realtime client secrets; text-only API gateways can only support the later Korean-to-Chinese translation step.
- Default classroom mode is `transcribe-then-translate`; keep `classic-websocket-translate` and `realtime-translate` available as fallback comparison modes.
- Keep the VPS Node/SQLite path and Sites Worker/D1 path behaviorally aligned. Browser API routes stay relative and keep the same request/response schemas.
- Sites runtime values belong in Sites environment settings. Never put secrets, real D1 IDs, or environment values in `.openai/hosting.json`.
- Sites D1 and VPS SQLite do not share data automatically. Treat record migration and count/content verification as a required step before changing the production hostname.

## Realtime Change Discipline

- Treat `transcribe-then-translate` as the production classroom path: Realtime produces Korean transcription first, then `/api/translate` fills Chinese text by Korean sentence boundary after the Korean segment exists.
- Keep Korean transcription, Chinese text translation, and subtitle rendering as separate responsibilities. Korean display must never depend on `/api/translate` finishing.
- Realtime model names and session model choices must come from server configuration. Do not hardcode or swap browser-side model names to work around a runtime failure without explicit approval.
- Fix Realtime failures at the session, event, or audio transport boundary first. Do not hide main-chain failures with UI timers, localStorage version bumps, forced fallback modes, or translation fallback behavior.
- Do not add explicit `turn_detection` to the `transcribe-then-translate` transcription client-secret session unless the configured realtime transcription model has been verified against the real API to accept it. The current `gpt-realtime-whisper` path relies on Realtime transcription's default VAD.
- Temporary diagnostics must stay isolated and removable. Do not let debugging probes become production control flow.

## Deployment Notes

This repo deploys a Vite frontend plus a Node/Express API. `npm.cmd run build` produces `dist/` and `dist-server/`; production should run `node dist-server/server/index.js` behind HTTPS.

The repo also supports a parallel OpenAI Sites deployment. `npm.cmd run sites:build` produces a Cloudflare Worker entry at `dist/server/index.js`, static assets, Sites metadata, and D1 migrations. Keep the initial Sites deployment private until the Realtime secret, record migration, and live classroom checks are complete.

GitHub remote: `https://github.com/SiyiDuProjects/Jiahuan.git`.

Shared VPS access, key permissions, and secret-printing rules are documented in `/Users/bytedance/.codex/AGENTS.md`. Project-specific deployment details:

- Shared Docker Compose directory on host: `/home/ubuntu/siyi`
- Cloudflare Tunnel is already used on the VPS for public hostnames.
- Existing reserved/local ports to avoid for this project: `8000`, `8080`, `8787`, `20241`, `40000`.

Recommended VPS deployment for this project:

- Host the app release from `/opt/jiahuan/app` and SQLite data from `/opt/jiahuan/data`.
- Add a Node service to `/home/ubuntu/siyi/docker-compose.yml`, for example a `node:22-bookworm-slim` container named `jiahuan_web`.
- Run `node dist-server/server/index.js` with `JIAHUAN_STATIC_DIR=/app/dist` and `JIAHUAN_DB_PATH=/data/jiahuan.sqlite`.
- Bind it only on localhost, e.g. `127.0.0.1:8091:80`, to avoid exposing it directly outside the VPS.
- Add a Cloudflare Tunnel public hostname such as `jiahuan.gaid.studio` or `subtitle.gaid.studio` pointing to `http://localhost:8091`.
- Protect the hostname with Cloudflare Access because this is an internal classroom tool.

Manual deploy shape:

```powershell
npm.cmd run test
npm.cmd run build
scp -i C:\Users\Administrator\Desktop\Projects\Siyi.pem -r dist dist-server package.json package-lock.json ubuntu@49.51.38.235:/tmp/jiahuan-app/
```

On this Mac, use the shared VPS SSH key documented globally:

```bash
npm test
npm run build
scp -i /Users/bytedance/Projects/keys/connection-prod-20260526.pem -r dist dist-server package.json package-lock.json ubuntu@49.51.38.235:/tmp/jiahuan-app/
```

Then on the VPS:

```bash
sudo mkdir -p /opt/jiahuan/app /opt/jiahuan/data
sudo rsync -a --delete /tmp/jiahuan-app/ /opt/jiahuan/app/
sudo docker run --rm -v /opt/jiahuan/app:/app -w /app node:22-bookworm-slim npm ci --omit=dev
cd /home/ubuntu/siyi
sudo docker compose up -d jiahuan_web
```

CI/CD deployment:

- Workflow file: `.github/workflows/deploy-static.yml`
- Project deploy doc: `DEPLOY_CICD.md`
- Required shared GitHub Actions secrets: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY`, `COMPOSE_PATH`
- Required project-specific secrets: `JIAHUAN_APP_PATH`, `JIAHUAN_DATA_PATH`, `JIAHUAN_COMPOSE_SERVICE`
- Optional project-specific secret: `JIAHUAN_LOCAL_HEALTH_URL`, defaulting to `http://127.0.0.1:8091/api/health`
- The workflow validates `npm run build` and `npm run sites:build` in separate jobs from the same commit. After both pass, it syncs the Node/Express `dist/` and `dist-server/` release to the VPS, installs production dependencies, runs `docker compose up -d jiahuan_web`, then checks the local health endpoint over SSH.
- GitHub Actions does not publish the OpenAI Sites version. Sites publication still uses a short-lived source credential and the Sites version/deployment flow from the same validated commit; never store that credential in GitHub Secrets or replace it with direct `wrangler deploy` against the placeholder local D1 ID.
- After syncing the app release, the workflow normalizes app file permissions to `755` for directories and `644` for files so the Node container can read them.
