> 历史检查记录：文中的“未部署”指当时状态。2026-09-07 全量发布已完成，当前状态见 [统一发布记录](../../releases/2026-09-07-current.md)。

# Online Hanyang Skills release — 2026-09-07

The required destination is the user's online ChatGPT account, including use from other devices. Local Codex installation does not meet this requirement.

## MCP implementation and verification

The existing Study Core MCP now advertises the bounded static `io.modelcontextprotocol/skills` extension. It provides `canvas`, `daily-brief`, `study`, and `study-lecture` through `skills/list` and `skills/get`, plus eight exact `skill://hanyang-study/...` resources with verified SHA-256 digests. Unknown resource URIs, normalization aliases and path traversal are rejected. A compatibility read tool, `get_study_skill`, returns the identical four instruction bodies to clients without native Skill loading. It requires only existing `canvas.read`; no new OAuth scopes, Canvas writes or runtime skill scripts were added.

`scripts/build-mcp-skills.mjs` uses the canonical four skill folders to generate `apps/core/src/mcp/studySkillCatalog.generated.ts`. Text is normalized to LF consistently with `.gitattributes`. The repository plugin check rejects stale generated content.

Core typecheck, all 214 tests (including ten Skill protocol/compatibility tests), build, repository plugin checks and official plugin/four-Skill validators passed. The clarification to daily-brief explicitly limits material delivery to read-only links; its validator and rebuilt catalog also passed.

Production was built from its current source, overlaying only `src/mcp/server.ts`, `src/mcp/staticSkills.ts`, and `src/mcp/studySkillCatalog.generated.ts`. The unrelated local LearningX attendance fix was excluded. Fresh source/config/SQLite backups and candidate/rollback startup tests were performed on the server. Protocol verification fetched all four entries and all eight resources and checked every digest. Local readiness and both public origins (`study.siyidu.com`, legacy `canvas.gaid.studio`) were checked independently.

Initial Skills image: `sha256:da6fb64bc073cf0a35a0003902860f5f39b37ba4ae23536ce22f83df0f75c1f9`.

Final wording image: `sha256:2e6dfa31517fb18e726ce61a21496ba0b3e0f665fb1329846094da67c7ea18d4`.

Compatibility image: `sha256:f604efec93f539b6827b7271c09965ebc392d633e5f639a00ef6895b214f2108`. This release overlays the same three files and a two-line optional success-formatter addition to the production `canvasTools.ts` helper. The local unshipped `tools.ts` refactor is not deployed. Candidate verification checks initialization instructions, raw tool-list OAuth metadata, all four tool-returned bodies against resource text, all eight digests, and candidate/rollback startup on a copied database. Raw `tools/list` is used because the SDK convenience client's schema strips root extension fields.

Server backups: `/home/ubuntu/siyi/backups/study-mcp-skills-20260907`, `/home/ubuntu/siyi/backups/study-mcp-skills-final-20260907`, and `/home/ubuntu/siyi/backups/study-mcp-skills-chat-20260907`, each with a rollback script. Secret backups remain on the server; no secret values are part of this report or the plugin. Latest config/database backups have mode 600 and rollback mode 700. Local readiness and both public origins passed again after compatibility deployment.

## Online account installation

The existing developer-mode plugin identity was preserved: `asdk_app_6a83fd77641c8191b3b7d00144ee33e2`. Refreshing it did not visibly add a Skills section. This was not treated as successful Skill import.

The current personal Pro account's online Skills editor was available despite narrower plan descriptions in some documentation. Four skills were created through that editor and then visibly listed under Installed:

- Canvas: `https://chatgpt.com/skills/editor/6a9f1c63174881919332d2db04eb306c`
- Study: `https://chatgpt.com/skills/editor/6a9f1d1bfb248191b776d3f3eacdf66c`
- Study Lecture: `https://chatgpt.com/skills/editor/6a9f1d3a37688191982551e1de6116b5`
- Daily Brief: `https://chatgpt.com/skills/editor/6a9f1e12a6b881919a8dd19cdb27b93e`

These are account-owned online Skills used with the existing Hanyang Study app. No evidence establishes that the account-library entries have become children of that plugin wrapper. The editor generated its own presentation metadata; source names, descriptions and instruction bodies were entered from the canonical files. The browser's file chooser was unavailable, so this was not a ZIP upload.

The first ordinary Chat test (`https://chatgpt.com/c/6a9f1eb8-081c-83e9-884b-aa6a7b85b961`) could not load any of the four native Skill bodies, although the account library showed Installed. Its existing `get_timetable` call succeeded with seven courses. This prompted the compatibility read tool; native Skill loading must not be reported as passed.

After compatibility deployment, the existing app was refreshed and its online settings visibly list `get_study_skill` with `canvas.read`. A new ordinary Chat passed the read test: `https://chatgpt.com/c/6a9f2262-7e80-83ea-ab61-a400e69bdb47`. It reported successful full instruction reads for all four names with the matching headings `# Canvas`, `# Hanyang Daily Brief`, `# Study`, and `# Study Lecture`; `get_timetable` succeeded with seven courses. This verifies the web Chat account's remote instruction access through the compatibility tool. The native mobile app and scheduled-task execution have not been directly tested, and native Skill loading is still distinct from this successful tool-based route.

The official developer-mode FAQ checked on 2026-09-07 states that MCP apps are web-only and are not available on mobile. This prevents promising native mobile-app support from the web test. Using ChatGPT through a phone browser is the proposed web route, but that device/browser combination was not directly tested in this run. The entire server instruction/data path is remote and does not require the Windows workstation to remain running.

## Why the earlier delivery went to the wrong place

The earlier workflow followed the repository's local marketplace/cachebuster installation instructions and stopped at local package validation. It incorrectly treated an `.app.json` reference to the online MCP connection as if it also published local Skill files. The user's requested destination should have governed acceptance. AGENTS.md and both READMEs now explicitly require online delivery and distinguish it from local developer installation.

## Sources

- https://developers.openai.com/plugins/build/mcp-server#import-skills-from-the-mcp-server
- https://developers.openai.com/plugins/deploy/submission
- https://learn.chatgpt.com/docs/build-skills
- https://help.openai.com/en/articles/20001066
- https://help.openai.com/en/articles/12584461
