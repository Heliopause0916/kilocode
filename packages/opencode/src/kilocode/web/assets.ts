import path from "path"
import { stat } from "fs/promises"

// Serves the vendored upstream opencode web app (packages/kilo-web-app/app)
// at the root prefix, mirroring the Kilo Console directory-serving machinery
// (see src/kilocode/console/assets.ts) but without a lazy build backstop: the
// assets are static vendored files. A path that cannot be served because the
// assets are absent resolves to `undefined` so callers can fall through to the
// embedded web UI branch instead of a hard 404.
export namespace WebAssets {
  const prefix = "/"

  export type Result = { file: string } | { missing: true }

  export function match(_input: string) {
    return true
  }

  export async function resolve(input: string): Promise<Result | undefined> {
    const root = await dir()
    if (!root) return undefined

    const target = route(input)
    if (!target) return { missing: true }

    const direct = await find(root, target.rel)
    if (direct) return { file: direct }

    if (!target.fallback) return { missing: true }

    const index = await find(root, "index.html")
    if (!index) return { missing: true }
    return { file: index }
  }

  async function dir() {
    const override = process.env.KILO_WEB_ASSET_DIR
    if (override && (await ready(override))) return override

    const copied = path.join(path.dirname(process.execPath), "opencode-web")
    if (await ready(copied)) return copied

    const app = source()
    if (await ready(app)) return app
    return undefined
  }

  function source() {
    return path.resolve(import.meta.dirname, "../../../../kilo-web-app/app")
  }

  async function ready(dir: string) {
    const index = path.join(dir, "index.html")
    return await exists(index)
  }

  async function exists(file: string) {
    const info = await stat(file).catch(() => undefined)
    return info?.isFile() ?? false
  }

  async function find(root: string, rel: string) {
    const file = safe(root, rel)
    if (!file) return undefined
    if (!(await exists(file))) return undefined
    return file
  }

  function safe(root: string, rel: string) {
    if (rel.includes("\0")) return undefined
    const file = path.resolve(root, rel)
    const back = path.relative(root, file)
    if (back === "") return file
    if (back.startsWith("..") || path.isAbsolute(back)) return undefined
    return file
  }

  function route(input: string) {
    const raw = input.startsWith(prefix) ? input.slice(prefix.length) : input
    const trimmed = raw.replace(/^\/+/, "")
    if (!trimmed) return { rel: "index.html", fallback: false }

    const decoded = decode(trimmed)
    if (!decoded) return undefined

    const rel = decoded.replace(/\\/g, "/")
    if (rel.split("/").some((part) => part === "..")) return undefined
    return { rel, fallback: path.extname(rel) === "" }
  }

  function decode(input: string) {
    try {
      return decodeURIComponent(input)
    } catch (_err) {
      return undefined
    }
  }
}
