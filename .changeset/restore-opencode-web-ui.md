---
"@kilocode/cli": minor
---

Restore the upstream Opencode web UI: `kilo serve` serves the vendored opencode web app at the server root with SPA fallback, and the new `kilo web` command starts the server and opens the interface in the browser. Accept the upstream PTY connect-token header (`x-opencode-ticket`) alongside `x-kilo-ticket`.
