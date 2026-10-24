import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

// kilocode_change start - baseline default denies for subagents that opt out of parent inheritance
function baselineSubagentDenies(subagent: Agent.Info): PermissionV1.Ruleset {
  // v7.8.15 waiver semantics: any rule naming the permission lifts its blanket deny.
  // A scoped rule (e.g. `task: { "explore": "ask" }`) is enough — no explicit
  // `action === "allow"` is required (unlike the SW-2 explicit-allow rule).
  const canTask = subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = subagent.permission.some((rule) => rule.permission === "todowrite")
  const canQuestion = subagent.permission.some((rule) => rule.permission === "question")
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
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
// kilocode_change start
// When `subagent.options.inheritDeny === false`, skips inheriting the parent
// session's deny rules and `external_directory` entirely, returning only the
// baseline default denies (task/todowrite/question). This enables
// orchestrator/worker delegation where the conductor lacks execution rights but
// delegates to capable workers.
// kilocode_change end
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  // kilocode_change start - inheritDeny: false skips parent session deny inheritance
  if (input.subagent.options?.inheritDeny === false) {
    return baselineSubagentDenies(input.subagent)
  }
  // kilocode_change end
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
