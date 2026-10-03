# Record cloud installation

Study keeps `@heroui-pro/react` at **1.0.0-beta.8**. Record v11 was built with the existing licensed beta.8 artifacts; this installation repair does not redeploy it, change Core, or upgrade the UI library.

The user's existing distribution channel is **CollectUI**, using `hpsetup` and the installation key named `HEROUI_KEY`. A CollectUI MCP/Skills personal token is not an installation key. Direct heroui.pro website authentication and `HEROUI_AUTH_TOKEN` are a different channel.

Migration commit `d2205e5` introduced `HEROUI_AUTH_TOKEN` injection and the artifact preflight on October 2. That was an incorrect assumption in our migration configuration, not an existing requirement the user forgot to configure. The first failure also exposed optional WASM lock metadata, repaired separately in `85496e7`. The subsequent artifact failure showed that plain `npm ci` installed only the public bootstrap package.

## Maintained installation sequence

From the repository root, after installing the frozen dependencies:

```sh
npm ci
npm ci --prefix apps/core
npm ci --prefix apps/record
npm run install:record-pro
npm run check:record-dependencies
npm run typecheck
npm test
npm run build
```

Windows PowerShell can use `npm.cmd`. `install:record-pro` requires `HEROUI_KEY` to be supplied by the authorized build environment; commands and repository files contain no key value. Run `npm run test:record-install` for credential-free synthetic installation tests.

The root dependency pins `hpsetup` to **4.7.1**. Its reviewed internal `downloadFromProxy` function requests exact beta.8 with the CI flag. We do not invoke the CLI's upgrade-to-latest, peer installation, configuration rewriting, or fallback paths. The download is staged, then checked for the package name/version, runtime/types, and CSS files imported by Record before copying it into `node_modules`. Missing, empty, or wrong-version artifacts fail. The subprocess has a two-minute deadline; provider output is captured and errors are replaced with static guidance so authenticated URLs cannot appear in logs. Keep the helper pin until its internal interface is reviewed again. GitHub uses a fresh runner without a restored HeroUI artifact cache.

Existing local licensed artifacts remain usable with `npm run check:record-dependencies`; developers do not need to run the installer merely to validate an already working checkout. Neither licensed artifacts nor credentials belong in Git.

## Minimum cloud configuration still required

The Study workflow references **one repository Actions secret: `HEROUI_KEY`**. It needs a valid CollectUI installation key authorized for this Study build. It does not require a new purchase or a direct HeroUI website CI/CD token. Repository secret names were checked and none were present; no existing same-purpose secret can simply be renamed.

No local token was read or transferred, and no secret was obtained from Connection. The earlier automatic approval rejection of local credential transfer remains in force. Supplying an actual value through an explicitly authorized configuration action remains outstanding. Changing the workflow reference to the correct channel does not authorize moving a credential.

The exact beta.8 download has **not** been verified against CollectUI with a real key in this repair. Synthetic tests cover the pinned-version gate, successful staged installation, missing/wrong credentials, wrong versions, incomplete files, cleanup and redacted provider errors. The live cloud installer must still retrieve beta.8 successfully and pass the full workflow before CI is reported green. An unavailable beta.8 must fail for review, never silently upgrade to beta.9 or downgrade.

Read-only implementation reference: Connection `web/docs/cloud-build.md` and `web/scripts/install-reviewed-pro.mjs`. Only their public installation code was consulted; that repository and its credentials were not modified or copied. Public package source reviewed: `hpsetup@4.7.1/src/download.js`, `constants.js`, and `install.js`.

## Verified repair result

Commit `ca503d7` passed all 10 synthetic installer tests, 12 release tooling tests (one optional fixture skipped), the local beta.8 artifact check, and Record typechecks/build. The frozen root lockfile dry run passed. No real installation key was used.

[GitHub run 37091511193](https://github.com/SiyiDuProjects/Study/actions/runs/37091511193) passed dependency installation and the installer guard tests, then failed at the explicit CollectUI installation step because `HEROUI_KEY` was empty. Downstream cloud checks were skipped. This confirms the remaining configuration blocker; it does not verify real beta.8 download or a successful cloud build.
