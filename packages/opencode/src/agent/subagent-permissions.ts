import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

// kilocode_change start - default deny rules for subagents
function defaultSubagentDenies(subagent: Agent.Info): PermissionV1.Ruleset {
  // Only an explicit `allow` rule waives a tool's default deny. A narrow deny
  // rule (e.g. question denied on one pattern) must not lift the blanket deny,
  // otherwise a single pattern-scoped deny would relax "always deny" to "ask".
  const canTask = subagent.permission.some((rule) => rule.permission === "task" && rule.action === "allow")
  const canTodo = subagent.permission.some((rule) => rule.permission === "todowrite" && rule.action === "allow")
  const canQuestion = subagent.permission.some((rule) => rule.permission === "question" && rule.action === "allow")
  return [
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canQuestion ? [] : [{ permission: "question" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
// kilocode_change end

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Parent agent restrictions only govern that agent; the subagent's own
 *    permissions determine its capabilities.
 * 2. Default `todowrite`, `task`, and `question` denies if the subagent's own
 *    ruleset doesn't already permit them.
 *
 * kilocode_change start
 * When `subagent.options.inheritDeny === false`, skips inheriting the parent
 * session's deny rules entirely, returning only the default subagent denies.
 * Used for orchestrator/worker delegation (issue #9985).
 * kilocode_change end
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  // kilocode_change start - inheritDeny: false skips parent session deny inheritance
  if (input.subagent.options?.inheritDeny === false) {
    return defaultSubagentDenies(input.subagent)
  }
  // kilocode_change end
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...defaultSubagentDenies(input.subagent),
  ]
}
