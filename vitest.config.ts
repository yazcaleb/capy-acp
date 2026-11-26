import { defineConfig } from "vitest/config"

// `source` resolves `@capy-acp/core/*.js` to the core's TypeScript (packages/core/package.json exports).
const conditions = ["source", "module", "node", "import", "default"]

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    projects: ["acp", "cli", "core", "mcp"].map((name) => ({
      extends: true,
      test: { name, root: `packages/${name}`, include: ["test/**/*.test.ts"] }
    }))
  }
})
