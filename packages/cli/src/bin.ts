/**
 * `capy-cli`: Capy threads from a terminal, a script or CI (cli.ts).
 * The build adds the `#!/usr/bin/env node` line (scripts/build.mjs).
 */
import { fstatSync } from "node:fs"
import { resolve } from "node:path"
import { CapyClient, layer } from "@capy-acp/core/capy/client.js"
import { readConfig } from "@capy-acp/core/config.js"
import { readSecretFromTerminal, runSetup } from "@capy-acp/core/setup.js"
import { Cause, Effect, Exit } from "effect"
import { parseCommand, runCli, runDoctor } from "./cli.js"
import { PRODUCT } from "./version.js"

const args = process.argv.slice(2)
const config = readConfig(process.env, PRODUCT)
const parsed = parseCommand(args)

if (parsed.command === "setup") {
  const io = { readSecret: readSecretFromTerminal, write: (text: string) => void process.stdout.write(text), fetch }
  const code = await runSetup(config, io).catch((error: unknown) => (process.stdout.write(`${String(error)}\n`), 1))
  if (code === 0) process.stdout.write("Next: run `npx -y capy-cli doctor` in a project folder to check the rest of the setup.\n")
  process.exit(code)
}

if (parsed.command === "doctor") {
  const listProjects = async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        return yield* (yield* CapyClient).listProjects
      }).pipe(Effect.provide(layer(config)))
    )
    if (Exit.isSuccess(exit)) return exit.value
    throw exit.cause.reasons.find(Cause.isFailReason)?.error ?? new Error(Cause.pretty(exit.cause))
  }
  const io = { write: (text: string) => void process.stdout.write(text), listProjects }
  process.exit(await runDoctor(config, resolve(parsed.folder ?? "."), io))
}

const readStdin = async () => {
  const chunks: Array<Buffer> = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}
/** Whether stdout and stderr are the same terminal, file or pipe. */
const sameTarget = () => {
  try {
    const [out, err] = [fstatSync(1), fstatSync(2)]
    return out.dev === err.dev && out.ino === err.ino
  } catch {
    return true
  }
}
const io = {
  stdout: (text: string) => void process.stdout.write(text),
  stderr: (text: string) => void process.stderr.write(text),
  isTTY: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true, stderr: process.stderr.isTTY === true },
  merged: sameTarget(),
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
