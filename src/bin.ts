#!/usr/bin/env node
/**
 * `capy-acp`: an ACP agent on stdio. stdout carries protocol messages only; logs go to stderr.
 * `capy-acp mcp` is an MCP server on stdio, and `capy-acp run|threads|...` is the CLI (src/cli.ts).
 */
import { resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import * as acp from "@agentclientprotocol/sdk"
import { Cause, Effect, Exit } from "effect"
import { makeAgent } from "./agent.js"
import { CapyClient, layer } from "./capy/client.js"
import { entryOf, HELP, runCli } from "./cli.js"
import { readConfig } from "./config.js"
import { runDoctor } from "./doctor.js"
import { readSecretFromTerminal, runSetup } from "./setup.js"
import { AGENT_NAME, AGENT_VERSION } from "./version.js"

const args = process.argv.slice(2)
const [command, ...rest] = args

if (command === "--version" || command === "-v") {
  process.stdout.write(`${AGENT_NAME} ${AGENT_VERSION}\n`)
  process.exit(0)
}

if (command === "--help" || command === "-h") {
  process.stdout.write(HELP)
  process.exit(0)
}

if (command === "--setup") {
  const io = { readSecret: readSecretFromTerminal, write: (text: string) => void process.stdout.write(text), fetch }
  const code = await runSetup(readConfig(), io).catch((error: unknown) => (process.stdout.write(`${String(error)}\n`), 1))
  if (code === 0) process.stdout.write("Next: run `npx -y capy-acp --doctor` in a project folder to check the rest of the setup.\n")
  process.exit(code)
}

if (command === "--doctor") {
  const config = readConfig()
  const listProjects = async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        return yield* (yield* CapyClient).listProjects
      }).pipe(Effect.provide(layer(config)))
    )
    if (Exit.isSuccess(exit)) return exit.value
    throw exit.cause.reasons.find(Cause.isFailReason)?.error ?? new Error(Cause.pretty(exit.cause))
  }
  const latestVersion = async () => {
    const response = await fetch("https://registry.npmjs.org/capy-acp/latest", { signal: AbortSignal.timeout(3_000) })
    const body = response.ok ? ((await response.json()) as { version?: unknown }) : {}
    return typeof body.version === "string" ? body.version : undefined
  }
  const io = {
    write: (text: string) => void process.stdout.write(text),
    listProjects,
    nodeVersion: process.version,
    latestVersion,
    launch: { platform: process.platform, node: process.execPath, bin: fileURLToPath(import.meta.url) }
  }
  process.exit(await runDoctor(config, resolve(rest[0] ?? "."), io))
}

const entry = entryOf(args)

if (entry === "mcp") {
  // Loaded only here, so the ACP agent does not load the MCP server.
  const { runMcpServer } = await import("./mcp.js")
  await runMcpServer(readConfig())
} else if (entry === "cli") {
  const config = readConfig()
  const readStdin = async () => {
    const chunks: Array<Buffer> = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString("utf8")
  }
  const io = {
    stdout: (text: string) => void process.stdout.write(text),
    stderr: (text: string) => void process.stderr.write(text),
    isTTY: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true, stderr: process.stderr.isTTY === true },
    env: process.env,
    cwd: process.cwd(),
    readStdin,
    onInterrupt: (handler: () => void) => {
      process.on("SIGINT", handler)
      return () => void process.off("SIGINT", handler)
    },
    exit: (code: number) => process.exit(code)
  }
  process.exit(await runCli(args, { config, capy: layer(config), io }))
} else if (entry === "flag") {
  process.stderr.write(`Unknown option: ${command}\n\n${HELP}`)
  process.exit(2)
}

if (entry === "acp") {
  // No arguments from here on. A person who runs the command in a terminal wants to know what it is.
  // An ACP client pipes stdin.
  if (process.stdin.isTTY) {
    process.stderr.write(`${HELP}\nThis command is an ACP agent: add it to your ACP client. It is waiting for ACP messages on stdin; press Ctrl+C to stop.\n`)
  }

  const { app, dispose } = makeAgent(readConfig())
  const connection = app.connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
    )
  )
  await connection.closed
  await dispose()
}
