// The MCP server in process, against a fake Capy API at the HTTP level: the handshake and tool list,
// a thread started and followed with progress, cancelling a wait, and the errors a calling agent acts on.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Queue, Sink, Stdio, Stream } from "effect"
import { McpTest } from "effect/ai"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { vi } from "vitest"
import { CapyClient, make } from "../src/capy/client.js"
import { readConfig } from "../src/config.js"
import { threadNotFound } from "../src/delegate.js"
import { forTools, INSTRUCTIONS, problemText, PROTOCOLS, registrations, serverLayer } from "../src/mcp.js"
import { FIXTURES } from "./fixtures.js"

const SCENARIO = join(FIXTURES, "anthropic_claude-opus-5-5", "s1-write")
const THREAD_ID = readFileSync(join(SCENARIO, "thread-id"), "utf8").trim()
const fixture = (file: string) => readFileSync(join(SCENARIO, file), "utf8")

const dirs: Array<string> = []
beforeEach(() => {
  // The key comes from the key file of each test's config, never from the shell that runs the tests.
  vi.stubEnv("CAPY_API_KEY", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A clone of acme/app on a computer with a Capy device; `linked` makes Capy link the clone. */
const computer = (options: { key?: boolean; linked?: boolean } = {}) => {
  const repo = tmp("capy-mcp-repo-")
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/app.git"])
  const capyHome = tmp("capy-mcp-home-")
  const desktop = tmp("capy-mcp-desktop-")
  writeFileSync(join(desktop, "device-ids.json"), JSON.stringify({ orgs: { org_1: "device_LOCAL" } }))
  if (options.linked === true) {
    mkdirSync(join(capyHome, "device"))
    writeFileSync(join(capyHome, "device", "workspaces.json"), JSON.stringify({ folders: [{ root: repo, repos: ["acme/app"] }] }))
  }
  const keyFile = join(capyHome, "api-key")
  if (options.key !== false) writeFileSync(keyFile, "capy_test_key\n")
  const config = readConfig({
    CAPY_HOME: capyHome,
    CAPY_DESKTOP_CONFIG_DIR: desktop,
    CAPY_API_KEY_FILE: keyFile,
    CAPY_API_URL: "https://api.capy.ai/api/v1",
    CAPY_ACP_PRICING_URL: ""
  })
  return { repo, config }
}

interface Seen {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

const json = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))

/**
 * Capy's API for one thread, from the s1-write fixture. The transcript is empty until the stream is
 * read. With `stream: "open"`, the stream stays open until the reader goes away.
 */
const fakeApi = (seen: Array<Seen>, options: { readonly stream?: "fixture" | "open"; readonly onStreamClosed?: () => void } = {}) => {
  let streamed = false
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url)
        const path = url.pathname.replace(/^\/api\/v1/, "")
        const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
        seen.push({ method: request.method, path, body })
        const thread = `/threads/${THREAD_ID}`
        if (path === "/models") {
          return json(request, {
            items: [{ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", route: "anthropic", billing: "Claude subscription", reasoningModes: ["low", "high"] }]
          })
        }
        if (path === "/projects") return json(request, { items: [{ id: "project_SPIKE", name: "Spike", repos: [{ repoFullName: "acme/app" }] }] })
        if (request.method === "POST" && path === "/threads") return json(request, JSON.parse(fixture("create.response.json")))
        if (path === thread) return json(request, JSON.parse(fixture("thread.json")))
        if (path === `${thread}/messages`) return json(request, streamed ? JSON.parse(fixture("messages.json")) : { items: [], cursor: null })
        if (path === `${thread}/stream`) {
          streamed = true
          const sse = options.stream === "open"
            ? new ReadableStream<Uint8Array>({ cancel: () => options.onStreamClosed?.() })
            : fixture("stream.sse")
          return HttpClientResponse.fromWeb(request, new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
        }
        return json(request, { _tag: "capy/NotFound", message: `No route ${request.method} ${path}` }, 404)
      })
    )
  )
}

const capyOver = (config: ReturnType<typeof computer>["config"], http: Layer.Layer<HttpClient.HttpClient>) =>
  Layer.effect(CapyClient, make(config)).pipe(Layer.provide(http))

