import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { readConfig } from "./config.js"
import type { MachineIo } from "../src/machine.js"
import { runSetup, type SetupIo } from "../src/setup.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A computer whose programs are recorded, never run. machine.test.ts covers the device step itself. */
const fakeMachine = (started: Array<string>): MachineIo => ({
  platform: "linux",
  home: "/home/ada",
  env: {},
  uid: 1000,
  interactive: true,
  folder: "/home/ada/src/app",
  isElevated: async () => false,
  exists: async (path) => path.endsWith("/bin/capy"),
  writeFile: async (path) => void started.push(`write ${path}`),
  removeFile: async (path) => void started.push(`remove ${path}`),
  confirm: async () => false,
  run: async (step) => (started.push(step.display), { code: 0, output: "" }),
  start: (step) => (started.push(step.display), { exited: Promise.resolve(1), stop: () => {} }),
  sleep: async () => {},
  gitRoot: async () => undefined
})

const setup = (answer: string, respond: () => Promise<Response>, options: { device?: boolean } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "capy-acp-setup-"))
  dirs.push(home)
  mkdirSync(join(home, "capy", "dock"), { recursive: true })
  if (options.device !== false) writeFileSync(join(home, "capy", "dock", "status.json"), JSON.stringify({ deviceId: "device_DOCK" }))
  const config = readConfig({
    CAPY_API_URL: "https://capy.test/api/v1",
    CAPY_API_KEY_FILE: join(home, "config", "api-key"),
    CAPY_HOME: join(home, "capy"),
    CAPY_DESKTOP_CONFIG_DIR: join(home, "nowhere")
  })
  const output: Array<string> = []
  const requests: Array<{ url: string; auth: string | null }> = []
  const started: Array<string> = []
  const io: SetupIo = {
    machine: fakeMachine(started),
    readSecret: async () => answer,
    write: (text) => void output.push(text),
    fetch: async (url, init) => {
      requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
      return respond()
    }
  }
  return { config, io, output, requests, started, keyFile: join(home, "config", "api-key") }
}

describe("capy-acp --setup", () => {
  it("saves a key that Capy accepts, readable only by the user, and names the device", async () => {
    const s = setup("  capy_good  ", async () => new Response("{}", { status: 200 }))
    expect(await runSetup(s.config, s.io)).toBe(0)
    expect(s.requests).toEqual([{ url: "https://capy.test/api/v1/projects", auth: "Bearer capy_good" }])
    expect(readFileSync(s.keyFile, "utf8")).toBe("capy_good\n")
    if (process.platform !== "win32") expect(statSync(s.keyFile).mode & 0o777).toBe(0o600)
    expect(s.output.join("")).toContain("Capy accepted the key")
    expect(s.output.join("")).toContain("Capy device on this computer: device_DOCK, from capy dock.")
    expect(s.output.join("")).not.toContain("capy_good")
    expect(s.started).toEqual([])
  })

  it("gives a computer without a device one after the key, and fails when the pairing does not finish", async () => {
    const s = setup("capy_good", async () => new Response("{}", { status: 200 }), { device: false })
    expect(await runSetup(s.config, s.io)).toBe(1)
    expect(readFileSync(s.keyFile, "utf8")).toBe("capy_good\n")
    expect(s.started).toEqual([`${join(s.config.capyHome, "bin", "capy")} dock`])
    expect(s.output.join("")).toContain("capy dock stopped before the pairing finished.")
  })

  it("saves nothing when Capy rejects the key or no key is entered", async () => {
    const rejected = setup("capy_bad", async () => new Response("{}", { status: 401 }))
    expect(await runSetup(rejected.config, rejected.io)).toBe(1)
    expect(() => statSync(rejected.keyFile)).toThrow()
    const empty = setup("", async () => new Response("{}", { status: 200 }))
    expect(await runSetup(empty.config, empty.io)).toBe(1)
    expect(empty.requests).toEqual([])
    expect([...rejected.output, ...empty.output].join("")).not.toContain("Capy device")
    expect([...rejected.started, ...empty.started]).toEqual([])
  })

  it("keeps the saved key when the person presses Enter, and goes on to the device", async () => {
    const s = setup("", async () => new Response("{}", { status: 200 }))
    mkdirSync(join(s.keyFile, ".."), { recursive: true })
    writeFileSync(s.keyFile, "capy_saved\n", { mode: 0o600 })
    expect(await runSetup(s.config, s.io)).toBe(0)
    expect(s.requests).toEqual([{ url: "https://capy.test/api/v1/projects", auth: "Bearer capy_saved" }])
    expect(s.output.join("")).toContain("Kept the saved key.")
    expect(s.output.join("")).toContain("Capy device on this computer: device_DOCK, from capy dock.")
    const rejected = setup("", async () => new Response("{}", { status: 401 }))
    mkdirSync(join(rejected.keyFile, ".."), { recursive: true })
    writeFileSync(rejected.keyFile, "capy_old\n", { mode: 0o600 })
    expect(await runSetup(rejected.config, rejected.io)).toBe(1)
    expect(rejected.output.join("")).toContain("Capy rejects the saved key.")
    expect(readFileSync(rejected.keyFile, "utf8")).toBe("capy_old\n")
  })

  it("saves the key with a warning when Capy can't be reached", async () => {
    const s = setup("capy_offline", () => Promise.reject(new Error("getaddrinfo ENOTFOUND")))
    expect(await runSetup(s.config, s.io)).toBe(0)
    expect(readFileSync(s.keyFile, "utf8")).toBe("capy_offline\n")
    expect(s.output.join("")).toContain("could not check the key with Capy (getaddrinfo ENOTFOUND)")
  })
})
