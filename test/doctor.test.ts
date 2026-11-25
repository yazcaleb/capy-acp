import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { CapyApiError } from "../src/capy/client.js"
import { readConfig } from "../src/config.js"
import { type DoctorIo, runDoctor } from "../src/doctor.js"
import type { ProjectSummary } from "../src/workspace.js"

const dirs: Array<string> = []
const savedKey = process.env.CAPY_API_KEY
beforeEach(() => {
  delete process.env.CAPY_API_KEY
})
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedKey === undefined) delete process.env.CAPY_API_KEY
  else process.env.CAPY_API_KEY = savedKey
})

const PROJECTS: ReadonlyArray<ProjectSummary> = [{ id: "proj_1", name: "App", repos: [{ repoFullName: "acme/app" }] }]

/** A clone of acme/app, and a Capy home with a paired device that links the clone when `linked` is set. */
const machine = (options: { key?: boolean; device?: boolean; linked?: boolean } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "capy-acp-doctor-"))
  dirs.push(home)
  const repo = join(home, "app")
  mkdirSync(repo)
  execFileSync("git", ["-C", repo, "init", "-q"])
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/app.git"])
  mkdirSync(join(home, "capy", "device"), { recursive: true })
  mkdirSync(join(home, "capy", "dock"), { recursive: true })
  if (options.device !== false) writeFileSync(join(home, "capy", "dock", "status.json"), JSON.stringify({ deviceId: "device_DOCK" }))
  const folders = options.linked === false ? [] : [{ root: repo, repos: ["acme/app"] }]
  writeFileSync(join(home, "capy", "device", "workspaces.json"), JSON.stringify({ folders }))
  if (options.key !== false) writeFileSync(join(home, "api-key"), "capy_secret\n")
  const config = readConfig({
    CAPY_HOME: join(home, "capy"),
    CAPY_DESKTOP_CONFIG_DIR: join(home, "nowhere"),
    CAPY_API_KEY_FILE: join(home, "api-key")
  })
  return { repo, config, home }
}

const doctor = async (
  m: ReturnType<typeof machine>,
  folder: string,
  listProjects: DoctorIo["listProjects"] = async () => PROJECTS,
  nodeVersion = "v24.1.0"
) => {
  const output: Array<string> = []
  const code = await runDoctor(m.config, folder, { write: (text) => void output.push(text), listProjects, nodeVersion })
  return { code, text: output.join("") }
}

describe("capy-acp --doctor", () => {
  it("passes a linked clone with a key that Capy accepts, and never prints the key", async () => {
    const m = machine()
    const { code, text } = await doctor(m, m.repo)
    expect(code).toBe(0)
    expect(text).not.toContain("FAIL")
    expect(text).toContain("ok    Node v24.1.0")
    expect(text).toContain("Capy accepted it and shows 1 project.")
    expect(text).toContain("device_DOCK")
    expect(text).toContain('acme/app, in the Capy project "App"')
    expect(text).toContain("Capy edits it in place")
    expect(text).toContain("Ready.")
    expect(text).not.toContain("capy_secret")
  })

  it("names each problem with its fix and exits 1", async () => {
    const m = machine({ key: false, device: false })
    const { code, text } = await doctor(m, m.repo, async () => PROJECTS, "v20.11.0")
    expect(code).toBe(1)
    expect(text).toContain("FAIL  Node v20.11.0 is too old.")
    expect(text).toContain("FAIL  No Capy API key.")
    expect(text).toContain("npx -y capy-acp --setup")
    expect(text).toContain("FAIL  No paired Capy device found")
    expect(text).toContain("note  The folder check needs an API key that Capy accepts.")
    expect(text).toContain("3 problems to fix.")
  })

  it("tells a rejected key from a network problem", async () => {
    const m = machine()
    const rejected = await doctor(m, m.repo, () =>
      Promise.reject(new CapyApiError({ status: 401, tag: "Unauthorized", message: "Invalid API key", retryAfterMs: undefined }))
    )
    expect(rejected.code).toBe(1)
    expect(rejected.text).toContain("Capy did not accept the API key")
    expect(rejected.text).toContain("Settings, then API")
    const offline = await doctor(m, m.repo, () => Promise.reject(new Error("getaddrinfo ENOTFOUND")))
    expect(offline.text).toContain("getaddrinfo ENOTFOUND")
    expect(offline.text).toContain("Check the network connection")
  })

  it("explains a folder outside git or outside every Capy project", async () => {
    const m = machine()
    const outside = join(m.home, "notes")
    mkdirSync(outside)
    const plain = await doctor(m, outside)
    expect(plain.code).toBe(1)
    expect(plain.text).toContain("is not in a git repository")
    const other = await doctor(m, m.repo, async () => [{ id: "proj_2", name: "Other", repos: [{ repoFullName: "acme/other" }] }])
    expect(other.code).toBe(1)
    expect(other.text).toContain("No Capy project includes acme/app")
  })

  it("only notes a folder that the local list does not show, because Capy decides", async () => {
    const m = machine({ linked: false })
    const { code, text } = await doctor(m, m.repo)
    expect(code).toBe(0)
    expect(text).toContain("note  The local list of linked folders does not show this folder.")
    expect(text).toContain("https://capy.ai/settings/projects")
  })
})
