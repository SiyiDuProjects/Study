# Shared Canvas coursework and attachments — 2026-09-21

The user explicitly authorized releasing assignment submissions and file-bearing messages for both schools, with one Study account authorization and capability-oriented instructions. This is the separately reviewed expansion of the earlier Inbox-only release. Each school connection remains independent; there is no global current-school switch.

## Released behavior

- Shared `upload_canvas_file` and `submit_assignment` tools support both schools. Individual online file or text submissions can include a comment; unsupported exam, group and external-tool workflows are rejected explicitly.
- Existing `send_message` and `reply_message` accept optional attachments. There are no parallel text-only/attachment tool variants. Single-recipient explicit user intent remains required.
- Standard Canvas reads already used one client. Removed the inappropriate Hanyang-only message restriction and fixed Hanyang POST target; read and write services now share connection validation. See [the capability audit](../reviews/2026-09-21-shared-canvas.md).
- One existing Study authorization grants the advertised capabilities. The old `canvas.read` wire identifier is retained for connection compatibility; per-feature scopes no longer create additional authorization steps. School ownership, authentication and truthful mutation annotations remain.
- The native Canvas and Study Skill bodies describe available capabilities and flexible decision rules. GPT can discover the upload/submit tools through their catalog descriptions without the user naming tools or supplying a scripted sequence.

## Source and deployment

Current immutable candidate: `20260921T212243716Z-0c8569c05fda-d94a9ec222a9`.

- Source SHA256: `d94a9ec222a9635a27bfe03620dac2dbce7eedbac9bc4b19a8696971956ebb66`.
- Core image: `sha256:1e0423a91ddfc697b3d5c3a1c05db5f7d27847d458171f9b8de912a1a6217398`.
- Initial additive schema 9 → 10 release: `20260921T210433721Z-0c8569c05fda-2eb5e4358310`; exact `coursework-writes-v10` policy passed. The final candidate kept schema 10 unchanged.
- Fresh source/configuration/SQLite backups precede both deployments. Current backup directory: `/home/ubuntu/siyi/backups/study-20260921T212243716Z-0c8569c05fda-d94a9ec222a9`.
- Candidate and previous image both booted against copied migrated data. Actual activation, expected running image, local readiness and public readiness passed.
- Record and shared Record dependencies match the retained Sites version 10. No Record redeployment or scheduled-task changes were needed.

## Verification

Full release checks passed: 303 Core tests, 72 Record tests, 12 release tests (one optional Sites fixture skipped), typechecks, builds, plugin/Skill validation and Worker smoke. Parameterized tests cover both schools, file/submission receipts, attachment send/reply, retry locks, account/purpose binding and origin restrictions.

Live authenticated profile/course reads passed for both schools. Both existing online ChatGPT connections expose the new tools and optional message attachments without relinking. Native Canvas and Study main Skill bodies were saved, reloaded and compared exactly with canonical content (9,702 and 1,930 characters). The platform-generated Canvas card metadata remains an older read-only display snapshot; this does not describe a second implementation.

Real Canvas upload and readback passed on both schools using benign in-memory test text (69 bytes): Hanyang file `11643870`; Berkeley file `95491091`. These checks exercised real Canvas upload tickets, school storage transfer, Canvas confirmation, receipt persistence and authenticated readback. Their source was synthetic, so this evidence alone does not establish ChatGPT file handoff.

School storage origins were observed from each authenticated Canvas upload ticket and configured exactly: Hanyang `https://kr.object.gov-ncloudstorage.com`; Berkeley `https://inst-fs-iad-prod.inscloudgate.net`. No wildcard storage hosts or Canvas credentials sent to storage.

Actual ChatGPT generated-file and directly attached-file handoff both passed in [the live acceptance conversation](https://chatgpt.com/c/6ab19e1f-ec14-83ea-acc4-464ff15aa077). The natural-language test automatically discovered the capability, generated the benign file and verified both accounts. Initial source-origin rejection occurred before an LMS upload. The final candidate adds configurable exact ChatGPT source origins and origin-only diagnostics; the observed native-client source `https://sdmntprwestus3.oaiusercontent.com` is now enabled alongside `https://files.oaiusercontent.com`. Configuration was backed up before updating it; local/public health and the expected image passed after restart. No signed source URLs are recorded in release evidence.

| Actual ChatGPT input | Hanyang file | Berkeley file | Verified bytes |
| --- | --- | --- | --- |
| Generated `Study-generated-upload-check.txt` | `11643877` | `95491333` | 51 |
| Directly attached `Study-user-file-upload-check.txt` | `11643879` | `95491364` | 65 |

All four receipts were independently checked in the production ledger and against authenticated live Canvas file reads. Both generated-file copies have SHA256 `b3890e9726a710d9e505eaaee43c70cdf37c0beaf478224cfbe503e2b4f9e5da`; both directly attached copies match the original local file exactly, SHA256 `e1408a187580369d5dc16b3d35dea385ed9cdb0afa05d2bcd095cd96dc82d239`. The user does not supply download URLs or manually transform file parameters. Final profile/course reads and shared tool contracts passed again on both connections.

Operational bounds: 20 MiB files; no raw audio/video, quizzes, group assignments or external-tool submissions in this release. Exact file-source/storage allowlists intentionally require an inspected configuration addition if a provider introduces another origin.

No actual teacher message or assignment submission was used as a test. Those final operations are covered by fixtures, not a real course communication or grading event. The benign uploaded test files remain in the two own-account file stores.

## Rollback

Use the canonical `scripts/release/core-release.sh rollback <releaseId>` for the inspected release. The script restores the prior source/image while preserving current data. It does not restore `.env`: restore the corresponding fresh owner-only configuration backup separately when rolling back configuration. Never restore a stale database over new receipts. The immediate prior image is `sha256:d1c529a20b40a051fbc71ef50d99dfab5a869819a52ddbcb447c52eeb7bd9fba`; the pre-feature image is recorded in `latest.json` with its initial-release backup chain.

Machine-readable state and subsequent client handoff results: [latest.json](latest.json). Previous production evidence: [before-coursework.json](2026-09-21-before-coursework.json).
