> 历史检查记录：文中的“未部署”指当时状态。2026-09-07 全量发布已完成，当前状态见 [统一发布记录](releases/2026-09-07-current.md)。

# Record subtitle interface

The subtitle canvas stays mounted and fills the screen. Settings open in a HeroUI Popover; history and transcript details open in a HeroUI Pro Sheet. Neither overlay restarts recording or ends the session. The floating Pro ActionBar keeps recording controls available on the main screen.

Course matching uses Seoul time on entry and refreshes while idle. The adjacent sync button reloads courses and the timetable and leaves manual selection. An active recording keeps its original course. Conflicting or unavailable schedules request manual selection.

Native components own buttons, selection, menus, confirmations, borders, focus, and overlay behavior. HeroUI Select filters replace browser-native dropdowns. History uses compact Pro ListView rows with export/archive menus. Page CSS owns layout and subtitle typography.

## Verification

- Desktop and 390px mobile renders checked with explicitly labeled local demonstration data.
- Checked settings overlay, original-language switch, history filters and empty results, transcript source expansion, course selection, and archive cancellation.
- App regression coverage includes final subtitle persistence, cancellation during resume, recording continuity through overlays, history errors inside the sheet, and manual-to-current-course synchronization without microphone startup.
- TypeScript, all 67 tests, and the production Sites build pass. The built Worker smoke test also passes against temporary D1 data.
- No microphone or production audio-provider test was performed during UI verification.

## Bundle optimization (2026-09-07)

Production asset sizes, using gzip separately for each file; these are build measurements, not a live network-speed benchmark:

| Assets | Before | After |
| --- | ---: | ---: |
| Initial JavaScript | 894.12 KB / 271.59 KB gzip | 680.87 KB / 212.28 KB gzip |
| Initial CSS | 772.06 KB / 78.37 KB gzip | 113.25 KB / 14.51 KB gzip |
| Initial total | 1,666.18 KB / 349.96 KB gzip | 794.12 KB / 226.79 KB gzip |
| All UI assets, including deferred history | 1,666.18 KB / 349.96 KB gzip | 1,021.12 KB / 279.55 KB gzip |

The initial gzip payload is 35.2% smaller. All UI assets combined are 20.1% smaller after gzip.

- `RecordHistory.tsx` and its CSS load when history or a transcript is opened. The initial HTML does not preload them. Once loaded, the Sheet stays mounted through close/open transitions. A slow import that finishes after closing cannot reopen it; a failed import displays a retry/close message while the subtitle owner remains mounted.
- CSS imports include only used HeroUI/Pro components and their underlying primitives, including Toolbar, Radio/RadioGroup, Checkbox, and Disclosure. Native appearances and states remain library-owned.
- Core's shared schemas and Record previously bundled two identical Zod 4.4.3 installations. Vite's supported [`resolve.dedupe`](https://v7.vite.dev/config/shared-options#resolve-dedupe) setting resolves both to the Record copy. Data validation remains enabled. Bundle inspection verifies one Zod root.
- The remaining initial bundle still exceeds Vite's 500 KB uncompressed chunk warning. That warning has not been suppressed.
- Desktop and 390px mobile checks cover the subtitle canvas, action bar, settings/size adjustment, course picker, first history opening, native filtering, and transcript expansion. Recording continuity and delayed-load cancellation are covered by mocked regression tests.

## Build and release prerequisites

The local `@heroui-pro/react` beta.8 installation contains the user's licensed component artifacts. The public npm package is a bootstrap package. Clean cloud installation follows the existing CollectUI channel with pinned `hpsetup@4.7.1` and an authorized `HEROUI_KEY`; see [Record cloud installation](record-cloud-build.md). The migration-added `HEROUI_AUTH_TOKEN` requirement was a mistaken channel assumption, not a prerequisite the user had previously configured. Do not commit licensed artifacts or keys, and do not assume `npm ci` alone reproduces this build.

This UI revision has not been published. The concurrent backend change introduces `items`, `nextCursor`, and `warnings` read contracts; Core and Record must be released together as described in `DEPLOY_CICD.md`. The authentication identity question remains separate from the UI redesign.
