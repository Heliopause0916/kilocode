import { Effect } from "effect"
import { effectCmd } from "@/cli/effect-cmd"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import { Flag } from "@opencode-ai/core/flag/flag"
import { launch } from "@/kilocode/cli/open-browser"

export const WebCommand = effectCmd({
  command: "web",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "start the kilo server and open the web interface",
  // The server loads instances per-request via x-kilo-directory header — no
  // need for an ambient project InstanceContext at startup.
  instance: false,
  handler: Effect.fn("Cli.web")(function* (args) {
    const { Server } = yield* Effect.promise(() => import("../../../server/server"))
    if (!Flag.KILO_SERVER_PASSWORD) {
      console.log("Warning: KILO_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = yield* resolveNetworkOptions(args)
    const server = yield* Effect.promise(() => Server.listen(opts))

    const urls = server.urls

    console.log(`kilo server listening on ${urls.bind}`)
    if (urls.local !== urls.bind) console.log(`  Local:   ${urls.local}`)
    if (urls.network) console.log(`  Network: ${urls.network}`)

    yield* Effect.promise(() =>
      launch(urls.local).catch((err) => {
        console.warn(`Could not open browser automatically: ${err instanceof Error ? err.message : String(err)}`)
      }),
    )

    // Graceful signal shutdown, mirroring the serve command.
    const { InstanceRuntime } = yield* Effect.promise(() => import("../../../project/instance-runtime"))
    const { startParentWatchdog } = yield* Effect.promise(() => import("../../parent-watchdog"))
    const { KiloSessions } = yield* Effect.promise(() => import("@/kilo-sessions/kilo-sessions"))
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          // Exit if the editor client that spawned us is hard-killed (no signal reaches us).
          const stopWatchdog = startParentWatchdog(() => process.kill(process.pid, "SIGTERM"))
          const shutdown = async () => {
            stopWatchdog()
            try {
              await KiloSessions.drainIngestForShutdown()
              await InstanceRuntime.disposeAllInstances()
              await server.stop(true)
            } finally {
              resolve()
            }
          }
          process.once("SIGTERM", shutdown)
          process.once("SIGINT", shutdown)
          process.once("SIGHUP", shutdown)
        }),
    )
  }),
})
