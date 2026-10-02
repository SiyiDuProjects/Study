# Study repository instructions

## Product boundary

- This is the unified Study monorepo for Hanyang and Berkeley. Share the Canvas implementation, keep school extensions separate, and bind each authorization to one independent school account. Never use a global current-school setting.
- `apps/core` is the only service that receives or stores either school's Canvas PAT; each PAT is encrypted and bound to its independent account identity.
- Standard Canvas capabilities are shared by both schools. The user-approved 2026-09-21 coursework release permits explicit user-requested file upload, individual text/file assignment submission, and single-recipient Inbox send/reply with optional attachments. One account connection authorizes enabled Study capabilities; do not introduce separate read/write grants or repeat approval already given. Reads never mutate Canvas. Forwarding, enrollment changes, mark-as-read, quizzes, group/external-tool submissions and other mutations remain unsupported.
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

- Start at `docs/release-workflow.md` and `npm.cmd run release:status`. Run `release:check`, then `release:prepare` to create an immutable source/build manifest. Production evidence belongs in `docs/releases/latest.json` and its linked release report.
- Canonical edit locations are `plugins/study/skills`, `apps/core/src`, and `apps/record`. Generated Skills, installed caches, and `.deploy` release copies are not editing targets.
- Use `scripts/release/core-release.sh` for the inspected Core candidate and `scripts/verify-sites.mjs` for the live paged Record contract. Historical one-off `.deploy` scripts are not the default release workflow.

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

- Plugin root: `plugins/study`.
- The required delivery target is one online private Study plugin in one ChatGPT account, connected to both school accounts. Verify each account and migrate existing school scheduled tasks. A repository edit or local Codex installation is not delivery to ChatGPT.
- Local marketplace registration, cachebuster changes and Codex installation are optional local development steps only when the user explicitly requests them. Do not use them as the default plugin release workflow.
- `.app.json` maps the registered remote app; it does not upload local Skill files to ChatGPT. Verify the currently supported online import/update method before attempting publication, and verify the import result and actual Skill availability in the target ChatGPT account before claiming delivery.
- Keep `.codex-plugin/plugin.json`, `.app.json`, all skills, and `.agents/plugins/marketplace.json` valid.
- Run plugin and skill validators after changes.
