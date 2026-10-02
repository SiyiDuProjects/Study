# Mac development snapshot

This branch captures the working source of `Study` on 2026-10-02.

- Branch: `codex/mac-migration-20261002`. The production/default branch was not deployed by this migration.
- Keep the local folder name `Study`. The four projects remain siblings under `Projects`, alongside `_private/Keys`.
- Restore the separate local migration package before installing private dependencies or using local data. No `.env`, SSH private keys, real databases or personal materials are published here.
- Install dependencies for macOS using the checked-in lockfiles. Windows `node_modules`, Python virtual environments, build outputs and caches are deliberately omitted.
- Licensed HeroUI Pro packages are supplied only in the local developer package. Jobs also requires its existing local `web/vendor` archive restored before installation.
- Existing `.env` locations are preserved; `.env.example` files remain public templates.
- Read the root migration instructions and each project's README/AGENTS instructions before running deployments.
