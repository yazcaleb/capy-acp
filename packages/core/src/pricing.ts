/**
 * Model prices and credit amounts, for the model picker and the cost notice after a turn.
 *
 * `GET /models` gives a model's route but no price, so the adapter reads the price table of the public
 * docs page "Models & pricing" (one request per process, with a short timeout). If the page cannot be
 * read or its table changes, models on Capy credits keep the plain "Capy credits" label.
 */
import type { Model } from "./capy/client.js"

/** Prices per 1M tokens, as the docs print them, for example `$0.30`. */
export interface Price {
  readonly input: string
  readonly cachedInput: string | undefined
  readonly output: string
  readonly free: boolean
  /** The docs give more than one price tier (by context length); `input` and `output` are the first. */
  readonly tiered: boolean
}

const unescape = (cell: string) =>
  cell.replace(/\\\$/g, "$").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/<br\s*\/?>/g, "; ").trim()

/** Reads `| **Name** | `id` | context | input | output | ... |` rows of the docs price table. */
export const parsePrices = (markdown: string): ReadonlyMap<string, Price> => {
  const prices = new Map<string, Price>()
  for (const line of markdown.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim())
    const idAt = cells.findIndex((cell) => /^`[a-z0-9][\w.-]*\/[\w.-]+`$/i.test(cell))
    if (idAt < 0 || cells.length < idAt + 4) continue
    const input = unescape(cells[idAt + 2]!)
    const output = unescape(cells[idAt + 3]!)
    const firstInput = /\$\d+(?:\.\d+)?/.exec(input)?.[0]
    const firstOutput = /\$\d+(?:\.\d+)?/.exec(output)?.[0]
    if (firstInput === undefined || firstOutput === undefined) continue
    const amounts = [...`${input} ${output}`.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
    prices.set(cells[idAt]!.slice(1, -1), {
      input: firstInput,
      cachedInput: /cached (\$\d+(?:\.\d+)?)/.exec(input)?.[1],
      output: firstOutput,
      free: amounts.every((amount) => amount === 0),
      tiered: input.includes(";") || output.includes(";")
    })
  }
  return prices
}

export const fetchPrices = async (url: string, timeoutMs = 3_000): Promise<ReadonlyMap<string, Price>> => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/markdown, text/plain" } })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return parsePrices(await response.text())
}

/** Subscription models keep their name. Models on Capy credits show their price, or "free". */
export const modelLabel = (model: Pick<Model, "name" | "route">, price: Price | undefined): string => {
  if (model.route !== "capy") return model.name
  if (price === undefined) return `${model.name} · Capy credits`
  if (price.free) return `${model.name} · free`
  return `${model.name} · ${price.tiered ? "from " : ""}${price.input}/${price.output} per 1M`
}

export const modelDescription = (model: Pick<Model, "billing" | "route">, price: Price | undefined): string | undefined => {
  if (model.route !== "capy") return model.billing ? `Billed to: ${model.billing}` : undefined
  if (price === undefined) return "Billed to Capy credits."
  if (price.free) return "Free: billed to Capy credits at $0.00."
  const cached = price.cachedInput === undefined ? "" : ` (${price.cachedInput} cached)`
  return `Billed to Capy credits, per 1M tokens: ${price.input} input${cached}, ${price.output} output${price.tiered ? ", more above a context threshold" : ""}.`
}

/** Capy counts credits in thousandths of a dollar: the Capy app shows `totalCredits / 1000` as USD. */
export const formatCredits = (credits: number): string => {
  const dollars = credits / 1000
  if (dollars > 0 && dollars < 0.01) return "less than $0.01"
  return `$${dollars.toFixed(2)}`
}
