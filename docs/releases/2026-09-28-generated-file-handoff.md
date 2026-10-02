# ChatGPT generated-file handoff repair — 2026-09-28

## Problem and fix

The original Hanyang conversation passed the actual generated PDF file ID to `upload_canvas_file`. Reading the same artifact's download descriptor showed `https://chatgpt.com/backend-api/estuary/content`, with an `id` matching that file ID and a temporary `sig`. Production accepted only the two configured CDN origins, so this endpoint did not pass source validation. Historical tool error bodies were not available in the retrieved conversation; the same-file descriptor, production configuration and deployed guard established the mismatch.

Core now accepts that exact HTTPS endpoint only when it has one `id` matching the native file reference and one nonempty `sig`. Signature validity remains enforced by ChatGPT when fetching the file. Other ChatGPT paths, lookalike hosts, custom ports, URL credentials, fragments, mismatched IDs and duplicate signature/ID parameters remain rejected. Existing exact CDN origins are retained. No wildcard hosts or entire-site exception was added.

Source requests explicitly omit credentials and retain manual redirects, the 20 MiB streaming bound, account/target binding and upload idempotency. The signed URL is neither logged nor persisted. The native tool schema and Skills were unchanged; no new OAuth grant, plugin import or local plugin installation is required by this server-only patch. The file parameter shape was checked against the [official file input reference](https://developers.openai.com/plugins/reference#file-apis).

## Isolated release and rollback

- Release: `20260928T025547964Z-0c8569c05fda-a5dba3f86b08`.
- Candidate built from the deployed September 21 source snapshot in a managed worktree. All 78 deployed Core source/package files matched that snapshot before release.
- The candidate differs in exactly three source-manifest files: `apps/core/src/canvas/fileSources.ts`, `apps/core/src/canvas/writes.ts` and `apps/core/test/canvas.fileSources.test.ts`.
- Existing unshipped changes to message/submission receipt handling in the primary workspace were preserved and excluded from this release. The new handoff fix was also applied to the primary canonical sources.
- Image: `sha256:6922523655cf026cdba6bd91d5217bc90dbef88cbc7f32c4260ec4726c4b9cc4`.
- Previous image: `sha256:1e0423a91ddfc697b3d5c3a1c05db5f7d27847d458171f9b8de912a1a6217398`.
- Archive SHA256: `e60d9ef7e558cbb53560bf0ab996a495bcc088c9c0ccbd1166a1c5a59599d52a`.
- Fresh source, Compose, owner-only environment and SQLite backups: `/home/ubuntu/siyi/backups/study-20260928T025547964Z-0c8569c05fda-a5dba3f86b08`.
- SQLite integrity passed; schema 10 was unchanged. Both candidate and previous images booted on copied data. No active recordings or recent pending Canvas writes were present before activation.
- The initial preparation ran as root and could not let the unprivileged schema verifier read its owner-only backup. It never activated. Its backups remain in the earlier `study-20260928T025042604Z-0c8569c05fda-a5dba3f86b08` directory. Preparation then completed under the normal deployment account without weakening file permissions.
- Rollback: run the retained `core-release.sh rollback 20260928T025547964Z-0c8569c05fda-a5dba3f86b08` as the deployment account. Retain the current database; no configuration changed. Record/Sites, its shared sources and scheduled tasks are unchanged.

## Verification and limits

- Isolated release: Core typecheck/build and 323 tests; Record typecheck/Sites build and 104 tests; 12 release tests passed, one optional fixture skipped; plugin/Skill validators and built Worker smoke passed.
- Primary workspace integration: 57 focused file-source/write tests and Core typecheck passed alongside the pre-existing local fixes.
- Internal readiness and public HTTPS readiness each returned 200 after activation. Both online school profiles and an authenticated Berkeley Canvas connection check passed.
- A generated benign local test file was handed through the connected Study upload tool to Hanyang. Receipt: request `280b4f97-8533-43d6-9bd6-378847ca8be0`, file `11675529`, 84 bytes, SHA256 `b6477bb0103d9d920dda226dee9ed70d8b71ccb8c09974ecfec741b7051535cd`.
- The complete receipt was independently read from the live ledger. The existing authenticated Canvas download component then fetched the actual LMS bytes and matched their size and SHA256 to the original local file. This test uploaded to the own-account message attachment folder; no message was sent and no assignment was submitted.
- The generated-file endpoint rule was checked in the deployed runtime. The original PDF's signed endpoint also returned HTTP 200 with PDF response metadata when the browser request's Cookie/Authorization headers were omitted; this metadata-only check is not claimed as a complete byte-transfer test.
- The original assignment `2807919` in course `215704` remained submitted, attempt 1, submitted at `2026-09-28T02:29:54Z`, missing false, with the existing PDF attachment `11675354`.
- The original ChatGPT conversation's full generate-PDF → upload → submit workflow was not replayed, because that assignment was already submitted. The Codex connected-tool upload/readback and the observed ChatGPT signed-endpoint check are distinct verification tiers.

Machine-readable delivery evidence: [latest.json](latest.json). No secrets, signed query strings or raw file bytes are included in this report.
