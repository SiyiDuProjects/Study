# CI/CD Deployment

This repo deploys a Vite frontend plus a Node/Express API to the existing VPS used by the sibling `Interview` and `connection` projects.

GitHub repository: `https://github.com/SiyiDuProjects/Jiahuan`.

## What It Does

On every push to `main` that changes app, server, shared, Sites, or workflow files:

```text
GitHub Actions
-> Validate VPS build: npm ci -> npm test -> npm run build
-> Validate Sites build: npm ci -> npm run sites:build
-> wait for both validation jobs
-> package dist/, dist-server/, package.json, and package-lock.json
-> rsync release to VPS
-> npm ci --omit=dev inside a node:22-bookworm-slim container on the VPS
-> docker compose up -d jiahuan_web
-> SSH to VPS and curl local health URL
```

The workflow does not upload `.env` files or API keys. `OPENAI_API_KEY` must live in a VPS-side env file referenced by Docker Compose.
That key must support OpenAI Realtime client secrets. Text-only API gateways can be used for translation models only, not for starting live recording.

Sites-only changes under `worker/`, `db/`, `drizzle/`, `build/`, `.openai/`, or the Sites/Wrangler configuration files also trigger this workflow. The VPS and Sites builds run in separate jobs because both write to `dist/`.

## VPS And Sites Release Boundary

GitHub `main` is the shared source of truth for both deployment paths. A commit must pass both the Node/Express build and the Sites Worker/D1 build before the VPS deploy job can run.

The VPS remains the automatic production deployment:

```text
push main -> dual validation -> deploy jiahuan_web -> local VPS health check
```

OpenAI Sites is validated by the same GitHub Actions run but published separately from the exact same commit through Sites. Sites issues short-lived source credentials and owns the real D1 and runtime bindings, so do not store a Sites source token in GitHub Secrets and do not replace this flow with `wrangler deploy` using the placeholder local D1 ID.

```text
same validated commit -> Sites source push -> save Sites version -> private Sites deployment
```

The Sites runtime secret is managed in Sites, not copied from the VPS env file or GitHub. The current VPS SQLite database and Sites D1 database are independent. Before moving `jiahuan.gaid.studio` from the VPS tunnel to Sites, configure the Realtime-capable Sites secret, migrate and verify records, run a real microphone/translation/save check, and confirm the intended access policy.

For parallel acceptance testing, prefer a separate hostname such as `jiahuan-sites.gaid.studio`. Keep `jiahuan.gaid.studio` on the VPS until the cutover checklist is complete so the existing tunnel route remains the rollback path.

## Required GitHub Secrets

Use the same shared secrets as `Interview` and `connection`:

```text
SSH_HOST=49.51.38.235
SSH_PORT=22
SSH_USER=ubuntu
SSH_KEY=<authorized private key contents>
COMPOSE_PATH=/home/ubuntu/siyi
```

On this Mac, the authorized shared key is stored at:

```text
/Users/bytedance/Projects/keys/connection-prod-20260526.pem
```

Use that file for local SSH/scp, but never commit it or paste its contents into docs/logs. The corresponding Tencent Cloud SSH key is `connection_prod_20260526` / `lhkp-41patbaz`.

Project-specific secrets:

```text
JIAHUAN_APP_PATH=/opt/jiahuan/app
JIAHUAN_DATA_PATH=/opt/jiahuan/data
JIAHUAN_COMPOSE_SERVICE=jiahuan_web
JIAHUAN_LOCAL_HEALTH_URL=http://127.0.0.1:8091/api/health
```

`JIAHUAN_LOCAL_HEALTH_URL` is optional; the workflow defaults to `http://127.0.0.1:8091/api/health`.

No Sites token, D1 ID, or Sites runtime secret belongs in GitHub Secrets for this workflow.

## One-Time VPS Setup

Connect from this Mac:

```bash
ssh -i /Users/bytedance/Projects/keys/connection-prod-20260526.pem ubuntu@49.51.38.235
```

Create app and data directories:

```bash
sudo mkdir -p /opt/jiahuan/app /opt/jiahuan/data
```

Create `/home/ubuntu/siyi/jiahuan.env` on the VPS:

```text
OPENAI_API_KEY=sk-...
```

Use a server-side key with OpenAI Realtime access here. A text-only API/gateway will make `/api/realtime/client-secret` fail and the app cannot start recording.

Add this service to `/home/ubuntu/siyi/docker-compose.yml`:

```yaml
jiahuan_web:
  image: node:22-bookworm-slim
  container_name: jiahuan_web
  restart: always
  working_dir: /app
  command: npm run server:start
  ports:
    - "127.0.0.1:8091:3000"
  environment:
    NODE_ENV: production
    PORT: "3000"
    JIAHUAN_DB_PATH: /data/jiahuan.sqlite
    JIAHUAN_STATIC_DIR: /app/dist
    OPENAI_REALTIME_TRANSCRIPTION_MODEL: gpt-realtime-whisper
    OPENAI_TEXT_TRANSLATION_MODELS: gpt-5.4-mini,gpt-5.4-nano
  env_file:
    - /home/ubuntu/siyi/jiahuan.env
  volumes:
    - /opt/jiahuan/app:/app:ro
    - /opt/jiahuan/data:/data
```

Start it after the first deploy:

```bash
cd /home/ubuntu/siyi
sudo docker compose up -d jiahuan_web
curl http://127.0.0.1:8091/api/health
```

## Cloudflare Tunnel

Add or keep a public hostname on the existing VPS tunnel:

```text
Hostname: jiahuan.gaid.studio
Service: http://localhost:8091
```

The app uses the microphone, so it must be served over HTTPS. Cloudflare Tunnel provides HTTPS, and Cloudflare Access should protect the hostname because this is an internal app.

GitHub Actions checks health over SSH against the local VPS URL, so Cloudflare Access can stay enabled on the public hostname without needing an Access service token in CI.

## OpenAI Smoke Test

After changing OpenAI model environment variables or account permissions, run a controlled smoke test from a trusted machine or inside the VPS container:

```bash
OPENAI_API_KEY=sk-... npm run smoke:openai
```

The script requests short-lived Realtime client secrets for all classroom modes and performs one small Korean-to-Chinese text translation. It prints model names and expiry times, but not client secret values.

## Troubleshooting

- If `Configure SSH` fails, check `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY`, and repository access to organization secrets.
- If dependency installation fails on the VPS, check Docker availability and that the VPS can pull `node:22-bookworm-slim`.
- If `Refresh app container` fails, check that `/home/ubuntu/siyi/docker-compose.yml` contains `jiahuan_web`.
- If `/api/health` works but Realtime fails, check `/home/ubuntu/siyi/jiahuan.env`, `OPENAI_API_KEY`, and the configured `OPENAI_*_MODEL` variables. The recording path requires a Realtime-capable key, not only text-model access.
- If the public hostname fails but the local health check passes, check Cloudflare Tunnel routing and Cloudflare Access policy.
