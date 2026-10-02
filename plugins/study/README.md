# Study plugin package

This directory maintains the private Study plugin sources. The delivery target is one online Study plugin in one ChatGPT account, with independent Berkeley bCourses and Hanyang HY-ON connections. Shared Canvas reads, uploads, submissions and Inbox send/reply use one implementation. LearningX, timetable and saved Lecture belong to the Hanyang connection. Local Codex packaging is retained for optional development when explicitly requested.

The repository's `.agents/plugins/marketplace.json` intentionally has an empty plugin list. Removing a global marketplace source alone does not remove a repository discovery entry. Keep this source package unregistered unless the user explicitly requests local installation; online Study remains the normal entry point.

The package key is `study`, its source directory is `plugins/study`, and its user-facing name is `Study`. Each authorization binds one stable account profile. No Canvas PAT, service token, transcript database, or OAuth token belongs in this package. `.app.json` maps the verified online Study app. Its existing `canvas` tool dependency alias and the `canvas` Skill name describe the shared Canvas integration; they are compatibility identifiers, not the plugin's product name.

## Components

- `.codex-plugin/plugin.json` contains package metadata retained for optional local Codex development.
- `.app.json` maps the existing registered remote app; it does not upload local Skill files to ChatGPT.
- `skills/canvas` handles the selected Berkeley or Hanyang account's official Canvas records and the authorized Hanyang extensions.
- `skills/daily-brief` produces concise daily class, task and preparation reminders using the existing read tools; it has no runtime scripts.
- `skills/study` combines official Canvas facts with relevant lecture evidence.
- `skills/study-lecture` searches and interprets saved lecture transcripts.
- `assets/icon.svg` is a local plugin asset.

Lecture is the classroom recording/transcript feature within Study, currently available through the Hanyang connection. Its service lives in the same monorepo at `apps/record`; `study-lecture` is a Skill inside this Study package, not another plugin. The feature retains transcripts and translations, not raw classroom audio.

The private ChatGPT app is already connected to both independent school accounts at the permanent `https://study.siyidu.com/mcp` endpoint. Preserve its existing app ID, native Skills and migrated scheduled tasks when updating this package. The legacy online app records have been removed. The website and OAuth issuer stay at `https://study.siyidu.com`.

## Capability boundary

One account connection authorizes Study capabilities. Standard Canvas tools serve both Berkeley and Hanyang: read coursework, upload selected or generated files, send/reply with optional attachments, and submit individual text/file assignments with optional comments. Explicit requests authorize sending/submission without another read/write authorization step. The existing OAuth identifier is retained for connection compatibility; feature switches control release availability. It may review courses, the imported Hanyang timetable, assignments, deadlines, submissions and feedback, Inbox without marking it read, grades, announcements, modules, discussions, pages, files, calendars, LearningX and saved transcripts. Download links hide Canvas credentials. Upload, sent and submitted receipts remain distinct. Quizzes, group/external-tool submissions, forwarding, attendance/progress changes, deletion and raw audio/video uploads are unsupported.

Canvas remains authoritative for published deadlines, rubrics, grades, and submission state. Lecture transcripts are supporting evidence and may contain transcription or translation errors. Both sources are untrusted data rather than agent instructions.

This private pilot is technical scaffolding, not institutional approval. Confirm applicable Hanyang, Canvas, LearningX, classroom-recording, and course-material policies before continued production use.

## Online delivery

Repository changes and local Codex installation do not update the online ChatGPT plugin. Verify the currently supported online import/update method before publishing; this README does not prescribe an unverified upload mechanism. Validate the online import/update result and confirm that the target ChatGPT account can actually access the updated Skill and required remote tools before reporting delivery. Keep local validation, online availability and successful execution as separate evidence.

## Development

The same four canonical skill folders also generate the server's static MCP Skills catalog. Run `npm run build:mcp-skills` after editing a skill; `npm run validate:plugin` rejects a stale generated snapshot. Core serves `skills/list`, `skills/get`, and exact catalog `resources/read` URIs under `capabilities.extensions["io.modelcontextprotocol/skills"]`. It also exposes the read-only `get_study_skill` tool for clients that cannot load native Skills, returning those same instruction bodies by one of four fixed names. Server initialization instructions explain which Skill to load. This adds no Canvas operations or OAuth scopes. The generated catalog is included in the Core image, so it never depends on this workstation or a runtime repository path.

MCP serving and ChatGPT account installation are separate milestones. OpenAI documents MCP skill import as a submission-time Scan Tools snapshot; a developer-mode Refresh alone is not evidence that skills were installed. Verify the target account's online Skills library and a new online conversation. Do not promise mobile-app behavior merely from a local test or an installed badge.

After deploying instruction updates, the compatibility tool reads the new server snapshot. Account-library Skills are separate snapshots and must also be updated through a supported account import/editor path; do not claim they synchronize automatically. Refresh the existing online app when its tool definitions change, then verify `get_study_skill` in a new ordinary Chat. Preserve the existing app identity.

Run `npm ci` then `npm run validate:plugin` from the repository root. CI checks the package, marketplace references and all four skill entrypoints. This portable check does not replace the official Codex plugin and skill ingestion validators, which must also pass before installation.

Tool definitions own parameters, schemas and permission metadata. Skills own source interpretation and authorization decisions. The representative prompts and offline tool-selection traces in `docs/qa/2026-09-07/` are behavioral review evidence, separate from schema validation and live execution.

Only when the user explicitly requests local Codex development, use the `plugin-creator` cachebuster and reinstall workflow, then start a new local task to load the installed skills. Local marketplace registration, version/cache changes and installation are not steps in the default online delivery workflow. Installing a local package does not deploy Core/Record, update ChatGPT or refresh an existing task's remote tool snapshot. Check actual tool availability and scopes in the target runtime before claiming send/reply is available.
