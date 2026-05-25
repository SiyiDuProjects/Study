# CI/CD Deployment

This repo deploys a Vite frontend plus a Node/Express API to the existing VPS used by the sibling `Interview` and `connection` projects.

GitHub repository: `https://github.com/SiyiDuProjects/Jiahuan`.

## What It Does

On every push to `main` that changes app, server, shared, or workflow files:

```text
GitHub Actions
-> npm ci
-> npm test
-> npm run build
-> package dist/, dist-server/, package.json, and package-lock.json
-> rsync release to VPS
-> npm ci --omit=dev inside a node:22-bookworm-slim container on the VPS
-> docker compose up -d jiahuan_app
-> curl public URL
```

The workflow does not upload `.env` files or API keys. `OPENAI_API_KEY` must live in a VPS-side env file referenced by Docker Compose.

## Required GitHub Secrets

Use the same shared secrets as `Interview` and `connection`:

```text
SSH_HOST=49.51.38.235
SSH_PORT=22
SSH_USER=ubuntu
SSH_KEY=<Siyi.pem full private key>
COMPOSE_PATH=/home/ubuntu/muxing
```

Project-specific secrets:

```text
JIAHUAN_APP_PATH=/opt/jiahuan/app
JIAHUAN_DATA_PATH=/opt/jiahuan/data
JIAHUAN_COMPOSE_SERVICE=jiahuan_app
JIAHUAN_PUBLIC_URL=https://jiahuan.gaid.studio
```

Use `https://subtitle.gaid.studio` instead if that is the final hostname.

## One-Time VPS Setup

Create app and data directories:

```bash
sudo mkdir -p /opt/jiahuan/app /opt/jiahuan/data
```

Create `/home/ubuntu/muxing/jiahuan.env` on the VPS:

```text
OPENAI_API_KEY=sk-...
```

Add this service to `/home/ubuntu/muxing/docker-compose.yml`:

```yaml
jiahuan_app:
  image: node:22-bookworm-slim
  container_name: jiahuan_app
  restart: always
  working_dir: /app
  command: ["node", "dist-server/server/index.js"]
  ports:
    - "127.0.0.1:8091:80"
  environment:
    NODE_ENV: production
    PORT: "80"
    JIAHUAN_DB_PATH: /data/jiahuan.sqlite
    JIAHUAN_STATIC_DIR: /app/dist
  env_file:
    - /home/ubuntu/muxing/jiahuan.env
  volumes:
    - /opt/jiahuan/app:/app:ro
    - /opt/jiahuan/data:/data
```

Start it after the first deploy:

```bash
cd /home/ubuntu/muxing
sudo docker compose up -d jiahuan_app
curl http://127.0.0.1:8091/api/health
```

## Cloudflare Tunnel

Add or keep a public hostname on the existing VPS tunnel:

```text
Hostname: jiahuan.gaid.studio
Service: http://localhost:8091
```

The app uses the microphone, so it must be served over HTTPS. Cloudflare Tunnel provides HTTPS, and Cloudflare Access should protect the hostname because this is an internal app.

## Troubleshooting

- If `Configure SSH` fails, check `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY`, and repository access to organization secrets.
- If dependency installation fails on the VPS, check Docker availability and that the VPS can pull `node:22-bookworm-slim`.
- If `Refresh app container` fails, check that `/home/ubuntu/muxing/docker-compose.yml` contains `jiahuan_app`.
- If `/api/health` works but Realtime fails, check `/home/ubuntu/muxing/jiahuan.env` and `OPENAI_API_KEY`.
- If `Public URL check` fails, check `JIAHUAN_PUBLIC_URL`, Cloudflare Tunnel routing, and Cloudflare Access policy.