const connect = (config: ReturnType<typeof computer>["config"], http: Layer.Layer<HttpClient.HttpClient>) =>
  McpTest.makeClient(registrations(config).pipe(Layer.provide(capyOver(config, http))), { protocols: PROTOCOLS })

const textOf = (result: { readonly content: ReadonlyArray<unknown> }) =>
  result.content.map((block) => (block as { text?: string }).text ?? "").join("\n")

const TOOLS = ["start_thread", "wait_for_thread", "get_thread", "send_message", "stop_thread", "list_threads", "list_models"]

describe("capy-acp mcp", () => {
  it.live("answers initialize on stdio with its name, version and instructions, and lists its tools with no API key", () =>
    Effect.gen(function*() {
      const { config } = computer({ key: false })
      const seen: Array<Seen> = []
      const input = yield* Queue.unbounded<Uint8Array>()
      const out: Array<string> = []
      const stdio = Stdio.layerTest({
        stdin: Stream.fromQueue(input),
        stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => void out.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))))
      })
      // The stdio transport ends the fiber that launched it, so it runs in a fiber of its own.
      yield* Effect.forkScoped(Layer.launch(serverLayer(config, capyOver(config, fakeApi(seen))).pipe(Layer.provide(stdio))))
      const send = (message: object) => Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(message)}\n`))
      yield* send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } })
      yield* send({ jsonrpc: "2.0", method: "notifications/initialized" })
      yield* send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
      const responses = () => out.join("").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { id?: number; result?: any })
      for (let i = 0; i < 200 && responses().filter((r) => r.id !== undefined).length < 2; i++) yield* Effect.sleep("10 millis")

      const initialize = responses().find((r) => r.id === 1)?.result
      expect(initialize.serverInfo).toMatchObject({ name: "capy" })
      expect(initialize.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(initialize.instructions).toBe(INSTRUCTIONS)
      expect(initialize.capabilities.tools).toBeDefined()
      expect(responses().find((r) => r.id === 2)?.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS)
      expect(seen).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("lists each tool with its input schema and hints", () =>
    Effect.gen(function*() {
      const { config } = computer({ key: false })
      const client = yield* connect(config, fakeApi([]))
      const { tools } = yield* client.listTools()
      const byName = new Map(tools.map((t) => [t.name, t]))
      expect([...byName.keys()]).toEqual(TOOLS)

      const start = byName.get("start_thread")!
      expect(start.inputSchema.required).toEqual(["task"])
      expect(Object.keys(start.inputSchema.properties ?? {})).toEqual(["task", "folder", "where", "project", "repo", "device", "machineSize", "model", "reasoning", "title"])
      expect(start.inputSchema.properties?.where).toMatchObject({ enum: ["auto", "worktree", "here", "cloud"] })
      expect(start.inputSchema.properties?.machineSize).toMatchObject({ enum: ["small", "medium", "large", "ultra", "hyper", "bigguy"] })
      expect(byName.get("wait_for_thread")!.inputSchema.properties?.timeoutSeconds).toMatchObject({ type: "integer", minimum: 1, maximum: 600 })
      expect(byName.get("list_models")!.inputSchema).toEqual({ type: "object", properties: {} })

      const hints = Object.fromEntries(tools.map((t) => [t.name, [t.annotations?.readOnlyHint, t.annotations?.destructiveHint]]))
      expect(hints).toEqual({
        start_thread: [false, false],
        wait_for_thread: [true, false],
        get_thread: [true, false],
        send_message: [false, false],
        stop_thread: [false, false],
        list_threads: [true, false],
        list_models: [true, false]
      })
      for (const tool of tools) expect(tool.description).toBeTruthy()
      expect(byName.get("stop_thread")!.description).toContain("interrupts the work in progress")
    }).pipe(Effect.scoped))

  it.effect("starts a thread in a Capy worktree, then waits for it with progress notifications", () =>
    Effect.gen(function*() {
      const { repo, config } = computer({ linked: true })
      const seen: Array<Seen> = []
      const client = yield* connect(config, fakeApi(seen))

      const started = yield* client.callTool({ name: "start_thread", arguments: { task: "Create SPIKE.txt", folder: repo } })
      expect(started.isError).toBe(false)
      expect(started.structuredContent).toMatchObject({ id: THREAD_ID, where: "worktree", deviceId: "device_LOCAL", url: `https://capy.ai/thread/${THREAD_ID}` })
      expect(textOf(started)).toContain(`Call wait_for_thread with threadId "${THREAD_ID}"`)
      const create = seen.find((s) => s.method === "POST" && s.path === "/threads")
      expect(create?.body).toMatchObject({ projectId: "project_SPIKE", message: "Create SPIKE.txt", device: { deviceId: "device_LOCAL", workspace: { kind: "worktree" } } })

      const waited = yield* client.callTool({ name: "wait_for_thread", arguments: { threadId: THREAD_ID, timeoutSeconds: 60 }, _meta: { progressToken: "tok-1" } })
      expect(waited.isError).toBe(false)
      expect(waited.structuredContent).toMatchObject({ id: THREAD_ID, status: "idle", timedOut: false, where: "worktree" })
      expect((waited.structuredContent as { lastReply: string }).lastReply).toContain("I created SPIKE.txt")
      expect(textOf(waited)).toContain("The run is done.")
      expect(textOf(waited)).toContain("Last reply from Capy:")

      const progress = (yield* Queue.clear(client.notifications))
        .filter((n) => n.method === "notifications/progress")
        .map((n) => n.payload as { progressToken: string; progress: number; message: string })
      expect(progress.length).toBeGreaterThan(1)
      expect(progress.every((p) => p.progressToken === "tok-1")).toBe(true)
      expect(progress.map((p) => p.progress)).toEqual(progress.map((_, i) => i + 1))
      const messages = progress.map((p) => p.message)
      expect(messages).toContain("Capy is working")
      expect(messages.some((m) => m.startsWith("Capy: I created SPIKE.txt"))).toBe(true)
      // Waiting never stops the thread.
      expect(seen.some((s) => s.path.endsWith("/interrupt"))).toBe(false)
    }).pipe(Effect.scoped))

  it.effect("sends no progress when the call has no progress token", () =>
    Effect.gen(function*() {
      const { config } = computer()
      const client = yield* connect(config, fakeApi([]))
      const waited = yield* client.callTool({ name: "wait_for_thread", arguments: { threadId: THREAD_ID } })
      expect(waited.isError).toBe(false)
      const progress = (yield* Queue.clear(client.notifications)).filter((n) => n.method === "notifications/progress")
      expect(progress).toEqual([])
    }).pipe(Effect.scoped))

  it.live("cancelling wait_for_thread stops the wait and leaves the thread running", () =>
    Effect.gen(function*() {
      const { config } = computer()
      const seen: Array<Seen> = []
      let closed = false
      const client = yield* connect(config, fakeApi(seen, { stream: "open", onStreamClosed: () => void (closed = true) }))
      const call = yield* Effect.forkChild(client.callTool({ name: "wait_for_thread", arguments: { threadId: THREAD_ID, timeoutSeconds: 600 } }))
      for (let i = 0; i < 200 && !seen.some((s) => s.path.endsWith("/stream")); i++) yield* Effect.sleep("10 millis")
      expect(seen.some((s) => s.path.endsWith("/stream"))).toBe(true)

      yield* Fiber.interrupt(call)
      for (let i = 0; i < 200 && !closed; i++) yield* Effect.sleep("10 millis")
      expect(closed).toBe(true)
      expect(seen.filter((s) => s.method === "POST")).toEqual([])
    }).pipe(Effect.scoped))

  it.live("a wait that times out says so, and leaves the thread running", () =>
    Effect.gen(function*() {
      const { config } = computer()
      const seen: Array<Seen> = []
      const client = yield* connect(config, fakeApi(seen, { stream: "open" }))
      const result = yield* client.callTool({ name: "wait_for_thread", arguments: { threadId: THREAD_ID, timeoutSeconds: 1 } })
      expect(result.isError).toBe(false)
      expect(result.structuredContent).toMatchObject({ id: THREAD_ID, timedOut: true })
      expect(textOf(result)).toContain(`The wait timed out and the thread keeps running. Call wait_for_thread with threadId "${THREAD_ID}"`)
      expect(seen.filter((s) => s.method === "POST")).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("without an API key, a tool call says to ask the person to set it up, and sends nothing", () =>
    Effect.gen(function*() {
      const { repo, config } = computer({ key: false, linked: true })
      const seen: Array<Seen> = []
      const client = yield* connect(config, fakeApi(seen))
      const result = yield* client.callTool({ name: "start_thread", arguments: { task: "Do it", folder: repo } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { title: "Add your Capy API key" },
        nextAction: { kind: "ask_human", say: expect.stringContaining("npx -y capy-acp --setup") }
      })
      expect(textOf(result)).toContain("Add your Capy API key.")
      expect(textOf(result)).toContain("Next: Ask the person to run `npx -y capy-acp --setup`")
      expect(textOf(result)).not.toContain("capy_test_key")

      const models = yield* client.callTool({ name: "list_models", arguments: {} })
      expect(models.isError).toBe(true)
      expect(models.structuredContent).toMatchObject({ nextAction: { kind: "ask_human" } })
      expect(seen).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("an unlinked folder with no other Capy device says where Capy could run it, and never picks the cloud", () =>
    Effect.gen(function*() {
      const { repo, config } = computer()
      const seen: Array<Seen> = []
      const client = yield* connect(config, fakeApi(seen))
      const result = yield* client.callTool({ name: "start_thread", arguments: { task: "Do it", folder: repo } })
      expect(result.isError).toBe(true)
      const structured = result.structuredContent as { error: { title: string; steps: ReadonlyArray<string> }; nextAction: { kind: string; say: string } }
      expect(structured.error.title).toBe("Choose where Capy runs this thread")
      expect(structured.error.steps).toHaveLength(3)
      expect(structured.error.steps[0]).toContain("with this folder linked")
      expect(structured.error.steps[1]).toContain("CAPY_DEVICE_ID")
      expect(structured.error.steps[2]).toContain('where "cloud"')
      expect(structured.nextAction.kind).toBe("ask_human")
      expect(structured.nextAction.say).toContain("costs Capy credits")
      expect(textOf(result)).toContain("Next: Ask the person where Capy should run this")
      expect(seen.filter((s) => s.method === "POST")).toEqual([])
    }).pipe(Effect.scoped))

  it.effect("arguments that do not match the schema come back as an error with the option to change", () =>
    Effect.gen(function*() {
      const { config } = computer()
      const client = yield* connect(config, fakeApi([]))
      const result = yield* client.callTool({ name: "start_thread", arguments: { task: "Do it", where: "moon" } })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ nextAction: { kind: "use_option", option: "where" } })
    }).pipe(Effect.scoped))

  it("points to list_threads, not a shell command, for an unknown thread id", () => {
    expect(forTools(threadNotFound("jam_missing")).nextAction).toEqual({ kind: "use_option", option: "threadId", why: "Use an id from list_threads." })
    expect(problemText(forTools(threadNotFound("jam_missing")))).toContain("Next: Call again with another threadId. Use an id from list_threads.")
  })

  it.effect("lists models with their billing route and the default", () =>
    Effect.gen(function*() {
      const { config } = computer()
      const client = yield* connect(config, fakeApi([]))
      const result = yield* client.callTool({ name: "list_models", arguments: {} })
      expect(result.isError).toBe(false)
      expect(result.structuredContent).toEqual({
        defaultModel: "anthropic/claude-opus-5-5",
        models: [
          {
            id: "anthropic/claude-opus-5-5",
            name: "Claude Opus 5.5",
            route: "anthropic",
            billing: "Claude subscription",
            reasoningModes: ["low", "high"],
            price: "Billed to: Claude subscription",
            isDefault: true
          }
        ]
      })
      expect(textOf(result)).toBe("anthropic/claude-opus-5-5 (default): Claude Opus 5.5 · reasoning low/high · Billed to: Claude subscription")
    }).pipe(Effect.scoped))
})
