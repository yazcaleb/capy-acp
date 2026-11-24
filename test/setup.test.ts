import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { readConfig } from "../src/config.js"
import { runSetup, type SetupIo } from "../src/setup.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const setup = (answer: string, respond: () => Promise<Response>) => {
  const home = mkdtempSync(join(tmpdir(), "capy-acp-setup-"))
  dirs.push(home)
  mkdirSync(join(home, "capy", "dock"), { recursive: true })
  writeFileSync(join(home, "capy", "dock", "status.json"), JSON.stringify({ deviceId: "device_DOCK" }))
  const config = readConfig({
    CAPY_API_URL: "https://capy.test/api/v1",
    CAPY_API_KEY_FILE: join(home, "config", "api-key"),
    CAPY_HOME: join(home, "capy"),
    CAPY_DESKTOP_CONFIG_DIR: join(home, "nowhere")
  })
  const output: Array<string> = []
  const requests: Array<{ url: string; auth: string | null }> = []
  const io: SetupIo = {
    readSecret: async () => answer,
    write: (text) => void output.push(text),
    fetch: async (url, init) => {
      requests.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
      return respond()
    }
  }
  return { config, io, output, requests, keyFile: join(home, "config", "api-key") }
}

describe("capy-acp --setup", () => {
  it("saves a key that Capy accepts, readable only by the user, and names the device", async () => {
    const s = setup("  capy_good  ", async () => new Response("{}", { status: 200 }))
    expect(await runSetup(s.config, s.io)).toBe(0)
    expect(s.requests).toEqual([{ url: "https://capy.test/api/v1/projects", auth: "Bearer capy_good" }])
    expect(readFileSync(s.keyFile, "utf8")).toBe("capy_good\n")
    if (process.platform !== "win32") expect(statSync(s.keyFile).mode & 0o777).toBe(0o600)
    expect(s.output.join("")).toContain("Capy accepted the key")
    expect(s.output.join("")).toContain("device_DOCK")
    expect(s.output.join("")).not.toContain("capy_good")
  })

  it("saves nothing when Capy rejects the key or no key is entered", async () => {
    const rejected = setup("capy_bad", async () => new Response("{}", { status: 401 }))
    expect(await runSetup(rejected.config, rejected.io)).toBe(1)
    expect(() => statSync(rejected.keyFile)).toThrow()
    const empty = setup("", async () => new Response("{}", { status: 200 }))
    expect(await runSetup(empty.config, empty.io)).toBe(1)
    expect(empty.requests).toEqual([])
  })

  it("saves the key with a warning when Capy can't be reached", async () => {
    const s = setup("capy_offline", () => Promise.reject(new Error("getaddrinfo ENOTFOUND")))
    expect(await runSetup(s.config, s.io)).toBe(0)
    expect(readFileSync(s.keyFile, "utf8")).toBe("capy_offline\n")
    expect(s.output.join("")).toContain("could not check the key with Capy (getaddrinfo ENOTFOUND)")
  })
})
