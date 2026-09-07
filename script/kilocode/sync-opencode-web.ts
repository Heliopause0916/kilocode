#!/usr/bin/env bun

/**
 * Regenerates the vendored upstream opencode web UI under
 * packages/kilo-web-app/app (source of the / web UI served by `kilo serve` and
 * `kilo web`). This is the re-runnable counterpart of the original restore
 * commit, and mirrors the upstream embedded-UI build filter exactly.
 *
 * Pipeline (in regular mode):
 *   1. Resolve the upstream opencode checkout (--upstream | $KILO_OPENCODE_UPSTREAM |
 *      first /tmp/opencode-upstream-*) and verify it has packages/app.
 *   2. Read the upstream HEAD commit (git rev-parse, falling back to .git/HEAD)
 *      and packages/app/package.json version.
 *   3. Run `bun run --cwd <upstream>/packages/app build` (vite build).
 *   4. Copy <upstream>/packages/app/dist into packages/kilo-web-app/app, dropping
 *      every `*.map` and the top-level `_headers` file, and report how many were
 *      stripped.
 *   5. Rewrite packages/kilo-web-app/MANIFEST.json (source, sourceRev, appVersion,
 *      generated, fileCount, sizeBytes) with the on-disk totals of the copied files.
 *   6. Print an old -> new scale comparison (old values read from the previous
 *      MANIFEST, or "—" on first run) plus where the artifacts now live.
 *
 * --verify mode does none of the above: it only asserts the vendored tree and
 * MANIFEST are consistent (app/index.html exists, no *.map anywhere under app/,
 * MANIFEST.json parses, and its fileCount/sizeBytes match a fresh walk) and
 * exits non-zero with a diff when not.
 *
 * --url mode optionally fetches upstream first: git/https clone URLs are cloned
 * into a temp dir; *.tar.gz / *.tgz URLs are downloaded and unpacked there. The
 * unpacked archive commonly wraps the checkout in a single top-level directory,
 * so the script locates the directory containing packages/app before syncing.
 * The temp dir is removed on success and left in place (its path printed) on
 * failure so the state can be inspected.
 *
 * `sourceRev` is derived from the checkout's git HEAD when possible. Tarballs
 * carry no git metadata, so without --source-rev the MANIFEST is written with
 * sourceRev "unknown" and a warning; pass --source-rev <full-commit-hash> for a
 * tarball-based sync to record the upstream commit it was built from.
 *
 * Usage:
 *   bun run script/kilocode/sync-opencode-web.ts --upstream /path/to/opencode
 *   KILO_OPENCODE_UPSTREAM=/path/to/opencode bun run script/kilocode/sync-opencode-web.ts
 *   bun run script/kilocode/sync-opencode-web.ts       # auto-detect /tmp/opencode-upstream-*
 *   bun run script/kilocode/sync-opencode-web.ts --verify
 *   bun run script/kilocode/sync-opencode-web.ts --url https://codeload.github.com/anomalyco/opencode/tar.gz/refs/tags/v1.18.29 --source-rev <hash>
 *   bun run script/kilocode/sync-opencode-web.ts --url file:///path/to/upstream-checkout --source-rev <hash>
 */

import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync, readFileSync, type Dirent } from "node:fs"
import { dirname, join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "../..")
const APP_DIR = join(ROOT, "packages", "kilo-web-app", "app")
const MANIFEST_PATH = join(ROOT, "packages", "kilo-web-app", "MANIFEST.json")
const SOURCE = "anomalyco/opencode"

type Args = {
  upstream?: string
  url?: string
  sourceRev?: string
  verify: boolean
}

type Measure = { count: number; bytes: number; maps: number }

