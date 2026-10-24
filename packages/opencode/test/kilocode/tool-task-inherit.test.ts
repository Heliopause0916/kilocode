import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { BackgroundJob } from "../../src/background/job"
import { Bus } from "../../src/bus"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { SessionDrain } from "@/kilocode/session/drain"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Provider } from "../../src/provider/provider"
import { Permission } from "../../src/permission"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { KiloTask } from "../../src/kilocode/tool/task"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

// v7.8.15: services are compiled via LayerNode (no defaultLayer exports anymore)
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Bus.node,
      Config.node,
      RuntimeFlags.node,
      SessionRunState.node,
      SessionStatus.node,
      SessionDrain.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
      Provider.node,
      ToolRegistry.node,
      Database.node,
    ]),
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

const seed = Effect.fn("TaskInheritTest.seed")(function* () {
  const sessions = yield* Session.Service
  const chat = yield* sessions.create({ title: "Parent" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* sessions.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  const prompt = (input: SessionPrompt.PromptInput) =>
    Effect.sync(() => {
      opts?.onPrompt?.(input)
      const id = MessageID.ascending()
      return {
        info: {
          id,
          role: "assistant",
          parentID: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID,
          mode: input.agent ?? "general",
          agent: input.agent ?? "general",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
          finish: "stop",
        },
        parts: [
          {
            id: PartID.ascending(),
            messageID: id,
            sessionID: input.sessionID,
            type: "text",
            text: opts?.text ?? "done",
          },
        ],
      } satisfies MessageV2.WithParts
    })
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt,
  }
}

/**
 * Build the child session permission the same way TaskTool does, so the end-to-end
 * question-deny behavior is exercised rather than only the baseline function in isolation.
 */
function buildChildPermission(
  subagent: Agent.Info,
  parentSessionPermission: Permission.Ruleset,
): Permission.Ruleset {
  const caller: Agent.Info = { name: "build", permission: [], mode: "primary", options: {} }
  const rules = KiloTask.inherited({
    caller,
    session: { permission: parentSessionPermission } as any, // Session.Info.permission is DeepMutable; Ruleset is readonly
    mcp: {},
    subagent,
  })
  const canTask = subagent.permission.some((rule) => rule.permission === "task")
  const allowQuestion =
    subagent.options?.inheritDeny === false && subagent.permission.some((rule) => rule.permission === "question")
  return KiloTask.merge(
    deriveSubagentSessionPermission({ parentSessionPermission, subagent }),
    KiloTask.permissions(rules, canTask, allowQuestion),
  )
}

describe("Kilo task inheritDeny option", () => {
  it.live("inheritDeny: false allows subagent to bypass parent deny rules", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const agents = yield* Agent.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              description: "run commands",
              prompt: "run some commands",
              subagent_type: "worker",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId)
          const worker = yield* agents.get("worker")
          expect(worker).toBeDefined()
          if (!worker) return

          // Child session should NOT have inherited deny rules from parent (inheritDeny: false).
          // v7.8.15: bash denies are never projected onto a writable subagent (#11523), so the
          // edit deny is the one that would have been inherited without the opt-out.
          expect(child.permission).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
          expect(child.permission).not.toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
        }),
      {
        config: {
          permission: {
            bash: { "*": "deny" },
            edit: { "*": "deny" },
          },
          agent: {
            worker: {
              mode: "subagent",
              permission: {
                bash: { "*": "allow" },
                edit: { "*": "allow" },
              },
              options: {
                inheritDeny: false,
              },
            },
          },
        },
      },
    ),
  )

  it.live("inheritDeny defaults to true when not specified", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              description: "run ansible-lint",
              prompt: "run ansible-lint --version",
              subagent_type: "validator",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId)

          // Validator SHOULD inherit parent's deny rule (default behavior).
          // The native `build` caller projects its edit deny ceiling onto the child.
          expect(child.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
        }),
      {
        config: {
          permission: {
            edit: { "*": "deny" },
          },
          agent: {
            validator: {
              mode: "subagent",
              permission: {
                bash: { "*ansible-lint*": "allow" },
              },
              // No inheritDeny specified - defaults to true (inherit denials)
            },
          },
        },
      },
    ),
  )

  it.live("inheritDeny: false excludes session-level denials from parent", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()

          // Add a session-level deny rule to the parent session.
          yield* sessions.setPermission({
            sessionID: chat.id,
            permission: [{ permission: "bash", pattern: "rm *", action: "deny" }],
          })

          const result = yield* def.execute(
            {
              description: "explore code",
              prompt: "find all test files",
              subagent_type: "worker",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps: stubOps() },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          const child = yield* sessions.get(result.metadata.sessionId)

          // Child should NOT inherit parent session's deny rule due to inheritDeny: false
          expect(child.permission).not.toContainEqual({ permission: "bash", pattern: "rm *", action: "deny" })
        }),
      {
        config: {
          agent: {
            worker: {
              mode: "subagent",
              permission: {
                bash: { "*": "allow" },
              },
              options: {
                inheritDeny: false,
              },
            },
          },
        },
      },
    ),
  )

  test("KiloTask.inherited returns empty array when inheritDeny is false", () => {
    const callerPermission: Agent.Info["permission"] = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
    ]
    const sessionPermission: Agent.Info["permission"] = [
      { permission: "bash", pattern: "rm *", action: "deny" },
    ]

    // With inheritDeny: false - should return empty ruleset
    const resultFalse = KiloTask.inherited({
      caller: { name: "build", permission: callerPermission, mode: "primary", options: {} },
      session: { permission: sessionPermission } as any,
      mcp: {},
      subagent: {
        name: "worker",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: false },
      },
    })
    expect(resultFalse).toEqual([])

    // With inheritDeny: true (or unspecified) - should return deny rules.
    // v7.8.15: the inherited mutation set excludes bash (#11523), so only the edit deny survives.
    const resultTrue = KiloTask.inherited({
      caller: { name: "build", permission: callerPermission, mode: "primary", options: {} },
      session: { permission: sessionPermission } as any,
      mcp: {},
      subagent: {
        name: "validator",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: true },
      },
    })
    expect(resultTrue).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(resultTrue).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })

    // Without inheritDeny option - should default to true (inherit)
    const resultDefault = KiloTask.inherited({
      caller: { name: "build", permission: callerPermission, mode: "primary", options: {} },
      session: { permission: sessionPermission } as any,
      mcp: {},
      subagent: {
        name: "validator",
        permission: [],
        mode: "subagent",
        options: {},
      },
    })
    expect(resultDefault).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(resultDefault).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
  })

  test("deriveSubagentSessionPermission respects inheritDeny: false (baseline only)", () => {
    const parentSessionPermission: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
    ]

    // With inheritDeny: false - should only return baseline default denies, skipping parent session deny.
    const resultFalse = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: {
        name: "worker",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: false },
      },
    })
    expect(resultFalse).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(resultFalse).not.toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    // Baseline default denies for subagents: task/todowrite/question
    expect(resultFalse).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(resultFalse).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
    expect(resultFalse).toContainEqual({ permission: "question", pattern: "*", action: "deny" })

    // With inheritDeny: true - should include parent session deny rules.
    // v7.8.15: deriveSubagentSessionPermission does NOT add a question deny on the default path
    // (question deny comes from KiloTask.permissions), so it is absent here.
    const resultTrue = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: {
        name: "validator",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: true },
      },
    })
    expect(resultTrue).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(resultTrue).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(resultTrue).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(resultTrue).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
    expect(resultTrue).not.toContainEqual({ permission: "question", pattern: "*", action: "deny" })

    // Without inheritDeny - should default to inheriting denials
    const resultDefault = deriveSubagentSessionPermission({
      parentSessionPermission,
      subagent: {
        name: "validator",
        permission: [],
        mode: "subagent",
        options: {},
      },
    })
    expect(resultDefault).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(resultDefault).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(resultDefault).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(resultDefault).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
    expect(resultDefault).not.toContainEqual({ permission: "question", pattern: "*", action: "deny" })
  })

  test("default path keeps any-rule waiver for a scoped task rule (unchanged default)", () => {
    // v7.8.15 semantics: any rule naming "task" waives the blanket task deny, even a
    // scoped rule like `task: { "explore": "ask" }` that is NOT an explicit allow.
    // This is the "don't change default" regression guard.
    const subagent: Agent.Info = {
      name: "scoped-delegator",
      permission: [{ permission: "task", pattern: "explore", action: "ask" }],
      mode: "subagent",
      options: {},
    }

    const result = deriveSubagentSessionPermission({
      parentSessionPermission: [{ permission: "bash", pattern: "*", action: "deny" }],
      subagent,
    })

    // The scoped task rule waives the blanket task deny.
    expect(result).not.toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    // Parent session deny still inherited on the default path.
    expect(result).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    // todowrite still has a default deny since the subagent has no todowrite rule.
    expect(result).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
  })

  test("inheritDeny: false baseline waives a scoped rule (any-rule, not explicit allow)", () => {
    // The inheritDeny:false baseline uses the same v7.8.15 any-rule waiver: a scoped
    // `question` rule lifts the blanket question deny without needing an explicit allow.
    const subagent: Agent.Info = {
      name: "narrow-worker",
      permission: [
        { permission: "question", pattern: "confirm-*", action: "deny" },
        { permission: "task", pattern: "noop", action: "ask" },
      ],
      mode: "subagent",
      options: { inheritDeny: false },
    }

    const result = deriveSubagentSessionPermission({
      parentSessionPermission: [{ permission: "bash", pattern: "*", action: "deny" }],
      subagent,
    })

    // Any rule naming the permission waives the blanket deny (no explicit allow required).
    expect(result).not.toContainEqual({ permission: "question", pattern: "*", action: "deny" })
    expect(result).not.toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    // Parent session deny is skipped entirely on the inheritDeny:false path.
    expect(result).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    // todowrite still has its baseline deny (no todowrite rule present).
    expect(result).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
  })

  test("inheritDeny: false + explicit question allow keeps question usable in the full child permission", () => {
    const subagentWithPermissions: Agent.Info = {
      name: "capable-worker",
      permission: [
        { permission: "task", pattern: "special-agent", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "allow" },
        { permission: "question", pattern: "*", action: "allow" },
      ],
      mode: "subagent",
      options: { inheritDeny: false },
    }

    const parentSessionPermission: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]

    // End-to-end: build the child session permission the way TaskTool does. Without allowQuestion
    // honored, the unconditional question deny from KiloTask.permissions would sit at the end of the
    // merged ruleset and override the subagent's own `question: allow`.
    const child = buildChildPermission(subagentWithPermissions, parentSessionPermission)

    expect(child).not.toContainEqual({ permission: "question", pattern: "*", action: "deny" })
    expect(child).not.toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(child).not.toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
    // Parent session deny is NOT inherited due to inheritDeny: false.
    expect(child).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
  })

  test("default (non-inheritDeny) subagent keeps the unconditional question deny", () => {
    const subagent: Agent.Info = {
      name: "default-worker",
      permission: [{ permission: "question", pattern: "*", action: "allow" }],
      mode: "subagent",
      options: {},
    }

    const child = buildChildPermission(subagent, [{ permission: "bash", pattern: "*", action: "deny" }])

    // Even with an explicit question allow, the default path (no inheritDeny: false) still appends
    // the unconditional question deny at the end of the merged session permission, so a non-inheritDeny
    // subagent cannot ask the user.
    expect(child).toContainEqual({ permission: "question", pattern: "*", action: "deny" })
  })

  test("KiloTask.inherited excludes MCP deny rules when inheritDeny is false", () => {
    const callerPermission: Agent.Info["permission"] = [
      { permission: "bash", pattern: "*", action: "deny" as const },
      { permission: "filesystem_*", pattern: "*", action: "deny" as const },
    ]
    const sessionPermission: Agent.Info["permission"] = [
      { permission: "github_*", pattern: "*", action: "deny" as const },
    ]

    const mcp: Config.Info["mcp"] = {
      filesystem: { type: "local", command: ["mcp-filesystem"] },
      github: { type: "local", command: ["mcp-github"] },
    }

    const result = KiloTask.inherited({
      caller: { name: "build", permission: callerPermission, mode: "primary", options: {} },
      session: { permission: sessionPermission } as any,
      mcp,
      subagent: {
        name: "worker",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: false },
      },
    })

    expect(result).toEqual([])
  })

  test("KiloTask.inherited includes MCP deny rules when inheritDeny is true", () => {
    const callerPermission: Agent.Info["permission"] = [
      { permission: "bash", pattern: "*", action: "deny" as const },
      { permission: "filesystem_*", pattern: "*", action: "deny" as const },
      { permission: "github_*", pattern: "write*", action: "deny" as const },
    ]
    const sessionPermission: Agent.Info["permission"] = [
      { permission: "slack_*", pattern: "*", action: "deny" as const },
    ]

    const mcp: Config.Info["mcp"] = {
      filesystem: { type: "local", command: ["mcp-filesystem"] },
      github: { type: "local", command: ["mcp-github"] },
      slack: { type: "local", command: ["mcp-slack"] },
    }

    const result = KiloTask.inherited({
      caller: { name: "build", permission: callerPermission, mode: "primary", options: {} },
      session: { permission: sessionPermission } as any,
      mcp,
      subagent: {
        name: "explorer",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: true },
      },
    })

    // v7.8.15: bash denies are never inherited (#11523), but MCP denies are always inherited.
    expect(result).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "filesystem_*", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "github_*", pattern: "write*", action: "deny" })
    expect(result).toContainEqual({ permission: "slack_*", pattern: "*", action: "deny" })
  })

  test("KiloTask.permissions honors the task argument (subagent_depth mechanism)", () => {
    const rules: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]

    // task = false (default): the child cannot itself spawn subagents, so it gets a task deny.
    const result = KiloTask.permissions(rules)
    expect(result[0]).toEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "question", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })

    // task = true: the child may spawn further subagents, so the task deny is omitted.
    const canSubtask = KiloTask.permissions(rules, true)
    expect(canSubtask).not.toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    // question/suggest denies are unconditional and remain in both cases.
    expect(canSubtask).toContainEqual({ permission: "question", pattern: "*", action: "deny" })
  })

  test("multi-hop chain respects inheritDeny at each level", () => {
    const planPermission: Agent.Info["permission"] = [
      { permission: "edit", pattern: "*", action: "deny" as const },
      { permission: "bash", pattern: "rm *", action: "deny" as const },
    ]

    // When general (with inheritDeny: false) spawns explore, explore should not
    // receive plan's deny rules because general's inherited ruleset is empty.
    const generalToExploreResult = KiloTask.inherited({
      caller: { name: "general", permission: [], mode: "subagent", options: { inheritDeny: false } },
      session: { permission: [] } as any,
      mcp: {},
      subagent: {
        name: "explore",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: true },
      },
    })
    expect(generalToExploreResult).toEqual([])

    // plan -> validator (inheritDeny: true) should inherit the edit deny.
    const planToValidatorResult = KiloTask.inherited({
      caller: { name: "plan", permission: planPermission, mode: "primary", options: {} },
      session: { permission: [] } as any,
      mcp: {},
      subagent: {
        name: "validator",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: true },
      },
    })
    expect(planToValidatorResult).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(planToValidatorResult).not.toContainEqual({ permission: "bash", pattern: "rm *", action: "deny" })

    // plan -> general (inheritDeny: false) should NOT inherit.
    const planToGeneralResult = KiloTask.inherited({
      caller: { name: "plan", permission: planPermission, mode: "primary", options: {} },
      session: { permission: [] } as any,
      mcp: {},
      subagent: {
        name: "general",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: false },
      },
    })
    expect(planToGeneralResult).toEqual([])
  })
})
