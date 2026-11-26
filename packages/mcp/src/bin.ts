/**
 * `capy-mcp`: an MCP server on stdio. stdout carries protocol messages only; logs go to stderr.
 * The build adds the `#!/usr/bin/env node` line (scripts/build.mjs).
 */
import { readConfig } from "@capy-acp/core/config.js"
import { readSecretFromTerminal, runSetup } from "@capy-acp/core/setup.js"
import { HELP, runMcpServer } from "./mcp.js"
import { AGENT_NAME, AGENT_VERSION, PRODUCT } from "./version.js"

const [command] = process.argv.slice(2)
const config = () => readConfig(process.env, PRODUCT)

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
  const code = await runSetup(config(), io).catch((error: unknown) => (process.stdout.write(`${String(error)}\n`), 1))
  if (code === 0) process.stdout.write("Next: add the server to your agent, for example `claude mcp add capy -- npx -y capy-mcp-server`.\n")
  process.exit(code)
}

if (command !== undefined) {
  process.stderr.write(`Unknown option: ${command}\n\n${HELP}`)
  process.exit(2)
}

await runMcpServer(config())
