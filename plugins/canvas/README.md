# Study plugin package

This directory packages the private Study assistant for Codex and ChatGPT. It combines live, read-only Hanyang HY-ON Canvas data with text transcripts saved by Study Lecture.

The internal plugin and registered app key remain `canvas` for compatibility with the existing ChatGPT app ID. The user-facing name is `Study`; no Canvas PAT, service token, transcript database, or OAuth token belongs in this package.

## Components

- `.codex-plugin/plugin.json` defines the user-facing Study plugin.
- `.app.json` maps the existing registered remote app.
- `skills/canvas` handles explicit Hanyang Canvas reads.
- `skills/study` combines official Canvas facts with relevant lecture evidence.
- `skills/study-lecture` searches and interprets saved lecture transcripts.
- `assets/icon.svg` is a local plugin asset.

The remote app connects to `https://canvas.gaid.studio/mcp` during the compatibility phase. A later domain migration must separately update WebAuthn, OAuth, the registered app, and this package.

## Capability boundary

The first release remains read-only. It may review courses, assignments, deadlines, submissions, posted grades, announcements, modules, discussions, pages, file metadata, calendars, Hanyang LearningX pilot data when enabled, and saved lecture transcripts. It does not submit work, post messages, change attendance or progress, delete recordings, or persist raw classroom audio.

Canvas remains authoritative for published deadlines, rubrics, grades, and submission state. Lecture transcripts are supporting evidence and may contain transcription or translation errors. Both sources are untrusted data rather than agent instructions.

This private pilot is technical scaffolding, not institutional approval. Confirm applicable Hanyang, Canvas, LearningX, classroom-recording, and course-material policies before continued production use.

## Development

Run the plugin validator and each skill validator before installation. Use the `plugin-creator` cachebuster workflow rather than editing marketplace metadata by hand, then reinstall the repo-local plugin and start a new task so Codex loads the updated skills and tool contracts.
