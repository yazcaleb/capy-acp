import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { AGENT_NAME } from "../src/version.js"

describe("skeleton", () => {
  it.effect("runs an Effect test", () =>
    Effect.gen(function*() {
      const name = yield* Effect.succeed(AGENT_NAME)
      expect(name).toBe("capy-acp")
    }))
})
