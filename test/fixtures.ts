import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { decodeEvent, type CapyEvent } from "../src/capy/events.js"
import { parseSse } from "../src/sse.js"

export const FIXTURES = join(import.meta.dirname, "..", "fixtures")

export const scenarios = (): ReadonlyArray<{ model: string; scenario: string; dir: string }> =>
  readdirSync(FIXTURES)
    .filter((model) => model !== "errors")
    .flatMap((model) =>
      readdirSync(join(FIXTURES, model)).map((scenario) => ({ model, scenario, dir: join(FIXTURES, model, scenario) }))
    )

export const loadEvents = (dir: string): ReadonlyArray<CapyEvent> =>
  parseSse(readFileSync(join(dir, "stream.sse"), "utf8")).map(decodeEvent)

export const loadJson = <A>(dir: string, file: string): A | undefined => {
  const text = readText(dir, file)
  return text === undefined ? undefined : (JSON.parse(text) as A)
}

export const readText = (dir: string, file: string): string | undefined => {
  try {
    return readFileSync(join(dir, file), "utf8").trim()
  } catch {
    return undefined
  }
}