function usage() {
  console.error(
    [
      "usage:",
      "  sync-opencode-web.ts --upstream <path> [--source-rev <rev>] [--verify]",
      "  sync-opencode-web.ts --url <git-url|tarball-url> [--source-rev <rev>] [--verify]",
      "  sync-opencode-web.ts [-h|--help]",
      "",
      "With no --upstream/--url, $KILO_OPENCODE_UPSTREAM is used, then the first",
      "/tmp/opencode-upstream-* directory. --verify checks the vendored tree in",
      "packages/kilo-web-app/ against MANIFEST.json without building or copying.",
      "--source-rev pins the MANIFEST sourceRev (required for reproducible tarball",
      "syncs; tarball fetch without it records sourceRev \"unknown\").",
    ].join("\n"),
  )
}

function parseArgs(argv: string[]): Args {
  const args: Args = { verify: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--verify") {
      args.verify = true
    } else if (arg === "--upstream" || arg.startsWith("--upstream=")) {
      const value = arg === "--upstream" ? argv[++i] : arg.slice("--upstream=".length)
      if (!value) throw new Error("--upstream requires a path")
      args.upstream = value
    } else if (arg === "--url" || arg.startsWith("--url=")) {
      const value = arg === "--url" ? argv[++i] : arg.slice("--url=".length)
      if (!value) throw new Error("--url requires a URL")
      args.url = value
    } else if (arg === "--source-rev" || arg.startsWith("--source-rev=")) {
      const value = arg === "--source-rev" ? argv[++i] : arg.slice("--source-rev=".length)
      if (!value) throw new Error("--source-rev requires a value")
      args.sourceRev = value
    } else if (arg === "-h" || arg === "--help") {
      usage()
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function fail(message: string): never {
  throw new Error(message)
}

function run(cmd: string, cwd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    fail(`${cmd} in ${cwd} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

async function findUpstreamCandidates(): Promise<string[]> {
  const entries = await readdir(process.env.TMPDIR ?? "/tmp", { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry: Dirent) => entry.isDirectory() && entry.name.startsWith("opencode-upstream-"))
    .map((entry: Dirent) => join(process.env.TMPDIR ?? "/tmp", entry.name))
    .sort()
}

async function resolveUpstream(args: Args): Promise<string> {
  if (args.upstream) return resolve(args.upstream)
  if (process.env.KILO_OPENCODE_UPSTREAM) return resolve(process.env.KILO_OPENCODE_UPSTREAM)
  const candidates = await findUpstreamCandidates()
  if (candidates.length === 0) {
    fail(
      "no upstream found: pass --upstream <path>, set $KILO_OPENCODE_UPSTREAM, or place a clone at /tmp/opencode-upstream-*",
    )
  }
  if (candidates.length > 1) {
    console.log(`detected ${candidates.length} upstream candidates; using first:\n  ${candidates.join("\n  ")}`)
  }
  return candidates[0]
}

function isTarball(url: string) {
  return /\.tar\.gz$|\.tgz$|codeload\.github\.com.*\/tar\.gz/.test(url)
}

function hasAppPackage(dir: string) {
  return existsSync(join(dir, "packages", "app", "package.json"))
}

// The fetched source lands in a temp dir, but the archive usually wraps the
// checkout in a single top-level directory (e.g. opencode-1.18.29/) and a git
// clone is placed under src/. Return the directory that actually holds
// packages/app so syncFrom() can consume both forms the same way.
async function locateAppRoot(temp: string, url: string): Promise<string> {
  let current = temp
  for (let depth = 0; depth < 16; depth++) {
    if (hasAppPackage(current)) return current
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    const dirs = entries.filter((entry: Dirent) => entry.isDirectory()).map((entry) => join(current, entry.name))
    const candidates = dirs.filter((dir) => hasAppPackage(dir))
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) fail(`multiple packages/app candidates under ${temp}`)
    if (dirs.length !== 1) break
    current = dirs[0]
  }
  fail(`could not locate packages/app under fetched source ${temp} (from ${url})`)
}

async function fetchUpstream(args: Args): Promise<{ temp: string; dir: string; cleanup: () => Promise<void> }> {
  const url = args.url ?? fail("--url mode requires a URL")
  const temp = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "opencode-sync-"))
  let removed = false
  const cleanup = async () => {
    if (removed) return
    removed = true
    await rm(temp, { recursive: true, force: true })
  }

  try {
    if (isTarball(url)) {
      const archive = join(temp, "upstream.tgz")
      const fetch = spawnSync("curl", ["-fsSL", "-o", archive, url], { encoding: "utf8" })
      if (fetch.status !== 0) {
        fail(`curl failed (${fetch.status}): ${(fetch.stderr || fetch.stdout).trim()}`)
      }
      const extract = spawnSync("tar", ["-xzf", archive, "-C", temp], { encoding: "utf8" })
      if (extract.status !== 0) {
        fail(`tar extraction failed (${extract.status}): ${(extract.stderr || extract.stdout).trim()}`)
      }
      await rm(archive, { force: true })
    } else {
      run("git", temp, ["clone", "--depth", "1", url, "src"])
    }
  } catch (err) {
    await cleanup()
    throw err
  }
  const dir = await locateAppRoot(temp, url)
  return { temp, dir, cleanup }
}

function resolveAppDir(upstream: string) {
  const app = join(upstream, "packages", "app")
  const pkg = join(app, "package.json")
  if (!existsSync(pkg)) fail(`no packages/app/package.json in upstream ${upstream}`)
  return { app, pkg }
}

function parseHead(upstream: string): string {
  try {
    const rev = run("git", upstream, ["rev-parse", "HEAD"])
    if (rev) return rev
  } catch {
    // fall through to manual .git/HEAD parsing
  }
  const headFile = join(upstream, ".git", "HEAD")
  if (!existsSync(headFile)) fail(`cannot resolve upstream HEAD for ${upstream}`)
  const head = readFileSync(headFile, "utf8")
  const ref = head.trim().match(/^ref:\s*(.+)$/)?.[1]
  if (ref) {
    const refPath = join(upstream, ".git", ref)
    return readFileSync(refPath, "utf8").trim()
  }
  return head.trim()
}

function resolveRev(upstream: string, explicit?: string) {
  if (explicit) return explicit
  try {
    return parseHead(upstream)
  } catch {
    console.warn(
      `no git metadata for ${upstream}; MANIFEST sourceRev set to "unknown" (pass --source-rev <rev> to pin it)`,
    )
    return "unknown"
  }
}

async function appVersion(app: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8")) as { version?: unknown }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    fail(`packages/app/package.json has no version: ${join(app, "package.json")}`)
  }
  return pkg.version
}

function buildApp(app: string) {
  console.log(`building upstream packages/app (${app}) ...`)
  const result = spawnSync(process.execPath, ["run", "build"], { cwd: app, stdio: "inherit" })
  if (result.status !== 0) throw new Error(`vite build failed with exit code ${result.status}`)
}

async function measure(dir: string): Promise<Measure> {
  let count = 0
  let bytes = 0
  let maps = 0
  async function walk(d: string) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".map")) {
          maps++
        } else {
          count++
          bytes += (await stat(full)).size
        }
      }
    }
  }
  await walk(dir)
  return { count, bytes, maps }
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB (${bytes} bytes)`
}

async function copyDist(dist: string, out: string): Promise<{ count: number; bytes: number; stripped: number; headers: number }> {
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const files: Array<{ from: string; rel: string }> = []
  let maps = 0
  let headers = 0

  async function walk(dir: string, rel: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const next = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(full, next)
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".map")) {
          maps++
          continue
        }
        if (next === "_headers") {
          headers++
          continue
        }
        files.push({ from: full, rel: next })
      }
    }
  }
  await walk(dist, "")

  let bytes = 0
  for (const file of files) {
    const dest = join(out, file.rel)
    await mkdir(dirname(dest), { recursive: true })
    await copyFile(file.from, dest)
    bytes += (await stat(dest)).size
  }

  return { count: files.length, bytes, stripped: maps, headers }
}

