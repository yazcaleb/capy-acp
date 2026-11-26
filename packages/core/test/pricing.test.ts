import { describe, expect, it } from "@effect/vitest"
import { formatCredits, modelDescription, modelLabel, parsePrices } from "../src/pricing.js"
import { PRICE_TABLE } from "./fixtures.js"

describe("model prices", () => {
  const prices = parsePrices(PRICE_TABLE)

  it("reads each model row of the docs table, and nothing else", () => {
    expect([...prices.keys()]).toEqual([
      "openai/gpt-6.2-astra",
      "zai/glm-5.3-flash-ads",
      "nvidia/nemotron-3.5-lightning-30b-a3b",
      "particle/particle-1",
      "thinkingmachines/inkling-2-small"
    ])
    expect(prices.get("thinkingmachines/inkling-2-small")).toEqual({
      input: "$0.30",
      cachedInput: "$0.03",
      output: "$1.00",
      free: false,
      tiered: false
    })
    expect(prices.get("openai/gpt-6.2-astra")).toMatchObject({ input: "$8.00", output: "$40.00", tiered: true, free: false })
    expect(prices.get("particle/particle-1")?.free).toBe(true)
  })

  it("labels models on Capy credits with their price, and subscription models with their name", () => {
    const credits = (name: string) => ({ name, route: "capy" })
    expect(modelLabel(credits("Particle-1"), prices.get("particle/particle-1"))).toBe("Particle-1 · free")
    expect(modelLabel(credits("Inkling 2 Small"), prices.get("thinkingmachines/inkling-2-small"))).toBe(
      "Inkling 2 Small · $0.30/$1.00 per 1M"
    )
    expect(modelLabel(credits("GPT-6.2 Astra"), prices.get("openai/gpt-6.2-astra"))).toBe("GPT-6.2 Astra · from $8.00/$40.00 per 1M")
    expect(modelLabel(credits("New Model"), undefined)).toBe("New Model · Capy credits")
    expect(modelLabel({ name: "Opus 5.5", route: "member_seat" }, prices.get("particle/particle-1"))).toBe("Opus 5.5")
    expect(modelDescription({ route: "capy" }, prices.get("thinkingmachines/inkling-2-small"))).toBe(
      "Billed to Capy credits, per 1M tokens: $0.30 input ($0.03 cached), $1.00 output."
    )
    expect(modelDescription({ route: "member_seat", billing: "Claude subscription" }, undefined)).toBe("Billed to: Claude subscription")
  })

  it("shows credits as dollars, since a credit is a thousandth of a dollar", () => {
    expect(formatCredits(0)).toBe("$0.00")
    expect(formatCredits(3)).toBe("less than $0.01")
    expect(formatCredits(12)).toBe("$0.01")
    expect(formatCredits(5_000)).toBe("$5.00")
  })
})
