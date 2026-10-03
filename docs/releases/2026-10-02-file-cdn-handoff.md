# Native file CDN handoff repair — 2026-10-02

Native upload failed before any LMS write when the client handed off `sdmntprwestus.oaiusercontent.com`; production configured only `files.oaiusercontent.com` and `sdmntprwestus3.oaiusercontent.com`.

The repair accepts valid single-label subdomains of `oaiusercontent.com` on the default HTTPS port. It rejects lookalike suffixes, bare/nested domains, credentials, fragments and non-default ports unless an exact additional origin is explicitly configured. Extra origins remain exact, and the signed ChatGPT endpoint still requires its specific path, matching file ID and nonempty signature. Credential omission, no redirects, 20 MiB streaming limit and audio/video rejection remain in effect. This is Study's domain trust policy, not an official guarantee of a permanent CDN hostname list.

## Candidate and deployment

- Release: `20261002T113416998Z-b4a701a3e04c-ccb160ee59ee`; immutable manifest: `.deploy/releases/20261002T113416998Z-b4a701a3e04c-ccb160ee59ee/manifest.json`.
- Source SHA256: `ccb160ee59eeb47b15378b916b9c715bf45876d61ccb6c0a3326e74839b54790`.
- Core archive SHA256: `5ab21049f3174f6d67dc4dafbbb20d328f07281c48dd7e6262a4cfac9ac55c22`.
- Production image: `sha256:d114653a9df4142ca319a4f4c25110e50e07ef3ecfc9f89380f9c9febfb56f87`.
- Prior image: `sha256:6922523655cf026cdba6bd91d5217bc90dbef88cbc7f32c4260ec4726c4b9cc4`.
- Only runtime change versus the inspected production source: `apps/core/src/canvas/fileSources.ts`; its deployed and workspace SHA256 match `d848e826dc2b53935acc1759905c5eb45d5b40fe683392835d8493a2a87b00b6`.
- An isolated source checkout retained the deployed versions of the four unrelated message/submission receipt files. Its tests came from the previous immutable release package, because the production runtime directory's test copy was stale. The main workspace's unrelated changes and user-modified Record lockfile were preserved.
- Full release check passed: candidate Core 341 tests; Record 72 tests; release tooling 12 passed / 1 optional packaging fixture skipped; plugin/Skill validation, typechecks, builds and Worker smoke passed. The primary workspace independently passed 349 Core tests.
- `core-release.sh prepare` took fresh config, source and online SQLite backups under `/home/ubuntu/siyi/backups/study-20261002T113416998Z-b4a701a3e04c-ccb160ee59ee`. Integrity was OK, schema stayed at 10, and both new and prior images booted on copied databases. `activate` completed; local and public readiness were independently checked afterward.
- Use `sh /tmp/core-release.sh rollback 20261002T113416998Z-b4a701a3e04c-ccb160ee59ee` on the VPS if needed; it restores the prior image/source and preserves current database data. The previous image startup was tested on the candidate database copy; production rollback was not exercised.
- Record remained on its existing deployment. `scripts/verify-sites.mjs` verified 14 sessions, 560 segments across 287 detail pages, legacy and paged reads, no warnings, and 401 for missing identity/service credentials. No recording sessions were present before switching.

## Live acceptance

- Both Hanyang and Berkeley connection-status tools succeeded after activation, with existing authorization.
- Native upload of a generated, non-sensitive 103-byte text file succeeded on Hanyang: request `5cb3009a-3593-4cf0-91a3-e58bcde209cf`, Canvas file `11712217`. No Inbox message or assignment submission was performed.
- `get_file` returned a fresh signed download link; HTTP 200 returned exactly 103 bytes, SHA256 `578583d8d16b304fae81bbd087049c638b768e6fed3c1a1966abe75e2b2271ed`, matching local bytes and the upload receipt.
- The previously sent PDF (file `11711480`) also downloaded correctly: 80,247 bytes, SHA256 `e3b75ad10aaa60156664005b52a968dcf39ba9c8dab00c1365951a9ee53a9f11`, matching the local original. This was a read-only check; the professor message was not repeated.
- Public download checks used a browser User-Agent because the edge rejected Python's default UA with Cloudflare 1010. This is separate from the repaired upload-origin rejection.
- Tool schemas and Skills did not change, so this server patch required no plugin reimport, cache refresh or account reauthorization. Native upload/download calls verified the existing connected plugin after deployment. No new claim is made about Skill reimport or scheduled-task migration in this release.

## Preparation notes

An initial macOS archive was rejected before production mutation because AppleDouble entries were present. Final immutable preparation used `COPYFILE_DISABLE=1`. A subsequent preparation run as root could start both images but failed the non-root schema checker because the backup file was root-owned; production remained unchanged. Final preparation ran as the intended `ubuntu` user with a fresh release ID and passed every gate. Earlier failed preparation artifacts were retained; only the final release above was activated.
