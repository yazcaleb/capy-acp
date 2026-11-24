#!/usr/bin/env node
/**
 * `capy-acp`: an ACP agent on stdio. stdout carries protocol messages only; logs go to stderr.
 */
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import { makeAgent } from "./agent.js"
import { readConfig } from "./config.js"
import { readSecretFromTerminal, runSetup } from "./setup.js"
import { AGENT_NAME, AGENT_VERSION } from "./version.js"

if (process.argv.includes("--version")) {
  process.stdout.write(`${AGENT_NAME} ${AGENT_VERSION}\n`)
  process.exit(0)
}

if (process.argv.includes("--setup")) {
  const io = { readSecret: readSecretFromTerminal, write: (text: string) => void process.stdout.write(text), fetch }
  process.exit(await runSetup(readConfig(), io).catch((error: unknown) => (process.stdout.write(`${String(error)}\n`), 1)))
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
