import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { CapyApiError } from "../src/capy/client.js"
import { readConfig } from "../src/config.js"
import { type DoctorIo, runDoctor } from "../src/doctor.js"
import { AGENT_VERSION } from "../src/version.js"
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
  nodeVersion = "v24.1.0",
  latestVersion: DoctorIo["latestVersion"] = async () => AGENT_VERSION,
  launch: DoctorIo["launch"] = { platform: "linux", node: "/usr/bin/node", bin: "/opt/capy-acp/dist/bin.js" }
) => {
  const output: Array<string> = []
  const code = await runDoctor(m.config, folder, {
    write: (text) => void output.push(text),
    listProjects,
    nodeVersion,
    latestVersion,
    launch
  })
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
    expect(text).toContain(`ok    capy-acp ${AGENT_VERSION}, the newest version on npm.`)
    expect(text).toContain("device_DOCK. Keep `capy dock` running")
    expect(text).toContain('acme/app, in the Capy project "App"')
    expect(text).toContain("Capy edits it in place")
    expect(text).toContain("Ready.")
    expect(text).not.toContain("capy_secret")
  })

  it("names each problem with its fix and exits 1", async () => {
    const m = machine({ key: false, device: false })
    const { code, text } = await doctor(m, m.repo, async () => PROJECTS, "v20.11.0")
    expect(code).toBe(1)
    expect(text).toContain("FAIL  Update Node. capy-acp needs Node 22 or later, and this is Node v20.11.0.")
    expect(text).toContain("FAIL  Add your Capy API key.")
    expect(text).toContain("        2. Run `npx -y capy-acp --setup`")
    expect(text).toContain("FAIL  Start Capy on this computer.")
    expect(text).toContain("note  The folder check needs an API key that Capy accepts.")
    expect(text).toContain("3 problems to fix.")
  })

  it("says when npm has a newer capy-acp, without failing the check", async () => {
    const m = machine()
    const newer = await doctor(m, m.repo, undefined, undefined, async () => "99.0.0")
    expect(newer.code).toBe(0)
    expect(newer.text).toContain(`note  capy-acp ${AGENT_VERSION}, and npm has 99.0.0. \`npx -y capy-acp@latest\` runs the newest version.`)
    const offline = await doctor(m, m.repo, undefined, undefined, () => Promise.reject(new Error("offline")))
    expect(offline.text).toContain("npm could not be reached")
  })

  it("gives Windows users a node.exe command, since T3 Code there does not run npx", async () => {
    const m = machine()
    const node = "C:\\Program Files\\nodejs\\node.exe"
    const pinned = await doctor(m, m.repo, undefined, undefined, undefined, {
      platform: "win32",
      node,
      bin: "C:\\Users\\me\\.local\\opt\\capy-acp\\node_modules\\capy-acp\\dist\\bin.js"
    })
    expect(pinned.text).toContain(
      "Ready. In your ACP client, add an agent with the command `C:\\Program Files\\nodejs\\node.exe` and the argument `C:\\Users\\me\\.local\\opt\\capy-acp\\node_modules\\capy-acp\\dist\\bin.js`."
    )
    const fromNpx = await doctor(m, m.repo, undefined, undefined, undefined, {
      platform: "win32",
      node,
      bin: "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\capy-acp\\dist\\bin.js"
    })
    expect(fromNpx.text).toContain("in a pinned install (https://github.com/yazcaleb/capy-acp#install-without-npx)")
    expect(fromNpx.text).not.toContain("_npx")
  })

  it("tells a rejected key from a network problem", async () => {
    const m = machine()
    const rejected = await doctor(m, m.repo, () =>
      Promise.reject(new CapyApiError({ status: 401, tag: "Unauthorized", message: "Invalid API key", retryAfterMs: undefined }))
    )
    expect(rejected.code).toBe(1)
    expect(rejected.text).toContain("Replace your Capy API key. Capy did not accept the API key")
    expect(rejected.text).toContain("Settings, then API")
    const offline = await doctor(m, m.repo, () => Promise.reject(new Error("getaddrinfo ENOTFOUND")))
    expect(offline.text).toContain("getaddrinfo ENOTFOUND")
    expect(offline.text).toContain("Capy could not be reached")
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
    expect(text).toContain("Link this folder to Capy")
  })
})
