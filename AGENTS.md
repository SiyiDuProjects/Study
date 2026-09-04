# Study repository instructions

## Product boundary

- This is the single Hanyang Study monorepo. Do not add Berkeley profiles or a provider/profile switcher.
- `apps/core` is the only service that receives or stores the Hanyang Canvas PAT.
- Canvas and MCP release scope is read-only. Do not add assignment submission, messaging, enrollment changes, file upload, or other Canvas mutations without a separately reviewed release.
- `apps/record` receives courses only from Study Core and stores transcript data in Sites D1. The only local course is `daily`.
- Do not persist raw classroom audio.

## Secrets

- Never commit or print Canvas PATs, OpenAI keys, master keys, OAuth tokens, session cookies, passkey material, invite tokens, Sites bypass tokens, or either internal service token.
- The two service-to-service directions use different random tokens.
- VPS secrets live only in `/home/ubuntu/siyi/canvas/.env` with owner-only permissions.
- Sites secrets are configured as secret environment variables.

## Commands

- Core root: `apps/core`
  - `npm.cmd run typecheck`
  - `npm.cmd test`
  - `npm.cmd run build`
- Record root: `apps/record`
  - `npm.cmd run typecheck`
  - `npm.cmd test`
  - `npm.cmd run build`
  - `npm.cmd run sites:build`

## Deployments

- Core SSH: `ubuntu@49.51.38.235:22`
- SSH identity: `D:\Projects\_private\Keys\Siyi.pem`
- Core Compose root: `/home/ubuntu/siyi`
- Core service directory: `/home/ubuntu/siyi/canvas`
- Core public origin: `https://study.siyidu.com`
- Core MCP: `https://study.siyidu.com/mcp`
- Core readiness: `http://127.0.0.1:8794/readyz`
- Record is deployed through OpenAI Sites and uses D1. Do not restore the old VPS `jiahuan_web` as the canonical Record service after cutover.

Before changing production, inspect the current state, make fresh data/config backups, validate the new build, verify local and public health separately, and retain a tested rollback path.

## Plugin

- Plugin root: `plugins/canvas`.
- Keep `.codex-plugin/plugin.json`, `.app.json`, all skills, and `.agents/plugins/marketplace.json` valid.
- Run plugin and skill validators after changes.
