/**
 * Setup (`capy-acp --setup`, `capy-mcp --setup` and `capy-cli setup`): saves the Capy API key that all
 * three share on this machine, then gives the machine a Capy device if it has none. ACP clients run
 * `capy-acp --setup` as the agent's terminal auth method; people can run each one directly too.
 * The key is checked against Capy before it is saved, and is never printed.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { type AdapterConfig, SHARED_KEY } from "./config.js"
import { type MachineIo, nodeMachineIo, setupMachine } from "./machine.js"

export interface SetupIo {
  /** Reads one line without echoing it. */
  readonly readSecret: (prompt: string) => Promise<string>
  readonly write: (text: string) => void
  readonly fetch: typeof fetch
  /** Runs programs and writes files for the device step; the real computer when absent. */
  readonly machine?: MachineIo
}

/** The key from `CAPY_API_KEY` or the key file, or undefined when neither has one. */
export const savedApiKey = async (config: AdapterConfig): Promise<string | undefined> => {
  const fromEnv = process.env.CAPY_API_KEY?.trim()
  if (fromEnv) return fromEnv
  const fromFile = await readFile(config.apiKeyFile, "utf8").then((text) => text.trim(), () => "")
  return fromFile || undefined
}

/**
 * Returns the exit code: 0 when a key is saved and the device step did not fail. After the key, a
 * computer without a Capy device gets one (see machine.ts), with the person's consent at each step.
 */
export const runSetup = async (config: AdapterConfig, io: SetupIo): Promise<number> => {
  io.write(`${config.product.name} setup. It saves ${SHARED_KEY}, in ${config.apiKeyFile} (readable only by you).\n`)
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
      : `Saved, but ${config.product.name} could not check the key with Capy (${check}).\n`
  )
  const machine = await setupMachine(config, io.machine ?? nodeMachineIo(), io.write)
  return machine.status === "failed" ? 1 : 0
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
