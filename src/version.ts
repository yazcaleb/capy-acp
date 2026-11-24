import { readFileSync } from "node:fs"

export const AGENT_NAME = "capy-acp"

/** From package.json, one level up from both `src/` and `dist/`, so there is one version to bump. */
export const AGENT_VERSION: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version
