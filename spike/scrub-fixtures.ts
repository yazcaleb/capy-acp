// Copies raw spike recordings into fixtures/, replacing personal identifiers.
// Usage: node spike/scrub-fixtures.ts <rawDir> <fixturesDir>
// Only allow-listed files are copied (never response headers), and the run fails
// if any identifier on the deny list survives scrubbing.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const [rawDir, outDir] = process.argv.slice(2)
if (!rawDir || !outDir) throw new Error("usage: scrub-fixtures.ts <rawDir> <fixturesDir>")

const env = (name: string) => process.env[name] ?? ""
// Values come from the environment so the identifiers themselves never land in the repo.
const replacements: Array<[string, string]> = [
  [env("SCRUB_AUTHOR_NAME"), "Spike User"],
  [env("SCRUB_USER_ID"), "user_SPIKE"],
  [env("SCRUB_DEVICE_ID"), "device_SPIKE"],
  [env("SCRUB_PROJECT_ID"), "project_SPIKE"],
  [env("SCRUB_REPO"), "example/demo-repo"],
  [env("SCRUB_REPO_NAME"), "demo-repo"],
  [env("SCRUB_HOME"), "/home/dev"]
].filter(([from]) => from.length > 0) as Array<[string, string]>

const allowed = /^(stream\.sse|messages\.json|thread\.json|create\.(request|response)\.json|message\.(request|response)\.json|interrupt\.response\.json|resume-cursor|thread-id|[a-z-]+\.json)$/

const walk = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

const scrub = (text: string) => replacements.reduce((acc, [from, to]) => acc.split(from).join(to), text)

/**
 * Capy streams replies as 1-15 character `assistant` fragments, so an identifier can be split
 * across frames where plain replacement never sees it. Scrub each reply's joined text, then
 * re-split it along the original fragment lengths.
 */
const scrubFragments = (sse: string): string => {
  const lines = sse.split("\n")
  const byCall = new Map<string, Array<{ line: number; payload: { callId: string; text: string } }>>()
  let event = ""
  lines.forEach((line, index) => {
    if (line.startsWith("event: ")) event = line.slice(7)
    else if (line.startsWith("data: ") && event === "assistant") {
      const payload = JSON.parse(line.slice(6)) as { callId: string; text: string }
      byCall.set(payload.callId, [...(byCall.get(payload.callId) ?? []), { line: index, payload }])
    } else if (line === "") event = ""
  })
  for (const fragments of byCall.values()) {
    const joined = fragments.map((f) => f.payload.text).join("")
    let rest = scrub(joined)
    if (rest === joined) continue
    fragments.forEach((fragment, i) => {
      const take = i === fragments.length - 1 ? rest.length : Math.min(fragment.payload.text.length, rest.length)
      lines[fragment.line] = `data: ${JSON.stringify({ ...fragment.payload, text: rest.slice(0, take) })}`
      rest = rest.slice(take)
    })
  }
  return lines.join("\n")
}

const joinedFragments = (sse: string): string => {
  const texts: Array<string> = []
  let event = ""
  for (const line of sse.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7)
    else if (line.startsWith("data: ") && event === "assistant") texts.push((JSON.parse(line.slice(6)) as { text: string }).text)
  }
  return texts.join("")
}

let copied = 0
for (const file of walk(rawDir)) {
  const name = file.split("/").at(-1) ?? ""
  if (!allowed.test(name) || name.endsWith(".headers")) continue
  let text = readFileSync(file, "utf8")
  if (name === "stream.sse") text = scrubFragments(text)
  text = scrub(text)
  const joined = name === "stream.sse" ? joinedFragments(text) : ""
  for (const [from] of replacements) {
    if (text.includes(from) || joined.includes(from)) throw new Error(`identifier survived in ${file}`)
  }
  if (/Bearer |capy_[A-Za-z0-9]{20,}/.test(text)) throw new Error(`credential-like text in ${file}`)
  const target = join(outDir, relative(rawDir, file))
  mkdirSync(join(target, ".."), { recursive: true })
  writeFileSync(target, text)
  copied++
}
console.log(`scrubbed ${copied} files into ${outDir}`)
