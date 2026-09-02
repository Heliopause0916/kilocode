---
"@kilocode/cli": minor
---

Allow subagents to opt out of inheriting the parent agent's deny rules with the new `inheritDeny: false` agent option, enabling restricted conductor agents to delegate to more capable workers.

Security note: with `inheritDeny: false` the subagent does not inherit the parent session's deny rules (including runtime user denials and session-level disables) nor the edit/notebook/MCP hard ceilings. Enable it only for delegation you fully trust.
