/**
 * Builds each published package into one file, packages/<dir>/dist/bin.js. The shared core
 * (@capy-acp/core, never published) is bundled in from its TypeScript sources; the package's own
 * `dependencies` stay external, so npm installs them. Also copies the root LICENSE into the package.
 *
 * Usage: node scripts/build.mjs [acp|mcp|cli ...]   (no argument builds all three)
 */
import { chmodSync, copyFileSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { build } from "esbuild"

const ROOT = join(import.meta.dirname, "..")
const ALL = ["acp", "mcp", "cli"]
const dirs = process.argv.slice(2)
for (const dir of dirs) {
  if (!ALL.includes(dir)) {
    console.error(`Unknown package: ${dir}. Use one of ${ALL.join(", ")}.`)
    process.exit(2)
  }
}

for (const dir of dirs.length === 0 ? ALL : dirs) {
  const pkg = join(ROOT, "packages", dir)
  const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"))
  const out = join(pkg, "dist", "bin.js")
  rmSync(join(pkg, "dist"), { recursive: true, force: true })
  await build({
    entryPoints: [join(pkg, "src", "bin.ts")],
    outfile: out,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    conditions: ["source"],
    // Subpath imports (`effect/ai`) match too.
    external: Object.keys(manifest.dependencies ?? {}).flatMap((name) => [name, `${name}/*`]),
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: true,
    // The map gives stack traces their source lines, and leaves the core's sources out of the tarball.
    sourcesContent: false,
    logLevel: "warning"
  })
  chmodSync(out, 0o755)
  copyFileSync(join(ROOT, "LICENSE"), join(pkg, "LICENSE"))
  console.log(`${manifest.name} ${manifest.version}: ${join("packages", dir, "dist", "bin.js")}`)
}
