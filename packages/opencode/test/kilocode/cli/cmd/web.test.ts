import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import yargs from "yargs"
import { explicitNetworkOptions } from "../../../../src/cli/network"
import { WebCommand as LazyWebCommand } from "../../../../src/kilocode/cli/lazy-kilo-commands"
import { WebCommand } from "../../../../src/kilocode/cli/cmd/web"

const root = path.resolve(import.meta.dir, "../../../../")
const log = new Map<string, string>()

function captureOutput() {
  const original = console.log
  const buffer: string[] = []
  console.log = (msg: unknown) => {
    buffer.push(String(msg))
  }
  return () => {
    console.log = original
    return buffer.join("\n")
  }
}

describe("kilo web command definition", () => {
  test("exports the command with the upstream identity", () => {
    expect(WebCommand).toBeDefined()
    expect(WebCommand.command).toBe("web")
    expect(WebCommand.describe).toContain("web interface")
    expect(WebCommand.builder).toBeTypeOf("function")
    expect(WebCommand.handler).toBeTypeOf("function")
  })

  test("is configured without a project instance", async () => {
    // The `instance` option is consumed by effectCmd() and never exposed on the
    // resulting yargs CommandModule, so assert it at the definition level where
    // the command is authored (a kilo-owned file).
    const source = await Bun.file(path.join(root, "src/kilocode/cli/cmd/web.ts")).text()
    expect(source).toMatch(/instance:\s*false/)
  })

  test("registers the network option flags including port", async () => {
    const cli = yargs([]).exitProcess(false).command(WebCommand)
    const finish = captureOutput()
    try {
      await cli.parseAsync(["web", "--help"])
    } finally {
      const help = finish()
      log.set("help", help)
      expect(help).toContain("--port")
      expect(help).toContain("port to listen on")
      expect(help).toContain("--hostname")
    }
  })

  test("keeps --port parsing under the yargs command registration", async () => {
    // Verify the command is parseable end-to-end against yargs without running
    // the handler: --help short-circuits before the effect handler starts a server.
    const cli = yargs([]).exitProcess(false).command(WebCommand)
    const finish = captureOutput()
    try {
      await cli.parseAsync(["web", "--port", "4321", "--help"])
    } finally {
      const help = finish()
      expect(help).toContain("--port")
    }
  })

  test("parses explicit network options for web", () => {
    expect(explicitNetworkOptions(["kilo", "web", "--port=4321"])).toEqual(["port"])
    expect(explicitNetworkOptions(["kilo", "web", "--hostname", "0.0.0.0", "--no-mdns"])).toEqual([
      "hostname",
      "mdns",
    ])
  })

  test("is wired through the lazy command registry", () => {
    expect(LazyWebCommand).toBeDefined()
    expect(LazyWebCommand.command).toBe("web")
  })
})

afterEach(() => {
  log.clear()
})
