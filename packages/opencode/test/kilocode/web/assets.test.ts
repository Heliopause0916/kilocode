import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readdir } from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { WebAssets } from "../../../src/kilocode/web/assets"

// Real vendored app artifacts, resolved the same way src/kilocode/web/assets.ts
// resolves its source() dir: <repo>/packages/kilo-web-app/app.
const appRoot = path.resolve(import.meta.dir, "../../../../kilo-web-app/app")

const override = process.env.KILO_WEB_ASSET_DIR

afterEach(() => {
  if (override === undefined) delete process.env.KILO_WEB_ASSET_DIR
  else process.env.KILO_WEB_ASSET_DIR = override
})

async function customAssets(dir: string) {
  await mkdir(path.join(dir, "assets"), { recursive: true })
  await Bun.write(path.join(dir, "index.html"), '<!doctype html><html><body><div id="root">override-app</div></body></html>')
  await Bun.write(path.join(dir, "assets", "app.js"), "console.log('override')")
}

async function firstAsset() {
  const files = (await readdir(path.join(appRoot, "assets"))).filter((name) => name.endsWith(".js")).sort()
  return files[0]
}

describe("Kilo Web assets resolution", () => {
  test("serves the SPA index for the root path aliases", async () => {
    for (const input of ["/", "index.html"]) {
      const resolved = await WebAssets.resolve(input)
      expect(resolved && "file" in resolved && resolved.file === path.join(appRoot, "index.html")).toBe(true)
    }
    const index = await WebAssets.resolve("/")
    if (!index || !("file" in index)) return
    expect(await Bun.file(index.file).text()).toContain("<!doctype html")
  })

  test("serves real vendored asset files", async () => {
    const name = await firstAsset()
    const resolved = await WebAssets.resolve(`/assets/${name}`)
    expect(resolved && "file" in resolved).toBe(true)
    if (!resolved || !("file" in resolved)) return
    expect(resolved.file).toBe(path.join(appRoot, "assets", name))
    expect(await Bun.file(resolved.file).exists()).toBe(true)
  })

  test("falls back to index.html for extensionless SPA routes", async () => {
    const resolved = await WebAssets.resolve("/projects/demo")
    expect(resolved && "file" in resolved).toBe(true)
    if (!resolved || !("file" in resolved)) return
    expect(resolved.file).toBe(path.join(appRoot, "index.html"))
  })

  test("marks missing files without falling back", async () => {
    expect(await WebAssets.resolve("/assets/nope.js")).toEqual({ missing: true })
  })

  test("safely rejects path traversal", async () => {
    for (const input of [
      "/../../etc/passwd",
      "/a/../secret",
      "/%2e%2e/secret",
      "/..%2f..%2fetc%2fpasswd",
      "/..%5c..%5cetc%5cpasswd",
      "/static/../index.html",
    ]) {
      expect(await WebAssets.resolve(input), input).toEqual({ missing: true })
    }
  })

  test("safely rejects null-byte injection", async () => {
    expect(await WebAssets.resolve("/index.html%00")).toEqual({ missing: true })
    expect(await WebAssets.resolve("/assets%00/app.js")).toEqual({ missing: true })
  })

  test("honours KILO_WEB_ASSET_DIR override over the vendored app", async () => {
    await using tmp = await tmpdir()
    await customAssets(tmp.path)
    process.env.KILO_WEB_ASSET_DIR = tmp.path

    const index = await WebAssets.resolve("/")
    expect(index && "file" in index).toBe(true)
    if (!index || !("file" in index)) return
    expect(await Bun.file(index.file).text()).toContain("override-app")

    const asset = await WebAssets.resolve("/assets/app.js")
    expect(asset && "file" in asset).toBe(true)
    if (!asset || !("file" in asset)) return
    expect(await Bun.file(asset.file).text()).toContain("override")
  })

  test("falls back to the vendored app when the override dir is unusable", async () => {
    await using tmp = await tmpdir()
    // Non-existent override dir.
    process.env.KILO_WEB_ASSET_DIR = path.join(tmp.path, "does-not-exist")
    const missingDir = await WebAssets.resolve("/")
    expect(missingDir && "file" in missingDir && missingDir.file === path.join(appRoot, "index.html")).toBe(true)

    // Existing dir without an index.html.
    process.env.KILO_WEB_ASSET_DIR = tmp.path
    const emptyDir = await WebAssets.resolve("/")
    expect(emptyDir && "file" in emptyDir && emptyDir.file === path.join(appRoot, "index.html")).toBe(true)
  })
})
