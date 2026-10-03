# Record interrupted-session recovery release — 2026-10-02

Record version 11 is deployed successfully. Interrupted recordings now serialize failed-state writes before resuming, retain End ownership until pending flushes settle, reconcile uncertain server writes with the existing lease, and preserve received transcripts. The retained transcribe-then-translate branch preserves known source text while translations are pending; it was not enabled in the UI. WebRTC setup failures and unmount flush failures clean up safely.

## Source and validation

- Main repository commits: Core CDN repair `3e81668`, Record repair `672e085`, optional WASM lock metadata repair `85496e7`; all pushed to `origin/main`.
- The reviewed Core CDN change already matches production SHA256 `d848e826dc2b53935acc1759905c5eb45d5b40fe683392835d8493a2a87b00b6`. Local readiness and public readiness passed. No Core activation or VPS maintenance window was required for this Record release.
- Candidate: `20261003T013814717Z-672e085bc9b6-6dfe396a7e7e`. UTC identifiers cross midnight; this report uses the user's October 2 Pacific date.
- Manifest: `.deploy/releases/20261003T013814717Z-672e085bc9b6-6dfe396a7e7e/manifest.json`.
- Full isolated release check: Core 349 tests, Record 105 tests, release tooling 12 passed / 1 optional fixture skipped; plugin validation, typechecks, builds and built Worker smoke passed.
- The isolated candidate deliberately retained the committed lockfile during initial publication. Subsequent CI exposed its missing optional WASM version metadata. The user's existing lockfile adjustment repaired that metadata without changing root dependencies or existing dependency versions; it was reviewed and committed separately as `85496e7`. It does not change the deployed runtime.
- The source snapshot now includes `apps/record/tests`, preserving the cross-runtime integration fixture in the release evidence. The D1 backup verifier includes the existing `school_caption_courses` table.

## Sites publication

- Project: `appgprj_6a84ba7dde3c81919d5d4a71c2cbbfff`; existing public access mode and environment revision 6 preserved.
- Source commit: `b63573a470415275bd92f20f7b9bca0118e1cefa`.
- Version 11: `appgprj_6a84ba7dde3c81919d5d4a71c2cbbfff~appgver_d671a8c05f408191af1fe2c9c8689be9`.
- Successful deployment: `appgdep_6ac05d6c272c8191ace83295cc12eb78`.
- Native deployment URL: https://study-record.dusiyi0916.chatgpt.site ; verified canonical URL: https://lecture.siyidu.com . The Sites metadata still advertises the obsolete lecture.gaid.studio URL; it was not used for verification.
- Official Sites workflow pushed the exact source and packaged the previously validated immutable build. All 16 archive files match the candidate by SHA256. Upload archive SHA256: `a519e767d7d4d69b7e560b105ebb0fcedbdf1c826273b805f9e0c1d6c8265d64`.
- Relative to prior Sites source, runtime changes are limited to the four reviewed Record client/reducer files. Worker, D1 migrations, Core shared contracts and secrets did not change.

## Data protection and read-only verification

- Fresh owner-only logical export: `.deploy/backups/record-before-recovery-20261002.json`; SHA256 `b2763a10f63dda9a4e7df894f5fe80b5682b2c3ea05a3cfe9022940383da09fe`.
- Restored in memory using current migration SQL: integrity and foreign keys passed. Counts: 2 metadata rows, 7 courses, 7 school-caption course rows, 14 sessions, 560 transcript segments.
- All sessions were ready and unchanged between backup and immediate pre-deploy reread. Post-deploy sessions and transcript rows exactly matched the backup. Metadata/course synchronization timestamps changed during the window; they were not overwritten from backup.
- Environment configuration metadata was retained owner-only under `.deploy/backups/record-environment-before-recovery-20261002.json`. Secret values are not returned by Sites and remain in the unchanged existing secret store.
- `scripts/verify-sites.mjs` ran read-only inside the existing Core container with its configured credentials and completed successfully: 14 sessions, 7 list pages, 560 segments, 287 detail pages, zero warnings, legacy list/detail/search passed, missing browser identity and service credential both returned 401. This check began before the switch and completed afterward; Worker code is unchanged.
- After deployment, canonical public root returned 200 and referenced `index-DrhvVNJy.js`; anonymous `/api/sessions` returned 401; Core public `/readyz` returned 200. Native Sites reported deployment succeeded.
- No real audio, recording session creation, assignment submission, Inbox send or school upload was performed.

## Rollback and remaining boundary

Prior version 10 remains archive-backed and available: `appgprj_6a84ba7dde3c81919d5d4a71c2cbbfff~appgver_116d373ff02c819196c2d149a4eee4c4`, source `4064f16ee09ef068ba1d4ef70fbaaf35d985523b`. Its saved artifact and successful deployment were checked through Sites. For rollback, first recheck no recording clients, redeploy that saved version with unchanged environment, reload clients and repeat read-only contract checks. Preserve D1 data; do not restore the backup over newer records. No production rollback was exercised. The generic Core archive in the candidate was not activated and is not a request to deploy unrelated historical Core differences.

At publication, GitHub CI installed dependencies but failed the licensed artifact check: https://github.com/SiyiDuProjects/Study/actions/runs/37087305875 . The initial diagnosis incorrectly prescribed a direct HeroUI website CI/CD token. Both that `HEROUI_AUTH_TOKEN` injection and the preflight were newly added by migration commit `d2205e5`; the user had not omitted a previously established setup. The subsequent repair uses the existing CollectUI channel, exact `hpsetup@4.7.1` / Pro beta.8, and the `HEROUI_KEY` installation secret. See [cloud installation](../record-cloud-build.md) for the actual remaining configuration and validation boundary. No local token transfer was performed. Record v11, Core, D1 and existing production secrets remain unchanged by the CI repair.
