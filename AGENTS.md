# AGENTS.md

## Project

This repo is a React + Vite + TypeScript PWA for Korean class live subtitles and local transcript export.

## Commands

- Install: `npm.cmd install`
- Dev server: `npm.cmd run dev`
- Build: `npm.cmd run build`
- Test: `npm.cmd run test`

Use `npm.cmd` on Windows PowerShell because plain `npm` may be blocked by execution policy.

## Architecture

- `src/App.tsx`: app composition, live subtitle workflow, records and document views.
- `src/lib/realtimeTranslation.ts`: OpenAI Realtime Translation WebSocket client.
- `src/lib/audio.ts`: microphone sample conversion to 24 kHz PCM16 base64 frames.
- `src/lib/transcriptReducer.ts`: source/translation delta merging and segment commit logic.
- `src/lib/storage.ts`: IndexedDB sessions/settings.
- `src/lib/markdown.ts`: Markdown export.

## Constraints

- Do not save or persist raw classroom audio.
- Keep the live screen subtitle-first and uncluttered.
- Do not commit API keys or `.env` files.
- The browser API-key path is only for private prototypes; production should use server-issued short-lived client secrets.

## Deployment Notes

This repo is a static React/Vite PWA. Vercel is not required; `npm.cmd run build` produces `dist/`, which can be served by any HTTPS static host.

GitHub remote: `https://github.com/SiyiDuProjects/Jiahuan.git`.

Known VPS context from sibling `Interview` and `connection` projects:

- Host: `49.51.38.235`
- SSH user: `ubuntu`
- SSH key on this workstation: `C:\Users\Administrator\Desktop\Projects\Siyi.pem`
- Shared Docker Compose directory on host: `/home/ubuntu/muxing`
- Cloudflare Tunnel is already used on the VPS for public hostnames.
- Existing reserved/local ports:
  - `8000` = Interview API
  - `8080` = sub2api
  - `8787` = connection contacts API
  - `20241` = cloudflared metrics
  - `40000` = WARP

Recommended VPS deployment for this project:

- Host the built static files from `/opt/jiahuan/dist`.
- Add a small static file service to `/home/ubuntu/muxing/docker-compose.yml`, for example an `nginx:alpine` container named `jiahuan_web`.
- Bind it only on localhost, e.g. `127.0.0.1:8091:80`, to avoid exposing it directly outside the VPS.
- Add a Cloudflare Tunnel public hostname such as `jiahuan.gaid.studio` or `subtitle.gaid.studio` pointing to `http://localhost:8091`.
- If the app remains a browser-API-key prototype, protect the hostname with Cloudflare Access or keep the URL private. A public production version should add a backend that issues short-lived OpenAI Realtime client secrets.

Manual deploy shape:

```powershell
npm.cmd run test
npm.cmd run build
scp -i C:\Users\Administrator\Desktop\Projects\Siyi.pem -r dist\* ubuntu@49.51.38.235:/tmp/jiahuan-dist/
```

Then on the VPS:

```bash
sudo mkdir -p /opt/jiahuan/dist
sudo rsync -a --delete /tmp/jiahuan-dist/ /opt/jiahuan/dist/
cd /home/ubuntu/muxing
sudo docker compose up -d jiahuan_web
```

CI/CD deployment:

- Workflow file: `.github/workflows/deploy-static.yml`
- Project deploy doc: `DEPLOY_CICD.md`
- Required shared GitHub Actions secrets: `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY`, `COMPOSE_PATH`
- Required project-specific secrets: `JIAHUAN_DEPLOY_PATH`, `JIAHUAN_COMPOSE_SERVICE`, `JIAHUAN_PUBLIC_URL`
- The workflow runs `npm ci`, `npm test`, `npm run build`, syncs `dist/` to the VPS, runs `docker compose up -d jiahuan_web`, then checks the public URL.
- After syncing `dist/`, the workflow normalizes file permissions to `755` for directories and `644` for files so nginx can read them.
