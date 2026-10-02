# Mac development snapshot

This repository captures the working source of `Study` on 2026-10-02.

- Development branch: `main`. This migration commit is marked `[skip ci] [skip deploy]` to skip automatic deployment for this code synchronization only.
- On each computer, pull `main` before working; commit and push finished changes to the same repository. Keep environment files and real local data outside Git.
- Keep the local folder name `Study`. The four projects remain siblings under `Projects`, alongside `_private/Keys`.
- Restore the separate local migration package before installing private dependencies or using local data. No `.env`, SSH private keys, real databases or personal materials are published here.
- Install dependencies for macOS using the checked-in lockfiles. Windows `node_modules`, Python virtual environments, build outputs and caches are deliberately omitted.
- Licensed HeroUI Pro packages are supplied only in the local developer package. Jobs also requires its existing local `web/vendor` archive restored before installation.
- Existing `.env` locations are preserved; `.env.example` files remain public templates.
- Read the root migration instructions and each project's README/AGENTS instructions before running deployments.
