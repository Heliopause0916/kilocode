import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

// kilocode_change start - hard cap a single grep call so a runaway rg scan
// (e.g. a directory with no gitignore coverage, or a scan with few matches)
// can't hang the tool indefinitely. rg itself has no scan-time limit; `limit`
// only bounds the number of returned rows.
const GREP_TIMEOUT_MS = 15_000

// Sentinel result returned through the ripgrep call so the enclosing generator
// can tell an actual timeout apart from a normal search result.
const TIMED_OUT = Symbol("grep timed out")
// kilocode_change end

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info || (info.type !== "File" && info.type !== "Directory")) return empty // kilocode_change
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          // kilocode_change start - time only the ripgrep scan, not the permission/stat preamble, so
          // the cap reflects the search itself. `ctx.extra.grepTimeout` is an internal override used
          // by tests; production uses the default. The clamp keeps a bad override from stalling on 0.
          const timeoutMs = Math.max((ctx.extra?.grepTimeout as number | undefined) ?? GREP_TIMEOUT_MS, 1)
          const abort = ctx.abort ? AbortSignal.any([ctx.abort, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
          // Only an abort caused by the timeout timer carries a TimeoutError reason; a user cancel or
          // any real ripgrep failure does not, keeping their existing behaviour untouched.
          const timedOut = () => (abort.reason as Error | undefined)?.name === "TimeoutError"
          // kilocode_change end
          const result = yield* ripgrep.grep({
            cwd,
            file: info?.type === "File" ? path.basename(search) : undefined, // kilocode_change - constrain exact-file searches
            pattern: params.pattern,
            include: params.include,
            limit: 100,
            signal: abort, // kilocode_change - stop ripgrep when the tool call is cancelled or times out
          }).pipe(
            // kilocode_change start - confine timeout handling to this single ripgrep call so
            // later steps can't be misattributed to a timeout whenever the timer happens to fire
            Effect.catchIf(timedOut, () => Effect.succeed(TIMED_OUT)),
            // kilocode_change end
          )
          // kilocode_change start - surface a genuine timeout as a readable tool result instead of a defect
          if (result === TIMED_OUT) {
            return {
              title: params.pattern,
              metadata: { matches: 0, truncated: false },
              output: `grep timed out after ${timeoutMs / 1000}s and was aborted. The search likely scanned a very large directory or one lacking a .gitignore. Refine the path or pattern and try again.`,
            }
          }
          // kilocode_change end
          // kilocode_change start
          const matches = result.items
          if (matches.length === 0) return empty
          // kilocode_change end

          const rows = matches.map((item) => ({ // kilocode_change
            path: path.resolve(cwd, item.entry.path),
            line: item.line,
            text: item.text,
          }))

          const limit = 100
          const truncated = result.truncated // kilocode_change
          const final = rows
          if (final.length === 0) return empty

          const total = rows.length
          const hasMore = truncated // kilocode_change
          const output = [`Found ${total} matches${hasMore ? " (more matches available)" : ""}`]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            output.push(`  Line ${match.line}: ${match.text}`)
          }

          if (truncated) {
            output.push("")
            output.push("(Results truncated. Consider using a more specific path or pattern.)")
          }
          if (result.partial) output.push("", "(Some paths were inaccessible.)") // kilocode_change

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
