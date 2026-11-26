import type { Product } from "@capy-acp/core/config.js"
import { readFileSync } from "node:fs"

export const AGENT_NAME = "capy-acp"

/** From package.json, one level up from both `src/` and `dist/`, so there is one version to bump. */
export const AGENT_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version

export const PRODUCT: Product = {
  name: AGENT_NAME,
  kind: "acp",
  env: "the agent's environment",
  version: AGENT_VERSION,
  setup: "npx -y capy-acp --setup",
  doctor: "npx -y capy-acp --doctor",
  // The ACP adapter lists no threads; capy-cli does, with the same API key.
  threads: "npx -y capy-cli threads",
  latest: "npx -y capy-acp@latest"
}
