import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { desktopConfigDir, readConfig } from "../src/config.js"
import { parseRemote, readDeviceId, readGit, resolveWorkspace, samePath } from "../src/workspace.js"
import { problemOf } from "../src/problems.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const projects = [{ id: "project_TEST", name: "Acme", repos: [{ repoFullName: "acme/app" }] }]
const base = { cwd: "/w/app", gitRoot: "/w/app", repos: ["acme/app"], projects, mode: "linked" as const, allowWorktreeFallback: false, platform: "linux" as const }

describe("resolveWorkspace", () => {
  it("runs a linked clone in place, sending Capy's own spelling of the root", () => {
    const resolution = resolveWorkspace({ ...base, linked: [{ root: "/tmp/w/app", realRoot: "/w/app", repos: ["acme/app"] }] })
    expect(resolution).toMatchObject({ _tag: "Resolved", value: { projectId: "project_TEST", workspace: { kind: "linked", root: "/tmp/w/app" } } })
  })

  it("explains each setup problem with its fix", () => {
    const problem = (input: Partial<Parameters<typeof resolveWorkspace>[0]>) => {
      const resolution = resolveWorkspace({ ...base, linked: [], ...input })
      return resolution._tag === "Unresolved" ? resolution.problem : undefined
    }
    expect(problem({ gitRoot: undefined })).toMatchObject({ title: "Open a repository to use Capy", detail: expect.stringContaining("/w/app is not in a git repository") })
    expect(problem({ repos: [] })).toMatchObject({ title: "Add the GitHub remote" })
    expect(problem({ projects: [] })).toMatchObject({ title: "Add acme/app to a Capy project", steps: [expect.stringContaining("https://capy.ai/settings/projects"), expect.any(String)] })
    expect(problem({ mode: "worktree" })).toMatchObject({ title: "Link this folder to Capy", detail: expect.stringContaining("/w/app is not linked") })
    // T3 Code runs a chat without a project in a scratch folder.
    expect(problem({ cwd: "/Users/me/.t3/scratch/2026-11-25-hi-8484d544", gitRoot: undefined })).toEqual({
      title: "Open a project to use Capy",
      detail: "T3 Code started this chat without a project. Capy threads run on a GitHub repository from one of your Capy projects.",
      steps: ["In T3 Code, add a project for a clone of that repository.", "Start a new chat in that project."]
    })
  })

  it("lets Capy check a folder that the local list does not show, with the fix ready for a refusal", () => {
    // The list on disk can be older than Capy's, or unreadable after a Capy update.
    const resolution = resolveWorkspace({ ...base, linked: [{ root: "/w/other", repos: ["acme/app"] }] })
    expect(resolution).toMatchObject({
      _tag: "Resolved",
      value: { workspace: { kind: "linked", root: "/w/app" }, notLinked: { steps: expect.arrayContaining([expect.stringContaining("CAPY_ACP_ALLOW_WORKTREE_FALLBACK=1")]) } }
    })
    expect(resolveWorkspace({ ...base, linked: [] })).toMatchObject({ _tag: "Resolved", value: { workspace: { kind: "linked", root: "/w/app" } } })
    // Git resolves symlinks; the folder goes in the spelling the client opened.
    const symlinked = resolveWorkspace({ ...base, gitRoot: "/private/tmp/app", openedRoot: "/tmp/app", linked: [] })
    expect(symlinked).toMatchObject({ _tag: "Resolved", value: { workspace: { kind: "linked", root: "/tmp/app" } } })
    // Git prints Windows paths with forward slashes.
    const windows = resolveWorkspace({ ...base, gitRoot: "C:/Users/dev/app", linked: [], platform: "win32" })
    expect(windows).toMatchObject({ _tag: "Resolved", value: { workspace: { kind: "linked", root: "C:\\Users\\dev\\app" } } })
  })

  it("finds the project through any remote, or through the repositories of the linked folder", () => {
    const fork = resolveWorkspace({ ...base, repos: ["dev/app", "acme/app"], linked: [] })
    expect(fork).toMatchObject({ _tag: "Resolved", value: { repo: "acme/app", projectId: "project_TEST" } })
    const linked = resolveWorkspace({ ...base, repos: [], linked: [{ root: "/w/app", repos: ["Acme/App"] }] })
    expect(linked).toMatchObject({ _tag: "Resolved", value: { repo: "acme/app", workspace: { kind: "linked", root: "/w/app" } } })
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

  it("parses https, ssh and aliased remotes", () => {
    expect(parseRemote("https://github.com/Acme/App.git")).toBe("acme/app")
    expect(parseRemote("https://token@github.com/acme/app/")).toBe("acme/app")
    expect(parseRemote("git@github.com:acme/app")).toBe("acme/app")
    expect(parseRemote("git@github-work:acme/app.git")).toBe("acme/app")
    expect(parseRemote("ssh://git@ssh.github.com:443/acme/app.git")).toBe("acme/app")
    expect(parseRemote("/srv/git/app.git")).toBeUndefined()
    expect(parseRemote("app")).toBeUndefined()
  })
})

describe("readGit", () => {
  it("lists the repository of each remote, origin first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capy-acp-remotes-"))
    dirs.push(dir)
    execFileSync("git", ["-C", dir, "init", "-q"])
    execFileSync("git", ["-C", dir, "remote", "add", "upstream", "https://github.com/acme/app.git"])
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github-work:dev/app.git"])
    mkdirSync(join(dir, "src"))
    const { gitRoot, openedRoot, repos } = await readGit(join(dir, "src"))
    expect(gitRoot).toBeDefined()
    // tmpdir() is a symlink on macOS; the opened spelling survives.
    expect(openedRoot).toBe(dir)
    expect(repos).toEqual(["dev/app", "acme/app"])
  })
})

describe("readDeviceId", () => {
  const configIn = (dir: string) => readConfig({ CAPY_DESKTOP_CONFIG_DIR: dir, CAPY_HOME: join(dir, "capy-home") })

  it("names both files and the ways out when Capy isn't paired here", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capy-acp-device-"))
    dirs.push(dir)
    const error = await readDeviceId(configIn(dir)).catch((e: unknown) => e)
    expect(problemOf(error)).toMatchObject({
      title: "Start Capy on this computer",
      steps: [expect.stringContaining("capy dock"), expect.any(String), expect.stringMatching(/device-ids\.json and .*dock[/\\]status\.json.*CAPY_DEVICE_ID/)]
    })
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
    await expect(readDeviceId(configIn(dir))).rejects.toThrow(/Choose a Capy organization/)
  })
})
