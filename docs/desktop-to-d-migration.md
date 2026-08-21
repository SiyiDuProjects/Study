# Project consolidation into `D:\Projects`

`D:\Projects` is the single Windows project container. It is deliberately not a Git repository; each product keeps its own repository boundary.

## Study consolidation

The former Canvas and lecture-recording projects are now one product:

- `D:\Projects\Study\apps\core`: Hanyang Canvas, OAuth, and MCP service.
- `D:\Projects\Study\apps\record`: Study Record website and transcript storage integration.
- `D:\Projects\Study\plugins\canvas`: Canvas plugin and Study skills.

The empty legacy `Canvas Tracker` directory is not a second Study codebase. Remove it after the old Codex process releases the working directory.

## Other duplicate projects

- `Interview`: the Desktop workspace is the consolidation base. The Mac commits and working-tree snapshot are imported into the same repository through dedicated Git branches and a merge commit.
- `Connection`: the Mac workspace is the consolidation base because it contains the Desktop `origin/main` plus one additional commit and local changes. The clean Desktop copy adds no unique content.

## Recovery and secrets

- Original snapshots: `D:\Projects\_archive`.
- Project keys: `D:\Projects\_private\Keys`.
- Never initialize Git at `D:\Projects`, and never move `_private` into a product repository.

Keep the snapshots until every destination has passed its own Git, build, and runtime checks. Existing task history may retain old working-directory metadata; new work should start from `D:\Projects\<Project>`.
