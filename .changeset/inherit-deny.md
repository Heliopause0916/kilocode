---
"@kilocode/cli": patch
---

Allow restricted conductor agents to delegate to permission-expanded subagents with the new `inheritDeny: false` agent option. A worker so configured does not inherit the parent session's deny rules (including runtime user denials and session-level disables) nor the edit/notebook/MCP hard ceilings.

Security note: with `inheritDeny: false` the subagent bypasses the parent's restrictions. Enable it only for delegation you fully trust. `inheritDeny` only affects permission rules, so it does not bypass the SandboxPolicy sandbox confinement. It also skips the `external_directory` rules carried from the parent session, so a worker so configured loses those directory grants.
