/**
 * `capy-acp --setup`: saves a Capy API key on this machine. ACP clients run it as the agent's
 * terminal auth method; people can run it directly too. The key is checked against Capy before it
 * is saved, and is never printed.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { AdapterConfig } from "./config.js"
import { readDevice } from "./workspace.js"

/** The terminal auth method that `initialize` announces. */
export const API_KEY_AUTH = {
  type: "terminal",
  id: "capy-api-key",
  name: "Capy API key",
  description: "Save a Capy API key on this machine. Create a key in the Capy app under Settings, then API.",
  args: ["--setup"]
} as const

export interface SetupIo {
  /** Reads one line without echoing it. */
  readonly readSecret: (prompt: string) => Promise<string>
  readonly write: (text: string) => void
  readonly fetch: typeof fetch
}

/** The key from `CAPY_API_KEY` or the key file, or undefined when neither has one. */
export const savedApiKey = async (config: AdapterConfig): Promise<string | undefined> => {
  const fromEnv = process.env.CAPY_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const fromFile = await readFile(config.apiKeyFile, "utf8").then((text) => text.trim(), () => "")
  return fromFile || undefined
}

/** Returns the exit code: 0 when a key is saved and accepted. */
export const runSetup = async (config: AdapterConfig, io: SetupIo): Promise<number> => {
  io.write(`capy-acp setup. The key goes to ${config.apiKeyFile} (readable only by you).\n`)
  const key = (await io.readSecret("Capy API key: ")).trim()
  if (key === "") {
    io.write("No key entered. Nothing was saved.\n")
    return 1
  }
  const check = await io
    .fetch(`${config.apiUrl}/projects`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } })
    .then((response) => response.status, (error: unknown) => (error instanceof Error ? error.message : String(error)))
  if (check === 401 || check === 403) {
    io.write("Capy rejected this key. Nothing was saved.\n")
    return 1
  }
  await mkdir(dirname(config.apiKeyFile), { recursive: true, mode: 0o700 })
  await writeFile(config.apiKeyFile, `${key}\n`, { mode: 0o600 })
  // writeFile keeps the mode of a file that already exists.
  await chmod(config.apiKeyFile, 0o600)
  io.write(
    typeof check === "number" && check >= 200 && check < 300
      ? "Capy accepted the key. Saved.\n"
      : `Saved, but capy-acp could not check the key with Capy (${check}).\n`
  )
  await readDevice(config).then(
    (device) => io.write(`Capy device on this machine: ${device.id}.\n`),
    (error: unknown) => io.write(`${error instanceof Error ? error.message : String(error)}\n`)
  )
  return 0
}

/** Reads a line from the terminal with echo off, or the first line of piped input. */
export const readSecretFromTerminal = (prompt: string): Promise<string> => {
  const input = process.stdin
  if (!input.isTTY) {
    return new Promise((resolve) => {
      let data = ""
      input.setEncoding("utf8")
      input.on("data", (chunk: string) => (data += chunk))
      input.on("end", () => resolve(data.split(/\r?\n/)[0] ?? ""))
    })
  }
  process.stdout.write(prompt)
  return new Promise((resolve, reject) => {
    let value = ""
    const finish = (error?: Error) => {
      input.off("data", onData)
      input.setRawMode(false)
      input.pause()
      process.stdout.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish()
        if (char === "\u0003") return finish(new Error("Cancelled."))
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
        else value += char
      }
    }
    input.setEncoding("utf8")
    input.setRawMode(true)
    input.resume()
    input.on("data", onData)
  })
}
