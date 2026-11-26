/** The core's config, read as capy-cli (the package's Product). */
import { readConfig as readFor } from "@capy-acp/core/config.js"
import { PRODUCT } from "../src/version.js"

export * from "@capy-acp/core/config.js"

export const readConfig = (env: NodeJS.ProcessEnv = process.env) => readFor(env, PRODUCT)
