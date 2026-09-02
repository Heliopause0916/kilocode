import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import { BackgroundJob } from "../../src/background/job"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
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

// v7.5.6: services are compiled via LayerNode (no defaultLayer exports anymore)
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      EventV2Bridge.node,
      Config.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Truncate.node,
      ToolRegistry.node,
      Provider.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer()]],
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

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void }): TaskPromptOps {
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
            text: "done",
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

          // Child session should NOT have inherited deny rules from parent (inheritDeny: false)
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
          // v7.5.6: bash denies are never inherited (#11523), so the default
          // inheritance is verified through the edit deny instead.
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

  it.live("inheritDeny: true explicitly enables deny inheritance", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* tool.init()

          const result = yield* def.execute(
            {
              description: "run tests",
              prompt: "run npm test",
              subagent_type: "tester",
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

          // Tester SHOULD inherit parent's edit deny rule (explicit inheritDeny: true)
          expect(child.permission).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
        }),
      {
        config: {
          permission: {
            edit: { "*": "deny" },
          },
          agent: {
            tester: {
              mode: "subagent",
              permission: {
                bash: { "npm test": "allow" },
              },
              options: {
                inheritDeny: true,
              },
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

          // Add session-level deny rule to parent
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

    // With inheritDeny: true (or unspecified) - should return deny rules
    // v7.5.6: the inherited mutation set excludes bash (#11523), so only the edit deny survives
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

  test("deriveSubagentSessionPermission respects inheritDeny: false (session deny only)", () => {
    // v7.4.15: deriveSubagentSessionPermission only inherits the parent SESSION's
    // deny rules; parent AGENT edit-deny inheritance is handled by KiloTask.inherited.
    const parentSessionPermission: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
    ]

    // With inheritDeny: false - should only return default subagent denies
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
    // Should have default task/todowrite/question denies for subagents
    expect(resultFalse).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(resultFalse).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
    expect(resultFalse).toContainEqual({ permission: "question", pattern: "*", action: "deny" })

    // With inheritDeny: true - should include parent session deny rules
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
    expect(resultTrue).toContainEqual({ permission: "question", pattern: "*", action: "deny" })

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
    expect(resultDefault).toContainEqual({ permission: "question", pattern: "*", action: "deny" })
  })

  test("deriveSubagentSessionPermission keeps default denies for deny-only rules (only explicit allow waives them)", () => {
    // SW-2: a narrow deny-only rule (no action === "allow") must NOT lift the blanket
    // default deny. Previous "any rule exists" semantics let a single pattern-scoped
    // `question: { "foo": "deny" }` relax question from "always deny" to "ask".
    const subagent = {
      name: "narrow-deny",
      permission: [
        { permission: "question", pattern: "confirm-*", action: "deny" },
        { permission: "task", pattern: "noop", action: "deny" },
      ],
      mode: "subagent",
      options: { inheritDeny: false },
    } as Agent.Info

    const result = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      subagent,
    })

    // Default denies stay because no explicit allow rule exists
    expect(result).toContainEqual({ permission: "question", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
  })

  test("deriveSubagentSessionPermission respects subagent explicit permissions for task/todowrite/question", () => {
    // Subagent with explicit task/todowrite/question allow permissions
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

    const result = deriveSubagentSessionPermission({
      parentSessionPermission: [{ permission: "bash", pattern: "*", action: "deny" }],
      subagent: subagentWithPermissions,
    })

    // Should NOT contain default denies because subagent has explicit permissions
    expect(result).not.toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(result).not.toContainEqual({ permission: "todowrite", pattern: "*", action: "deny" })
    expect(result).not.toContainEqual({ permission: "question", pattern: "*", action: "deny" })
    // Only parent deny should NOT be inherited due to inheritDeny: false
    expect(result).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
  })

  test("KiloTask.inherited includes MCP deny rules when inheritDeny is true", () => {
    // MCP permission names use the sanitized server name (e.g., filesystem_* -> filesystem_*)
    const callerPermission: Agent.Info["permission"] = [
      { permission: "bash", pattern: "*", action: "deny" as const },
      { permission: "filesystem_*", pattern: "*", action: "deny" as const },
      { permission: "github_*", pattern: "write*", action: "deny" as const },
    ]
    const sessionPermission: Agent.Info["permission"] = [
      { permission: "slack_*", pattern: "*", action: "deny" as const },
    ]

    // MCP servers configured in config
    const mcp: Config.Info["mcp"] = {
      filesystem: { type: "local", command: ["mcp-filesystem"] },
      github: { type: "local", command: ["mcp-github"] },
      slack: { type: "local", command: ["mcp-slack"] },
    }

    // With inheritDeny: true - should include MCP deny rules
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

    // v7.5.6: the inherited mutation set excludes bash (#11523), but MCP denies are always inherited
    expect(result).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "filesystem_*", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "github_*", pattern: "write*", action: "deny" })
    expect(result).toContainEqual({ permission: "slack_*", pattern: "*", action: "deny" })
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

    // With inheritDeny: false - should return empty ruleset
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

  test("KiloTask.inherited only filters for mutation and MCP permissions", () => {
    // v7.5.6: mutation set comes from guarded minus bash (#11523), i.e.
    // edit, task, notebook_edit, notebook_execute, write, agent_manager,
    // repo_clone, interactive_terminal. Bash denies are deliberately NOT
    // inherited; task denies ARE (task is guarded, unlike bash).
    const callerPermission: Agent.Info["permission"] = [
      { permission: "bash", pattern: "*", action: "deny" as const },
      { permission: "edit", pattern: "*", action: "deny" as const },
      { permission: "notebook_edit", pattern: "*", action: "deny" as const },
      { permission: "notebook_execute", pattern: "*", action: "deny" as const },
      { permission: "filesystem_*", pattern: "*", action: "deny" as const }, // MCP
      { permission: "github_*", pattern: "*", action: "deny" as const }, // MCP
      { permission: "task", pattern: "*", action: "deny" as const }, // mutation - IS inherited
      { permission: "question", pattern: "*", action: "deny" as const }, // Should NOT be inherited
      { permission: "bash", pattern: "ls", action: "allow" as const }, // Allow should NOT be inherited
    ]

    const mcp: Config.Info["mcp"] = {
      filesystem: { type: "local", command: ["mcp-filesystem"] },
      github: { type: "local", command: ["mcp-github"] },
    }

    const result = KiloTask.inherited({
      caller: { name: "build", permission: callerPermission, mode: "primary", options: {} },
      session: { permission: [] } as any,
      mcp,
      subagent: {
        name: "validator",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: true },
      },
    })

    // Should include mutation (edit/notebook/task) and MCP deny rules, but not bash,
    // question or allow rules
    expect(result).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "notebook_edit", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "notebook_execute", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "filesystem_*", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "github_*", pattern: "*", action: "deny" })
    expect(result).toHaveLength(6)
    // Should NOT contain bash, question denies or allow rules
    expect(result).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(result).not.toContainEqual({ permission: "question", pattern: "*", action: "deny" })
    expect(result).not.toContainEqual({ permission: "bash", pattern: "ls", action: "allow" })
  })

  test("KiloTask.inherited broadens wildcard permission denies to mutation denies", () => {
    // v7.5.6: a blanket deny on "*" is expanded onto the mutation set, which
    // excludes bash (#11523) but includes task.
    const callerPermission: Agent.Info["permission"] = [
      { permission: "*", pattern: "*", action: "deny" as const },
    ]

    const result = KiloTask.inherited({
      caller: { name: "build", permission: callerPermission, mode: "primary", options: {} },
      session: { permission: [] } as any,
      mcp: {},
      subagent: {
        name: "validator",
        permission: [],
        mode: "subagent",
        options: { inheritDeny: true },
      },
    })

    expect(result).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(result).not.toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "notebook_edit", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "notebook_execute", pattern: "*", action: "deny" })
  })

  test("KiloTask.permissions prepends subagent denies and honors the task argument", () => {
    const rules: Permission.Ruleset = [
      { permission: "bash", pattern: "*", action: "deny" },
    ]

    // v7.5.6: permissions(rules, task) - the conditional task deny is the subagent_depth
    // mechanism (task = false by default denies the task permission), and question deny
    // moved into defaultSubagentDenies.
    const result = KiloTask.permissions(rules)

    expect(result[0]).toEqual({ permission: "task", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "interactive_terminal", pattern: "*", action: "deny" })
    expect(result).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })

    // When the child may itself spawn subagents (task = true), the task deny is omitted
    const canSubtask = KiloTask.permissions(rules, true)
    expect(canSubtask).not.toContainEqual({ permission: "task", pattern: "*", action: "deny" })
  })

  test("multi-hop chain respects inheritDeny at each level", () => {
    // Simulate a plan -> general -> explore chain
    // plan has edit: deny
    // general has inheritDeny: false
    // explore should NOT inherit plan's edit deny

    const planPermission: Agent.Info["permission"] = [
      { permission: "edit", pattern: "*", action: "deny" as const },
      { permission: "bash", pattern: "rm *", action: "deny" as const },
    ]

    // When general (with inheritDeny: false) spawns explore,
    // explore should NOT receive plan's deny rules
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

    // general had inheritDeny: false, so its inherited ruleset is empty
    // explore should only inherit what general passes down (nothing)
    expect(generalToExploreResult).toEqual([])

    // In contrast: plan -> validator (inheritDeny: true) should inherit
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

    // v7.5.6: bash denies are not inherited (#11523); the edit deny survives
    expect(planToValidatorResult).toContainEqual({ permission: "edit", pattern: "*", action: "deny" })
    expect(planToValidatorResult).not.toContainEqual({ permission: "bash", pattern: "rm *", action: "deny" })

    // And: plan -> general (inheritDeny: false) should NOT inherit
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
