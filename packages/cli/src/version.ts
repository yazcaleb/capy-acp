import type { Product } from "@capy-acp/core/config.js"
import { readFileSync } from "node:fs"

export const AGENT_NAME = "capy-cli"

/** From package.json, one level up from both `src/` and `dist/`, so there is one version to bump. */
export const AGENT_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version

export const PRODUCT: Product = {
  name: AGENT_NAME,
  kind: "cli",
  env: "the shell or CI job that runs capy-cli",
  version: AGENT_VERSION,
  setup: "npx -y capy-cli setup",
  doctor: "npx -y capy-cli doctor",
  threads: "npx -y capy-cli threads",
  latest: "npx -y capy-cli@latest"
}
