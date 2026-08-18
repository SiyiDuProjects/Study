# Study Lecture deployment

The existing VPS service remains `jiahuan_web` for the first compatible release. Branding changes do not rename the data directory or SQLite file.

## Pre-deploy checklist

1. CI automatically creates a consistent SQLite online backup, verifies `PRAGMA integrity_check`, and snapshots the complete old app release before a container that may run migrations starts. A manual deployment must do the same before replacing the app.
2. Confirm Study Core is reachable on the shared internal Docker network at `http://canvas:8794`.
3. Confirm the existing Cloudflare Tunnel routes the exact `lecture.gaid.studio` hostname to this service; do not create a Zero Trust Access application for public mode.
4. Confirm the operator has intentionally set `LECTURE_AUTH_MODE=public` for this single-owner deployment.
5. Run `npm.cmd test` and `npm.cmd run build`.

## VPS environment

Keep the environment file outside the release directory at `/home/ubuntu/siyi/jiahuan.env`. The canonical Compose root is `/home/ubuntu/siyi`. Populate every value described by `.env.example`. Production intentionally refuses to start without:

```text
STUDY_API_URL
STUDY_SERVICE_TOKEN
LECTURE_SERVICE_TOKEN
LECTURE_PUBLIC_ORIGIN
LECTURE_AUTH_MODE=public
OPENAI_API_KEY
```

Keep:

```text
LECTURE_DB_PATH=/data/jiahuan.sqlite
```

`LECTURE_AUTH_MODE=public` is an explicit exposure switch, not a default. Missing, differently cased, misspelled, or unknown values make production startup fail. In this mode every browser maps to the same internal Hanyang owner and there is no browser login. Host/Origin checks, the 2 MB request limit, OpenAI endpoint rate limits, and both service-token boundaries remain active.

## Compose shape

```yaml
jiahuan_web:
  image: node:22-bookworm-slim
  container_name: jiahuan_web
  restart: always
  working_dir: /app
  command: ["node", "dist-server/server/index.js"]
  ports:
    - "127.0.0.1:8091:3000"
  environment:
    NODE_ENV: production
    PORT: "3000"
    LECTURE_DB_PATH: /data/jiahuan.sqlite
    LECTURE_STATIC_DIR: /app/dist
    STUDY_API_URL: http://canvas:8794
  env_file:
    - /home/ubuntu/siyi/jiahuan.env
  volumes:
    - /opt/jiahuan/app:/app:ro
    - /opt/jiahuan/data:/data
  networks:
    - default
    - study_internal
```

Attach both services to their Compose default network for outbound HTTPS and to the same explicitly named `study_internal` network for private service discovery. Create `study_internal` with Docker's internal-network flag so only the default networks provide outbound routing. Do not publish an extra Study API port and do not share the SQLite volume with Canvas.

## GitHub Actions secrets

Production paths are not secrets or inputs. The workflow intentionally fixes and validates all of them and fails closed on a missing directory or symlink:

```text
app=/opt/jiahuan/app
data=/opt/jiahuan/data
backups=/opt/jiahuan/backups
compose=/home/ubuntu/siyi
service=jiahuan_web
local health=http://127.0.0.1:8091/api/health
public health=https://lecture.gaid.studio/api/health
```

Configure only these GitHub Actions secrets:

```text
SSH_HOST
SSH_PORT
SSH_USER
SSH_KEY
SSH_KNOWN_HOSTS=<pinned known_hosts line, not a runtime ssh-keyscan result>
```

The workflow never accepts a secret-provided public URL. Its public health check is fixed to `https://lecture.gaid.studio` and sends no credentials.

## Backup and rollback behavior

- The release is installed in a staging directory before the active app is touched.
- Each deploy creates a mode `0700` timestamped directory under `/opt/jiahuan/backups` containing the old app and a mode `0600` online SQLite backup. The live data directory is `0700`; the database and any WAL/SHM files are `0600`.
- The new app replaces the active release only after the backup passes `integrity_check`.
- If replacement, force-recreate, or the local health check fails, CI stops the service, restores the old app snapshot, and force-recreates the old service. The database backup is retained for controlled recovery and is not copied automatically over a database that may already contain new writes.
- Migrations must therefore remain additive and readable by the immediately previous app release.
- A public DNS or Cloudflare Tunnel health failure is reported separately after local health succeeds; it does not roll back an otherwise healthy app.
- Do not delete the newest rollback snapshot during the same deployment. Apply a separate retention policy only after the new release is confirmed.

## Verification

Verify separately:

```text
container running
http://127.0.0.1:8091/api/health
public health without credentials
public browser API accepted only on the exact hostname; cross-origin writes rejected
internal MCP request without LECTURE_SERVICE_TOKEN rejected
Hanyang course refresh succeeds through Study Core
old lecture records remain visible
records carrying finalizationWarning are visibly marked as possibly incomplete
```
