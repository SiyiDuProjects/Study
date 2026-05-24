# CI/CD Deployment

This repo deploys a static Vite build to the existing VPS used by the sibling `Interview` and `connection` projects.

GitHub repository: `https://github.com/SiyiDuProjects/Jiahuan`.

## What It Does

On every push to `main` that changes app or workflow files:

```text
GitHub Actions
-> npm ci
-> npm test
-> npm run build
-> rsync dist/ to VPS
-> normalize static file permissions
-> docker compose up -d jiahuan_web
-> curl public URL
```

The workflow does not upload `.env` files or API keys. This app currently asks for the OpenAI API key in the browser, so production should be private or protected by Cloudflare Access until a backend issues short-lived client secrets.

## Required GitHub Secrets

Use the same organization-level shared secrets as `Interview` and `connection`, and allow this repository to access them:

```text
SSH_HOST=49.51.38.235
SSH_PORT=22
SSH_USER=ubuntu
SSH_KEY=<Siyi.pem full private key>
COMPOSE_PATH=/home/ubuntu/muxing
```

Add these project-specific secrets:

```text
JIAHUAN_DEPLOY_PATH=/opt/jiahuan/dist
JIAHUAN_COMPOSE_SERVICE=jiahuan_web
JIAHUAN_PUBLIC_URL=https://jiahuan.gaid.studio
```

Use `https://subtitle.gaid.studio` instead if that is the final hostname.

## One-Time VPS Setup

Create the static asset directory:

```bash
sudo mkdir -p /opt/jiahuan/dist
```

Add this service to `/home/ubuntu/muxing/docker-compose.yml`:

```yaml
jiahuan_web:
  image: nginx:alpine
  container_name: jiahuan_web
  restart: always
  ports:
    - "127.0.0.1:8091:80"
  volumes:
    - /opt/jiahuan/dist:/usr/share/nginx/html:ro
```

Start it once:

```bash
cd /home/ubuntu/muxing
sudo docker compose up -d jiahuan_web
curl http://127.0.0.1:8091/
```

## Cloudflare Tunnel

Add a public hostname to the existing VPS tunnel:

```text
Hostname: jiahuan.gaid.studio
Service: http://localhost:8091
```

or:

```text
Hostname: subtitle.gaid.studio
Service: http://localhost:8091
```

The app uses the microphone, so it must be served over HTTPS. Cloudflare Tunnel provides that for the public hostname.

## GitHub Repository

The local checkout should point at the organization repository:

```powershell
git remote set-url origin https://github.com/SiyiDuProjects/Jiahuan.git
git push -u origin main
```

If recreating from scratch with GitHub CLI:

```powershell
gh auth login -h github.com
gh repo create SiyiDuProjects/Jiahuan --private --source=. --remote=origin --push
```

## Troubleshooting

- If `Configure SSH` fails, check `SSH_HOST`, `SSH_PORT`, `SSH_USER`, `SSH_KEY`, and repository access to organization secrets.
- If `Upload static files` fails, check that the SSH user can run `sudo rsync` and that `/opt/jiahuan/dist` exists or can be created.
- If `Refresh static container` fails, check that `/home/ubuntu/muxing/docker-compose.yml` contains `jiahuan_web`.
- If `Public URL check` fails, check `JIAHUAN_PUBLIC_URL` and the Cloudflare Tunnel public hostname.
