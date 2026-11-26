import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { decodeEvent, type CapyEvent } from "../src/capy/events.js"
import { parseSse } from "../src/sse.js"

export const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures")

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

// Rows as https://docs.capy.ai/models-and-pricing.md prints them (2026-11-25).
export const PRICE_TABLE = [
  "| Model | ID | Context | Input (per 1M) | Output (per 1M) | BYOK | ZDR |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| **GPT-6.2 Astra** | `openai/gpt-6.2-astra` | 1.05M | ≤272K: \\$8.00 (cached \\$0.40)<br />&gt;272K: \\$16.00 (cached \\$0.80) | ≤272K: \\$40.00<br />&gt;272K: \\$60.00 | ✓ | ZDR on request |",
  "| **GLM-5.3-Flash** (free with ads) | `zai/glm-5.3-flash-ads` | 1.05M | \\$0.00 (cached \\$0.00) | \\$0.00 |  | No ZDR |",
  "| **Nemotron 3.5 Lightning** | `nvidia/nemotron-3.5-lightning-30b-a3b` | 262K | \\$0.07 (cached \\$0.04) | \\$0.20 |  | ZDR |",
  "| **Particle-1** | `particle/particle-1` | 1.05M | \\$0.00 (cached \\$0.00) | \\$0.00 |  | No ZDR |",
  "| **Inkling 2 Small** | `thinkingmachines/inkling-2-small` | 1.05M | \\$0.30 (cached \\$0.03) | \\$1.00 |  | ZDR |",
  "",
  "| Size | vCPU | Price |",
  "| --- | --- | --- |",
  "| Small | 2 | \\$0.10 / hour |"
].join("\n")
