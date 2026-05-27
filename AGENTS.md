# AGENTS.md

## Project

This repo is a React + Vite + TypeScript PWA plus a Node/Express API for Korean class live subtitles, shared transcript storage, and Markdown/AI-context export.

## Commands

- Install: `npm.cmd install`
- Dev server: `npm.cmd run dev`
- Build: `npm.cmd run build`
- Test: `npm.cmd run test`

Use `npm.cmd` on Windows PowerShell because plain `npm` may be blocked by execution policy.

## Change Hygiene

- After completing meaningful code, configuration, deployment, or documentation changes, create a git commit unless the user explicitly asks not to.
- When a change affects setup, commands, deployment, architecture, environment variables, or project operating notes, update `README.md` and/or `AGENTS.md` in the same change so docs stay current.

## Architecture

- `src/App.tsx`: app composition, live subtitle workflow, records and document views.
- `src/lib/realtimeTranscriptionTranslation.ts`: default classroom client; OpenAI Realtime transcription streams Korean first, then server-side text translation adds Chinese.
- `src/lib/classicRealtimeTranslation.ts`: fallback low-latency OpenAI Realtime Translation WebSocket client.
- `src/lib/audio.ts`: 24 kHz PCM16 microphone frame conversion for classic WebSocket mode.
- `src/lib/realtimeTranslation.ts`: fallback OpenAI Realtime Translation WebRTC client.
- `src/lib/realtimeTranscriptionTranslation.ts`: WebRTC transcription plus server-side text translation flow.
- `src/lib/realtimeWebRtc.ts`: shared OpenAI Realtime WebRTC transport.
- `src/lib/transcriptReducer.ts`: source/translation delta merging and segment commit logic.
- `src/lib/storage.ts`: local settings and IndexedDB pending-session sync queue.
- `src/lib/markdown.ts`: Markdown export and AI-context transcript builders.
- `server/app.ts`: Express API for courses, config, OpenAI client secrets, translation, and sessions.
- `server/openai.ts`: server-side OpenAI client secret and Responses API integration.
- `server/db.ts`: SQLite session repository.

## Constraints

- Do not save or persist raw classroom audio.
- Keep the live screen subtitle-first and uncluttered.
- Do not commit API keys or `.env` files.
- Keep OpenAI API keys on the server. The browser receives only short-lived Realtime client secrets.
- OpenAI model names are server configuration; do not hardcode new model names in browser UI or schemas.
- Default classroom mode is `transcribe-then-translate`; keep `classic-websocket-translate` and `realtime-translate` available as fallback comparison modes.

## Deployment Notes

This repo deploys a Vite frontend plus a Node/Express API. `npm.cmd run build` produces `dist/` and `dist-server/`; production should run `node dist-server/server/index.js` behind HTTPS.

GitHub remote: `https://github.com/SiyiDuProjects/Jiahuan.git`.

Known VPS context from sibling `Interview` and `connection` projects:

- Host: `49.51.38.235`
- SSH user: `ubuntu`
- Local Mac SSH key: `/Users/bytedance/Projects/keys/connection-prod-20260526.pem`
- Local Mac SSH command: `ssh -i /Users/bytedance/Projects/keys/connection-prod-20260526.pem ubuntu@49.51.38.235`
- Tencent Cloud SSH key name/ID: `connection_prod_20260526` / `lhkp-41patbaz`
- Legacy Windows SSH key path: `C:\Users\Administrator\Desktop\Projects\Siyi.pem`
- Shared Docker Compose directory on host: `/home/ubuntu/muxing`
- Cloudflare Tunnel is already used on the VPS for public hostnames.
- Existing reserved/local ports:
  - `8000` = Interview API
  - `8080` = sub2api
  - `8787` = connection contacts API
  - `20241` = cloudflared metrics
  - `40000` = WARP

On this Mac, multiple local projects share `/Users/bytedance/Projects/keys/connection-prod-20260526.pem` for VPS access. Do not print, paste, or commit the private key. If permissions drift, fix them with:

```bash
chmod 700 /Users/bytedance/Projects/keys
chmod 600 /Users/bytedance/Projects/keys/connection-prod-20260526.pem
```

Recommended VPS deployment for this project:

- Host the app release from `/opt/jiahuan/app` and SQLite data from `/opt/jiahuan/data`.
- Add a Node service to `/home/ubuntu/muxing/docker-compose.yml`, for example a `node:22-bookworm-slim` container named `jiahuan_app`.
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

On this Mac:

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
cd /home/ubuntu/muxing
sudo docker compose up -d jiahuan_app
```

CI/CD deployment:

- Workflow file: `.github/workflows/deploy-static.yml`
- Project deploy doc: `DEPLOY_CICD.md`
- Required shared GitHub Actions secrets: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY`, `COMPOSE_PATH`
- Required project-specific secrets: `JIAHUAN_APP_PATH`, `JIAHUAN_DATA_PATH`, `JIAHUAN_COMPOSE_SERVICE`
- Optional project-specific secret: `JIAHUAN_LOCAL_HEALTH_URL`, defaulting to `http://127.0.0.1:8091/api/health`
- The workflow runs `npm ci`, `npm test`, `npm run build`, syncs `dist/` and `dist-server/` to the VPS, installs production dependencies on the VPS, runs `docker compose up -d jiahuan_app`, then checks the local health endpoint over SSH.
- After syncing the app release, the workflow normalizes app file permissions to `755` for directories and `644` for files so the Node container can read them.
