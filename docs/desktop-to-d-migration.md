# Desktop projects to `D:\Dev`

This file is a compatibility-first inventory, not an instruction to bulk-move every folder. `D:\Projects` is the Mac transfer/archive tree and must not be merged with Windows working copies. Migrate one repository at a time to `D:\Dev\<Project>`, verify it, then retire only its exact old path.

## Current disposition

| Desktop folder | Current state | Recommended action |
| --- | --- | --- |
| `Canvas Tracker` | Non-Git legacy Study Core copy; contains absolute-path references | Consolidated into `D:\Dev\Study`; delete after final Study verification. |
| `Canvas Tracker.pre-study-20260818-0420` | Non-Git pre-merge backup | Superseded by Git history and production backups; delete with the old Study copies. |
| `Jiahuan` | Clean Git worktree on `migration/desktop-study-record-20260818`; has `node_modules` | Consolidated into `D:\Dev\Study`; delete after final Study verification. |
| `connection` | Clean `main`, GitHub origin, local deployment instructions and absolute paths | Good next migration candidate; update paths and re-register Codex after moving. |
| `Berkeley bot` | One dirty item on `init-upload`; Python virtual environment | Commit or stash intentionally, rebuild the virtual environment on D, then move. |
| `Interview` | Dirty `main` with many local changes and absolute paths | Do not move mechanically. Commit/snapshot first, then migrate and rerun Electron/FastAPI tests. |
| `intllm` | Dirty `main`; checked-in working tree has local `node_modules` | Commit or discard intentionally, exclude dependencies, reinstall on D. |
| `JobSearchingOS` | Dirty `main` with absolute paths | Commit/snapshot first, update path assumptions, then migrate. |
| `xianyu` | One dirty item; local instructions and absolute paths | Commit/snapshot first and verify nested dashboard/Workers paths after moving. |
| `Spaces` | Detached HEAD, no origin, local dependencies | Create a branch and a recoverable bundle before any move. |
| `Warehouse` | Detached HEAD, no origin, local dependencies | Create a branch and a recoverable bundle before any move. |
| `EbayPlugin` | Not a Git repository | Initialize/private-backup it before moving. |
| `Jobs` | Not a Git repository; contains Mac metadata | Inventory and normalize it separately before moving. |
| `.venv` | Shared environment rather than a project | Do not migrate as a project; recreate per-project environments instead. |

## Per-project migration checklist

1. Record the exact source and destination, Git branch, origin, dirty paths, ignored secrets, and any nested repositories.
2. Commit, stash, or make a recoverable archive before moving. Never merge the source into `D:\Projects`.
3. Copy source and data but omit `node_modules`, `.venv`/`venv`, build output, caches, and OS metadata. Reinstall dependencies on Windows.
4. Search tracked files for absolute `C:\Users\Administrator\...` paths, Mac `/Users/...` paths, shell assumptions, case-only filenames, executable-bit dependencies, and symlinks.
5. Add or verify `.gitattributes`, then run that repository's typecheck, tests, build, and local smoke checks from its D path.
6. Register/open the new folder with `codex.exe app "D:\Dev\<Project>"`. Existing task history keeps its original working-directory record; start new work from the D project instead of rewriting old task records.
7. Verify Git status and remote from the destination. Only then retire the exact old Desktop folder.

## Windows/Mac compatibility rule

Keep `D:\Projects` as the Mac archive until each project has an independently verified Windows destination. Do not reuse transferred `node_modules`, Python virtual environments, native binaries, or case-sensitive/symlink-dependent state. Source files and Git history are portable; generated environments are not.