async function readManifest(): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(MANIFEST_PATH)) return undefined
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Record<string, unknown>
}

function today() {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function writeManifest(rev: string, version: string, measure: { count: number; bytes: number }) {
  const manifest = {
    source: SOURCE,
    sourceRev: rev,
    appVersion: version,
    generated: today(),
    fileCount: measure.count,
    sizeBytes: measure.bytes,
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

function compareCounts(actual: Measure, expected?: Record<string, unknown>): string[] {
  const diffs: string[] = []
  const expectedCount = expected?.fileCount
  const expectedBytes = expected?.sizeBytes
  if (typeof expectedCount === "number" && actual.count !== expectedCount) {
    diffs.push(`fileCount: manifest ${expectedCount} != measured ${actual.count}`)
  }
  if (typeof expectedBytes === "number" && actual.bytes !== expectedBytes) {
    diffs.push(`sizeBytes: manifest ${expectedBytes} != measured ${actual.bytes}`)
  }
  return diffs
}

async function verify(): Promise<void> {
  console.log(`verifying ${APP_DIR} ...`)
  const problems: string[] = []

  if (!existsSync(join(APP_DIR, "index.html"))) problems.push("missing app/index.html")

  const actual = await measure(APP_DIR)
  if (actual.maps > 0) problems.push(`found ${actual.maps} *.map files under app/`)

  let manifest: Record<string, unknown> | undefined
  try {
    manifest = await readManifest()
  } catch (err) {
    problems.push(`MANIFEST.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!manifest) problems.push("missing or unparsable MANIFEST.json")

  if (manifest) {
    problems.push(...compareCounts(actual, manifest))
  }

  console.log(`  files: ${actual.count}, size: ${formatBytes(actual.bytes)}, maps: ${actual.maps}`)
  if (problems.length > 0) {
    console.error("verify failed:")
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log("verify ok: app/index.html present, no *.map, MANIFEST.json matches disk")
}

async function sync() {
  const args = parseArgs(process.argv.slice(2))
  if (args.verify) return verify()

  if (args.url) {
    if (args.upstream) fail("cannot combine --upstream with --url")
    const fetched = await fetchUpstream(args)
    try {
      await syncFrom(fetched.dir, args.sourceRev)
      await fetched.cleanup()
      console.log(`cleaned up temp upstream ${fetched.temp}`)
    } catch (err) {
      console.error(`kept temp upstream at ${fetched.temp} for inspection`)
      throw err
    }
    return
  }

  const upstream = await resolveUpstream(args)
  await syncFrom(upstream, args.sourceRev)
}

async function syncFrom(upstream: string, sourceRev?: string) {
  const { app } = resolveAppDir(upstream)
  const version = await appVersion(app)
  const rev = resolveRev(upstream, sourceRev)
  console.log(`upstream: ${upstream}`)
  console.log(`  rev: ${rev}`)
  console.log(`  app version: ${version}`)

  buildApp(app)

  const dist = join(app, "dist")
  if (!existsSync(join(dist, "index.html"))) fail(`build produced no ${dist}/index.html`)

  const before = await readManifest()
  const result = await copyDist(dist, APP_DIR)
  if (result.headers > 0) await rm(join(APP_DIR, "_headers"), { force: true })

  const measure = { count: result.count, bytes: result.bytes }
  await writeManifest(rev, version, measure)

  const old = before?.fileCount !== undefined && before?.sizeBytes !== undefined
  const oldCount = old ? String(before!.fileCount) : "—"
  const oldBytes = old ? formatBytes(Number(before!.sizeBytes)) : "—"
  console.log(
    `scale: ${oldCount} files / ${oldBytes} -> ${measure.count} files / ${formatBytes(measure.bytes)}` +
      ` (stripped ${result.stripped} .map, ${result.headers} _headers)`,
  )
  console.log("remaining artifacts:")
  console.log(`  assets:   ${APP_DIR} (${measure.count} files, ${formatBytes(measure.bytes)})`)
  console.log(`  manifest: ${MANIFEST_PATH}`)
}

await sync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
