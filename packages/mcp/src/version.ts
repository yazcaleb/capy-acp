import type { Product } from "@capy-acp/core/config.js"
import { readFileSync } from "node:fs"

export const AGENT_NAME = "capy-mcp-server"

/** From package.json, one level up from both `src/` and `dist/`, so there is one version to bump. */
export const AGENT_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version

export const PRODUCT: Product = {
  name: AGENT_NAME,
  kind: "mcp",
  env: "this MCP server's env (the `env` of its entry in the MCP client's config)",
  version: AGENT_VERSION,
  setup: "npx -y capy-mcp-server --setup",
  // The server has no doctor and no thread list of its own; capy-cli has both, with the same API key.
  // forTools (mcp.ts) points a calling agent at list_threads instead of this command.
  doctor: "npx -y capy-cli doctor",
  threads: "npx -y capy-cli threads",
  latest: "npx -y capy-mcp-server@latest"
}
