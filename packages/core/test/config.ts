/**
 * The core's config for its tests. The core takes the package that runs it as a Product; these tests
 * run as capy-acp, so the texts they check name capy-acp, as they did before the core was split out.
 */
import { type Product, readConfig as readFor } from "../src/config.js"

export * from "../src/config.js"

export const TEST_PRODUCT: Product = {
  name: "capy-acp",
  kind: "acp",
  env: "the agent's environment",
  version: "0.0.0-test",
  setup: "npx -y capy-acp --setup",
  doctor: "npx -y capy-acp --doctor",
  threads: "npx -y capy-acp threads",
  latest: "npx -y capy-acp@latest"
}

export const readConfig = (env: NodeJS.ProcessEnv = process.env) => readFor(env, TEST_PRODUCT)
