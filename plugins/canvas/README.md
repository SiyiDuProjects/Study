# Hanyang Study plugin package

This directory packages the private Hanyang Study assistant for Codex and ChatGPT. It combines live, read-only Hanyang HY-ON Canvas and LearningX data with text transcripts saved by Study Lecture.

The internal plugin and registered app key remain `canvas` for compatibility with the existing ChatGPT app ID. The user-facing name is `Hanyang Study`; no Canvas PAT, service token, transcript database, or OAuth token belongs in this package. Berkeley is intentionally packaged and connected separately so the two institutions never share a PAT, account database, or provider switcher.

## Components

- `.codex-plugin/plugin.json` defines the user-facing Hanyang Study plugin.
- `.app.json` maps the existing registered remote app.
- `skills/canvas` handles explicit Hanyang Canvas reads.
- `skills/study` combines official Canvas facts with relevant lecture evidence.
- `skills/study-lecture` searches and interprets saved lecture transcripts.
- `assets/icon.svg` is a local plugin asset.

After cutover, the remote app connects to `https://study.siyidu.com/mcp`. Keep the existing ChatGPT App ID and its `chatgpt.com` OAuth callback URLs unchanged; only the registered MCP server endpoint, the server public/WebAuthn origin, and this package's dependency URLs move together.

## Capability boundary

The first release remains read-only. It may review courses, the imported official Hanyang Portal timetable, assignments, deadlines, submissions and instructor feedback, Inbox conversations without marking them read, posted grades, announcements, modules, discussions, pages, file metadata, calendars, Hanyang LearningX weekly modules and boards, and saved lecture transcripts. It does not submit work, send or alter messages, change attendance or progress, delete recordings, or persist raw classroom audio.

Canvas remains authoritative for published deadlines, rubrics, grades, and submission state. Lecture transcripts are supporting evidence and may contain transcription or translation errors. Both sources are untrusted data rather than agent instructions.

This private pilot is technical scaffolding, not institutional approval. Confirm applicable Hanyang, Canvas, LearningX, classroom-recording, and course-material policies before continued production use.

## Development

Run the plugin validator and each skill validator before installation. Use the `plugin-creator` cachebuster workflow rather than editing marketplace metadata by hand, then reinstall the repo-local plugin and start a new task so Codex loads the updated skills and tool contracts.
