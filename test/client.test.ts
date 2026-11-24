// The HTTP client against a fake transport: how it finds the API key, and when it retries.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { CapyClient, make } from "../src/capy/client.js"
import { readConfig } from "../src/config.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A transport that answers every request with `answer`, logging what it was sent. */
const transport = (seen: Array<HttpClientRequest.HttpClientRequest>, answer: () => { status: number; body: unknown; headers?: Record<string, string> }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request)
        const { status, body, headers } = answer()
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }))
      })
    )
  )

const client = (keyFile: string, http: Layer.Layer<HttpClient.HttpClient>) => {
  const config = readConfig({ CAPY_API_KEY_FILE: keyFile, CAPY_API_URL: "https://capy.test/api/v1" })
  return Layer.effect(CapyClient, make(config)).pipe(Layer.provide(http))
}

const keyDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "capy-acp-key-"))
  dirs.push(dir)
  return join(dir, "api-key")
}

describe("Capy client", () => {
  it.effect("asks for a missing key without calling Capy, and uses it once it appears", () =>
    Effect.gen(function*() {
      delete process.env.CAPY_API_KEY
      const file = keyDir()
      const seen: Array<HttpClientRequest.HttpClientRequest> = []
      const layer = client(file, transport(seen, () => ({ status: 200, body: { items: [] } })))
      const missing = yield* Effect.flip(CapyClient.use((capy) => capy.listModels).pipe(Effect.provide(layer)))
      expect(missing).toMatchObject({ _tag: "CapyConfigError", message: expect.stringContaining("No Capy API key") })
      expect(seen).toHaveLength(0)

      writeFileSync(file, "capy_test_key\n", { mode: 0o600 })
      yield* CapyClient.use((capy) => capy.listModels).pipe(Effect.provide(layer))
      expect(seen[0]?.headers.authorization).toBe("Bearer capy_test_key")
    }))

  it.effect("retries a rate limit after Capy's retry-after, but not one longer than a minute", () =>
    Effect.gen(function*() {
      process.env.CAPY_API_KEY = "capy_test_key"
      const seen: Array<HttpClientRequest.HttpClientRequest> = []
      let retryAfter = "2"
      const layer = client(keyDir(), transport(seen, () =>
        seen.length === 1 ? { status: 429, body: { _tag: "capy/RateLimited" }, headers: { "retry-after": retryAfter } } : { status: 200, body: { items: [] } }))
      const fiber = yield* Effect.forkChild(CapyClient.use((capy) => capy.listModels).pipe(Effect.provide(layer)))
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.join(fiber)
      expect(seen).toHaveLength(2)

      seen.length = 0
      retryAfter = "3600"
      const error = yield* Effect.flip(CapyClient.use((capy) => capy.listModels).pipe(Effect.provide(layer)))
      expect(error).toMatchObject({ _tag: "CapyApiError", status: 429 })
      expect(seen).toHaveLength(1)
      delete process.env.CAPY_API_KEY
    }))
})
