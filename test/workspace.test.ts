import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { desktopConfigDir, readConfig } from "../src/config.js"
import { parseRemote, readDeviceId, resolveWorkspace, samePath } from "../src/workspace.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const projects = [{ id: "project_TEST", name: "Acme", repos: [{ repoFullName: "acme/app" }] }]
const base = { cwd: "/w/app", gitRoot: "/w/app", repo: "acme/app", projects, mode: "linked" as const, allowWorktreeFallback: false }

describe("resolveWorkspace", () => {
  it("runs a linked clone in place, sending Capy's own spelling of the root", () => {
    const resolution = resolveWorkspace({ ...base, linked: [{ root: "/tmp/w/app", realRoot: "/w/app", repos: ["acme/app"] }] })
    expect(resolution).toMatchObject({ _tag: "Resolved", value: { projectId: "project_TEST", workspace: { kind: "linked", root: "/tmp/w/app" } } })
  })

  it("explains each setup problem with its fix", () => {
    expect(resolveWorkspace({ ...base, repo: undefined, linked: [] })).toMatchObject({ _tag: "Unresolved", message: expect.stringContaining("not a clone of a GitHub repository") })
    expect(resolveWorkspace({ ...base, projects: [], linked: [] })).toMatchObject({ _tag: "Unresolved", message: expect.stringContaining("No Capy project includes acme/app") })
    const unlinked = resolveWorkspace({ ...base, linked: [{ root: "/w/other", repos: ["acme/app"] }] })
    expect(unlinked).toMatchObject({ _tag: "Unresolved", message: expect.stringContaining("CAPY_ACP_ALLOW_WORKTREE_FALLBACK=1") })
  })

  it("falls back to a worktree of another linked clone only when allowed", () => {
    const resolution = resolveWorkspace({ ...base, allowWorktreeFallback: true, linked: [{ root: "/w/other", repos: ["acme/app"] }] })
    expect(resolution).toMatchObject({ _tag: "Resolved", value: { workspace: { kind: "worktree" }, note: expect.stringContaining("/w/other") } })
  })
})

describe("paths across platforms", () => {
  it("compares folder paths the way each platform's file system does", () => {
    expect(samePath("/w/App", "/w/app", "linux")).toBe(false)
    expect(samePath("/w/App/", "/w/app", "darwin")).toBe(true)
    expect(samePath("C:/Users/dev/app", "c:\\users\\dev\\app", "win32")).toBe(true)
  })

  it("looks for the Capy desktop app's files where Electron keeps them", () => {
    expect(desktopConfigDir({}, "/home/dev", "linux")).toBe("/home/dev/.config/Capy")
    expect(desktopConfigDir({ XDG_CONFIG_HOME: "/cfg" }, "/home/dev", "linux")).toBe("/cfg/Capy")
    expect(desktopConfigDir({}, "/Users/dev", "darwin")).toBe("/Users/dev/Library/Application Support/Capy")
  })

  it("parses https and ssh GitHub remotes", () => {
    expect(parseRemote("https://github.com/Acme/App.git")).toBe("acme/app")
    expect(parseRemote("git@github.com:acme/app")).toBe("acme/app")
    expect(parseRemote("https://gitlab.com/acme/app.git")).toBeUndefined()
  })
})

describe("readDeviceId", () => {
  const configIn = (dir: string) => readConfig({ CAPY_DESKTOP_CONFIG_DIR: dir, CAPY_HOME: join(dir, "capy-home") })

  it("names both files and the ways out when Capy isn't paired here", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capy-acp-device-"))
    dirs.push(dir)
    await expect(readDeviceId(configIn(dir))).rejects.toThrow(
      /No paired Capy device found: neither .*device-ids\.json nor .*dock[/\\]status\.json names one.*capy dock.*CAPY_DEVICE_ID/
    )
  })

  it("finds the device a headless `capy dock` paired, which writes no desktop files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capy-acp-device-"))
    dirs.push(dir)
    mkdirSync(join(dir, "capy-home", "dock"), { recursive: true })
    writeFileSync(
      join(dir, "capy-home", "dock", "status.json"),
      JSON.stringify({ pid: 1, deviceId: "device_DOCK", orgId: "org_a", state: "connected", roots: ["/w"] })
    )
    expect(await readDeviceId(configIn(dir))).toBe("device_DOCK")
    writeFileSync(join(dir, "device-ids.json"), JSON.stringify({ orgs: { org_a: "device_APP" } }))
    expect(await readDeviceId(configIn(dir))).toBe("device_APP")
  })

  it("reads the one paired device, and asks to choose between several", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capy-acp-device-"))
    dirs.push(dir)
    writeFileSync(join(dir, "device-ids.json"), JSON.stringify({ orgs: { org_a: "device_A" } }))
    expect(await readDeviceId(configIn(dir))).toBe("device_A")
    writeFileSync(join(dir, "device-ids.json"), JSON.stringify({ orgs: { org_a: "device_A", org_b: "device_B" } }))
    await expect(readDeviceId(configIn(dir))).rejects.toThrow(/set CAPY_DEVICE_ID/)
  })
})
