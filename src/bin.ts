#!/usr/bin/env node
/**
 * `capy-acp`: an ACP agent on stdio. stdout carries protocol messages only; logs go to stderr.
 */
import { resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import { Cause, Effect, Exit } from "effect"
import { makeAgent } from "./agent.js"
import { CapyClient, layer } from "./capy/client.js"
import { readConfig } from "./config.js"
import { runDoctor } from "./doctor.js"
import { readSecretFromTerminal, runSetup } from "./setup.js"
import { AGENT_NAME, AGENT_VERSION } from "./version.js"

const HELP = `${AGENT_NAME} ${AGENT_VERSION}: runs Capy coding-agent threads from an ACP client.
A community project. Not made, endorsed or supported by Capy.

Usage:
  npx -y capy-acp                    Start the ACP agent on stdio. Your ACP client runs this.
  npx -y capy-acp --setup            Save a Capy API key on this machine.
  npx -y capy-acp --doctor [folder]  Check the setup for a folder (default: this folder).
  npx -y capy-acp --version
  npx -y capy-acp --help

Docs: https://github.com/yazcaleb/capy-acp#readme
`

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
  const io = { write: (text: string) => void process.stdout.write(text), listProjects, nodeVersion: process.version }
  process.exit(await runDoctor(config, resolve(rest[0] ?? "."), io))
}

if (command !== undefined) {
  process.stderr.write(`Unknown option: ${command}\n\n${HELP}`)
  process.exit(2)
}

// A person who runs the command in a terminal wants to know what it is. An ACP client pipes stdin.
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
