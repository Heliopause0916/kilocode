# @kilocode/kilo-web-app

Kilo-specific npm package: a controlled vendored prebuilt artifact of the upstream opencode web UI (`packages/app`).

- `app/` is the Vite build output of upstream `packages/app/dist`, copied as-is (only stripping all `*.map` files and the top-level `_headers`, consistent with the build filtering rules of the upstream embedded UI).
- Source version locked: anomalyco/opencode commit `57ef382` (`@opencode-ai/app` v1.18.29), see `MANIFEST.json`.
- Only distributed with the build: the Kilo CLI resolves it via the `opencode-web` directory and serves it at the root path (`kilo web` / `kilo serve`); it is not published as a standalone site.

## Regeneration

Using task D's sync tool (`script/kilocode/sync-opencode-web.ts`):

```sh
# Given an upstream clone/repo path (or codeload tarball):
bun run --cwd <upstream>/packages/app build
# The tool strips *.map / _headers → rewrites packages/kilo-web-app/app/ + MANIFEST.json
```

Do not hand-edit files inside `app/`. When the upstream version is upgraded, re-run the sync tool and commit the artifacts along with the updated MANIFEST.
