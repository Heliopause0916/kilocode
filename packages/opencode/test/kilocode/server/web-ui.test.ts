import { afterEach, describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { mkdir, readdir } from "fs/promises"
import path from "path"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { ServerAuth } from "../../../src/server/auth"
import { authorizationRouterMiddleware } from "../../../src/server/routes/instance/httpapi/middleware/authorization"
import { HttpApiApp } from "../../../src/server/routes/instance/httpapi/server"
import { serveUIEffect } from "../../../src/server/shared/ui"
import { testEffect } from "../../lib/effect"
import { tmpdir } from "../../fixture/fixture"

// Real vendored app artifacts at <repo>/packages/kilo-web-app/app.
const appRoot = path.resolve(import.meta.dir, "../../../../kilo-web-app/app")

const fsUtilLayer = AppNodeBuilder.build(FSUtil.node)
const it = testEffect(Layer.mergeAll(fsUtilLayer, RuntimeFlags.layer()))

const webOverride = process.env.KILO_WEB_ASSET_DIR
const consoleOverride = process.env.KILO_CONSOLE_ASSET_DIR

afterEach(() => {
  if (webOverride === undefined) delete process.env.KILO_WEB_ASSET_DIR
  else process.env.KILO_WEB_ASSET_DIR = webOverride
  if (consoleOverride === undefined) delete process.env.KILO_CONSOLE_ASSET_DIR
  else process.env.KILO_CONSOLE_ASSET_DIR = consoleOverride
})

function authConfigLayer(input?: { password?: string; username?: string }) {
  return ServerAuth.Config.configLayer({
    password: input?.password === undefined ? Option.none() : Option.some(input.password),
    username: input?.username ?? "opencode",
  })
}

function uiApp(input?: {
  password?: string
  username?: string
  client?: Layer.Layer<HttpClient.HttpClient>
  disableEmbeddedWebUi?: boolean
}) {
  const handler = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide(authorizationRouterMiddleware.layer.pipe(Layer.provide(authConfigLayer(input)))),
      Layer.provide([
        fsUtilLayer,
        input?.client ?? httpClient(new Response("ui")),
        RuntimeFlags.layer({ disableEmbeddedWebUi: input?.disableEmbeddedWebUi ?? false }),
        HttpServer.layerServices,
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: process.env.KILO_EXPERIMENTAL_DISABLE_FILEWATCHER ?? "true",
          }),
        ),
      ]),
    ),
    { disableLogger: true },
  ).handler
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(
        (): Promise<Response> =>
          Promise.resolve(
            handler(
              input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
              HttpApiApp.context,
            ),
          ),
      )
    },
  }
}

function httpClient(
  response: Response,
  onRequest?: (request: HttpClientRequest.HttpClientRequest) => void,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      onRequest?.(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, response))
    }),
  )
}

async function firstJsAsset() {
  const files = (await readdir(path.join(appRoot, "assets"))).filter((name) => name.endsWith(".js")).sort()
  return files[0]
}

function scopedTmpdir() {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
}

describe("Kilo web UI serving", () => {
  it.live("serves the vendored SPA at the root with a CSP allowing blob:", () =>
    Effect.gen(function* () {
      const response = yield* uiApp().request("/")

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")

      const csp = response.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("blob:")
      expect(csp).toContain("sha256-")
    }),
  )

  it.live("serves real asset files from the assets directory", () =>
    Effect.gen(function* () {
      const name = yield* Effect.promise(() => firstJsAsset())
      const response = yield* uiApp().request(`/assets/${name}`)

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("javascript")
    }),
  )

  it.live("falls back to index.html for extensionless deep SPA paths", () =>
    Effect.gen(function* () {
      const response = yield* uiApp().request("/some/spa/deep/path")

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      const body = yield* Effect.promise(() => response.text())
      expect(body).toContain("<!doctype html")
    }),
  )

  it.live("coexists with the Kilo Console under /console", () =>
    Effect.gen(function* () {
      const tmp = yield* scopedTmpdir()
      const dir = tmp.path
      yield* Effect.promise(() => mkdir(path.join(dir, "assets"), { recursive: true }))
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(dir, "index.html"), '<!doctype html><div id="root">console-index</div>'),
          Bun.write(path.join(dir, "assets", "app.js"), "console.log('console')"),
        ]),
      )
      process.env.KILO_CONSOLE_ASSET_DIR = dir

      const consoleResp = yield* uiApp().request("/console")
      expect(consoleResp.status).toBe(200)
      const consoleBody = yield* Effect.promise(() => consoleResp.text())
      expect(consoleBody).toContain("console-index")

      const consoleAsset = yield* uiApp().request("/console/assets/app.js")
      expect(consoleAsset.status).toBe(200)

      const root = yield* uiApp().request("/")
      expect(root.status).toBe(200)
      const rootBody = yield* Effect.promise(() => root.text())
      expect(rootBody).toContain("OpenCode")
    }),
  )

  it.live("requires a server password for the web UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({ password: "secret", username: "kilo" }).request("/")

      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
    }),
  )

  it.live("leaves public UI paths unauthenticated when a password is set", () =>
    Effect.gen(function* () {
      const app = uiApp({ password: "secret", username: "kilo" })
      for (const target of ["/site.webmanifest", "/web-app-manifest-192x192.png", "/web-app-manifest-512x512.png"]) {
        const response = yield* app.request(target)
        expect(response.status, target).toBe(200)
      }
      const webmanifest = yield* app.request("/site.webmanifest")
      const body = yield* Effect.promise(() => webmanifest.json())
      expect(body).toHaveProperty("name", "OpenCode")
    }),
  )

  it.live("accepts basic auth for the web UI", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({ password: "secret", username: "kilo" }).request("/", {
        headers: { authorization: `Basic ${btoa("kilo:secret")}` },
      })

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
    }),
  )

  it.live("disables the web UI when KILO_DISABLE_EMBEDDED_WEB_UI is set", () =>
    Effect.gen(function* () {
      const response = yield* uiApp({ disableEmbeddedWebUi: true }).request("/")

      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toEqual({ error: "Not Found" })
    }),
  )
})
