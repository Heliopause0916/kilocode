import { expect, test } from "bun:test"
import { assertV1, cloneArgs, parseArgs, resolveRef } from "./sync-opencode-web"

test("resolveRef defaults to the opencode v1 final release", () => {
  expect(resolveRef({ verify: false })).toBe("v1.19.3")
})

test("resolveRef honors an explicit ref", () => {
  expect(resolveRef({ verify: false, ref: "v1.18.4" })).toBe("v1.18.4")
})

test("parseArgs parses --ref and --tag in both space and = forms", () => {
  expect(parseArgs(["--ref", "v1.18.4"]).ref).toBe("v1.18.4")
  expect(parseArgs(["--ref=v1.18.4"]).ref).toBe("v1.18.4")
  expect(parseArgs(["--tag", "v1.18.4"]).ref).toBe("v1.18.4")
  expect(parseArgs(["--tag=v1.18.4"]).ref).toBe("v1.18.4")
})

test("parseArgs rejects --ref without a value", () => {
  expect(() => parseArgs(["--ref"])).toThrow("--ref requires a value")
  expect(() => parseArgs(["--tag"])).toThrow("--ref requires a value")
})

test("parseArgs rejects empty --ref= / --tag= values", () => {
  expect(() => parseArgs(["--ref="])).toThrow("--ref requires a value")
  expect(() => parseArgs(["--tag="])).toThrow("--ref requires a value")
})

test("assertV1 accepts 1.x versions", () => {
  expect(() => assertV1("1.18.29")).not.toThrow()
  expect(() => assertV1("1.19.3")).not.toThrow()
})

test("assertV1 accepts 1.x versions with v prefix or partial dots", () => {
  expect(() => assertV1("v1.18.29")).not.toThrow()
  expect(() => assertV1("1.18.29-beta")).not.toThrow()
  expect(() => assertV1("1.18")).not.toThrow()
})

test("assertV1 rejects non-1.x versions", () => {
  expect(() => assertV1("2.1.2")).toThrow("opencode version should be 1.x")
  expect(() => assertV1("3.0.0")).toThrow("opencode version should be 1.x")
  expect(() => assertV1("v2.1.2")).toThrow("opencode version should be 1.x")
})

test("assertV1 rejects invalid versions", () => {
  expect(() => assertV1("garbage")).toThrow("opencode version should be 1.x")
  expect(() => assertV1("")).toThrow("opencode version should be 1.x")
})

test("cloneArgs pins the resolved ref with --branch", () => {
  expect(cloneArgs("https://github.com/anomalyco/opencode", "v1.19.3", "src")).toEqual([
    "clone",
    "--depth",
    "1",
    "--branch",
    "v1.19.3",
    "https://github.com/anomalyco/opencode",
    "src",
  ])
})
