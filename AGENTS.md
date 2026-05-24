# AGENTS.md

## Project

This repo is a React + Vite + TypeScript PWA for Korean class live subtitles and local transcript export.

## Commands

- Install: `npm.cmd install`
- Dev server: `npm.cmd run dev`
- Build: `npm.cmd run build`
- Test: `npm.cmd run test`

Use `npm.cmd` on Windows PowerShell because plain `npm` may be blocked by execution policy.

## Architecture

- `src/App.tsx`: app composition, live subtitle workflow, records and document views.
- `src/lib/realtimeTranslation.ts`: OpenAI Realtime Translation WebSocket client.
- `src/lib/audio.ts`: microphone sample conversion to 24 kHz PCM16 base64 frames.
- `src/lib/transcriptReducer.ts`: source/translation delta merging and segment commit logic.
- `src/lib/storage.ts`: IndexedDB sessions/settings.
- `src/lib/markdown.ts`: Markdown export.

## Constraints

- Do not save or persist raw classroom audio.
- Keep the live screen subtitle-first and uncluttered.
- Do not commit API keys or `.env` files.
- The browser API-key path is only for private prototypes; production should use server-issued short-lived client secrets.
