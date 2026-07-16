import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Permission } from "../permission"
import type { Agent } from "./agent"

/**
 * Generate default deny rules for subagents.
 *
 * A subagent that doesn't explicitly configure a permission (task, todowrite, question)
 * gets a deny rule by default to prevent accidental permission escalation.
 *
 * Note: We check if the subagent has ANY rule for the permission (allow OR deny).
 * If it does, we don't add a default deny - the subagent's own rules take precedence.
 * If it doesn't, we add a deny to enforce explicit permission grants.
 */
export function defaultSubagentDenies(subagent: Agent.Info): PermissionV1.Ruleset {
  const canTask = subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = subagent.permission.some((rule) => rule.permission === "todowrite")
  const canQuestion = subagent.permission.some((rule) => rule.permission === "question")
  return [
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canQuestion ? [] : [{ permission: "question" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514)
 * 2. The parent **session's** deny rules and external_directory rules —
 *    same forwarding the original code already did.
 * 3. Default deny rules for `task`, `todowrite`, and `question` if the
 *    subagent's own ruleset doesn't already permit them.
 *
 * When `subagent.options.inheritDeny === false`, the subagent explicitly
 * opts out of inheriting parent deny rules, enabling orchestrator/worker
 * patterns where restricted parents delegate to capable workers.
 *
 * @see KiloTask.inherited in kilocode/tool/task.ts - filters caller deny rules
 *   for edit/bash/MCP inheritance. Together, these two functions build the complete
 *   subagent permission ceiling:
 *   - KiloTask.inherited: caller/session edit/bash/MCP deny rules
 *   - This function: parent session denials + default subagent denies (task/todowrite/question)
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): PermissionV1.Ruleset {
  // If subagent opts out of deny inheritance, only apply default subagent denies
  if (input.subagent.options?.inheritDeny === false) {
    return defaultSubagentDenies(input.subagent)
  }

  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...defaultSubagentDenies(input.subagent),
  ]
}
