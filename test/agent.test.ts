// Drives the agent over a real ACP connection (in-memory streams) with a fake Capy client:
// session/new → prompt → a fresh agent process → session/list, load (replays history), resume, close.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as acp from "@agentclientprotocol/sdk"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Stream } from "effect"
import { makeAgent } from "../src/agent.js"
import { CapyApiError, CapyClient, CapyConfigError, type CreateThread, type SendMessage } from "../src/capy/client.js"
import type { CapyEvent, Message } from "../src/capy/events.js"
import { readConfig } from "../src/config.js"
import { PRICE_TABLE } from "./fixtures.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A linked clone of acme/app, a fake Capy home that links it, and an empty state directory. */
const machine = (env: Record<string, string> = {}) => {
  const home = mkdtempSync(join(tmpdir(), "capy-acp-agent-"))
  dirs.push(home)
  const repo = join(home, "app")
  mkdirSync(repo)
  execFileSync("git", ["-C", repo, "init", "-q"])
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/app.git"])
  mkdirSync(join(home, "capy", "device"), { recursive: true })
  writeFileSync(join(home, "capy", "device", "workspaces.json"), JSON.stringify({ folders: [{ root: repo, repos: ["acme/app"] }] }))
  const config = readConfig({
    CAPY_DEVICE_ID: "device_TEST",
    CAPY_HOME: join(home, "capy"),
    CAPY_ACP_STATE_DIR: join(home, "state"),
    CAPY_ACP_ATTACHMENTS_DIR: join(home, "attachments"),
    CAPY_DESKTOP_CONFIG_DIR: join(home, "nowhere"),
    CAPY_API_KEY_FILE: join(home, "api-key"),
    CAPY_ACP_PRICING_URL: "",
    ...env
  })
  return { repo, config, home }
}

// Cursors sort below the transcript's ids unless stated otherwise, like real event ids.
const turn = (cursor: string, reply: string): Array<CapyEvent> => [
  { _tag: "Status", status: "working" },
  { _tag: "Transcript", cursor: `${cursor}-user`, message: { id: `u-${cursor}`, source: "user", text: "prompt" } },
  { _tag: "Assistant", callId: `a-${cursor}`, text: reply },
  { _tag: "Transcript", cursor, message: { id: `m-${cursor}`, source: "assistant", callId: `a-${cursor}`, text: reply } },
  { _tag: "Status", status: "idle" }
]

const transcript: Array<Message> = [
  { id: "01M84P0000000000000000000U", source: "user", text: "first" },
  { id: "t1", source: "tool", text: "", calls: [{ tool: "bash", durationMs: 1200 }] },
  { id: "01M84P0000000000000000000A", source: "assistant", text: "one" }
]

interface Log {
  creates: Array<CreateThread>
  sends: Array<{ threadId: string; body: SendMessage }>
  streams: Array<string | undefined>
}

const fakeCapy = (log: Log, turns: Array<Array<CapyEvent>>, overrides: Partial<CapyClient["Service"]> = {}) =>
  Layer.succeed(
    CapyClient,
    CapyClient.of({
      listModels: Effect.succeed([{ id: "anthropic/claude-opus-5-5", name: "Opus 5.5", reasoningModes: ["low", "high"] }]),
      listProjects: Effect.succeed([{ id: "project_TEST", name: "Acme", repos: [{ repoFullName: "acme/app" }] }]),
      createThread: (body) => Effect.sync(() => (log.creates.push(body), { id: "jam_TEST", status: "working" as const })),
      sendMessage: (threadId, body) => Effect.sync(() => (log.sends.push({ threadId, body }), { id: "msg" })),
      interrupt: () => Effect.void,
      getThread: (id) => Effect.succeed({ id, status: "idle" as const }),
      uploadFiles: (files) => Effect.succeed(files.map((f, i) => ({ fileId: `file_${i}`, name: f.name }))),
      listMessages: () => Effect.succeed(transcript),
      attachmentUrl: () => Effect.fail({ _tag: "CapyTransportError", message: "no" } as never),
      stream: (_, { cursor }) => Stream.suspend(() => (log.streams.push(cursor), Stream.fromIterable(turns.shift() ?? []))),
      ...overrides
    })
  )

/** Starts an agent on in-memory streams and hands back a connected client plus the updates it saw. */
const connect = async (config: ReturnType<typeof readConfig>, layer: Layer.Layer<CapyClient>) => {
  const { app, dispose } = makeAgent(config, layer)
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  app.connect(acp.ndJsonStream(toClient.writable, toAgent.readable))
  const updates: Array<SessionUpdate> = []
  const client = acp.client({ name: "test" }).onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params.update)
  })
  let agent!: Parameters<Parameters<typeof client.connectWith>[1]>[0]
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    void client.connectWith(acp.ndJsonStream(toAgent.writable, toClient.readable), async (a) => {
      agent = a
      resolve()
      await new Promise<void>((r) => (release = r))
    })
  })
  await ready
  await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
  return { agent, updates, close: async () => (release(), await dispose()) }
}

describe("agent sessions", () => {
  it("advertises load, resume, list, close and media prompts", async () => {
    const { config } = machine()
    const { app, dispose } = makeAgent(config, fakeCapy({ creates: [], sends: [], streams: [] }, []))
    const toAgent = new TransformStream<Uint8Array, Uint8Array>()
    const toClient = new TransformStream<Uint8Array, Uint8Array>()
    app.connect(acp.ndJsonStream(toClient.writable, toAgent.readable))
    const init = await acp.client({ name: "t" }).connectWith(acp.ndJsonStream(toAgent.writable, toClient.readable), (agent) =>
      agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} })
    )
    expect(init.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true, audio: true, embeddedContext: true },
      sessionCapabilities: { list: {}, resume: {}, close: {} }
    })
    // The ACP registry requires an agent or terminal auth method.
    expect(init.authMethods).toEqual([expect.objectContaining({ type: "terminal", id: "capy-api-key", args: ["--setup"] })])
    await dispose()
  })

  it.skipIf(process.env.CAPY_API_KEY !== undefined)("answers authenticate once a key is saved, and asks for setup before", async () => {
    const { config, home } = machine()
    const { agent, close } = await connect(config, fakeCapy({ creates: [], sends: [], streams: [] }, []))
    await expect(agent.request(acp.methods.agent.authenticate, { methodId: "capy-api-key" })).rejects.toThrow(/capy-acp --setup/)
    writeFileSync(join(home, "api-key"), "capy_test\n", { mode: 0o600 })
    await expect(agent.request(acp.methods.agent.authenticate, { methodId: "capy-api-key" })).resolves.toBeDefined()
    await close()
  })

  it("continues the same Capy thread after a restart, through load or resume", async () => {
    const { repo, config } = machine()
    const log: Log = { creates: [], sends: [], streams: [] }

    // First process: a session that runs one prompt.
    const first = await connect(config, fakeCapy(log, [turn("01M84000000000000000000001", "one")]))
    const { sessionId } = await first.agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] })
    await first.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: "reasoning", value: "low" })
    const result = await first.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "first" }] })
    expect(result.stopReason).toBe("end_turn")
    expect(log.creates).toHaveLength(1)
    await first.close()

    // Second process: list it, load it (history replays), and prompt: a follow-up on the same thread.
    const second = await connect(config, fakeCapy(log, [turn("01M85000000000000000000002", "two")]))
    const listed = await second.agent.request(acp.methods.agent.session.list, { cwd: repo })
    expect(listed.sessions).toEqual([{ sessionId, cwd: repo, title: "first", updatedAt: expect.any(String) }])
    expect((await second.agent.request(acp.methods.agent.session.list, { cwd: "/elsewhere" })).sessions).toEqual([])

    const loaded = await second.agent.request(acp.methods.agent.session.load, { sessionId, cwd: repo, mcpServers: [] })
    const reasoning = loaded.configOptions?.find((o) => o.id === "reasoning")
    expect(reasoning && "currentValue" in reasoning ? reasoning.currentValue : undefined).toBe("low")
    expect(second.updates).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "first" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "bash (1.2 s)", kind: "other", status: "completed" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "one" } }
    ])
    await second.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "second" }] })
    expect(log.creates).toHaveLength(1)
    expect(log.sends).toMatchObject([{ threadId: "jam_TEST", body: { text: "second", model: { modelId: "anthropic/claude-opus-5-5", reasoningMode: "low" } } }])
    // Load replayed the transcript, so the stream resumed after its newest entry: nothing shown twice.
    expect(log.streams).toEqual([undefined, "01M84P0000000000000000000A"])
    await second.close()

    // Third process: resume replays nothing and continues from the second turn.
    const third = await connect(config, fakeCapy(log, [turn("01THIRD", "three")]))
    await third.agent.request(acp.methods.agent.session.resume, { sessionId, cwd: repo })
    expect(third.updates).toEqual([])
    await third.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "third" }] })
    expect(log.streams.at(-1)).toBe("01M85000000000000000000002")
    expect(log.sends.at(-1)?.threadId).toBe("jam_TEST")

    // Closing forgets the session in this process; the record stays for later.
    await third.agent.request(acp.methods.agent.session.close, { sessionId })
    await expect(third.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "x" }] })).rejects.toThrow()
    expect((await third.agent.request(acp.methods.agent.session.list, {})).sessions).toHaveLength(1)
    await third.close()
  })

  it("opens a session that never ran a prompt as a fresh one", async () => {
    const { repo, config } = machine()
    const log: Log = { creates: [], sends: [], streams: [] }
    const client = await connect(config, fakeCapy(log, [turn("01A", "hi")]))
    await client.agent.request(acp.methods.agent.session.resume, { sessionId: "never-prompted", cwd: repo })
    await client.agent.request(acp.methods.agent.session.prompt, { sessionId: "never-prompted", prompt: [{ type: "text", text: "hello" }] })
    expect(log.creates).toHaveLength(1)
    await client.close()
  })

  it("answers a missing API key in the reply, and picks the key up without a restart", async () => {
    const { repo, config } = machine()
    const log: Log = { creates: [], sends: [], streams: [] }
    let key = false
    const projects = [{ id: "project_TEST", name: "Acme", repos: [{ repoFullName: "acme/app" }] }]
    const client = await connect(
      config,
      fakeCapy(log, [turn("01A", "hi")], {
        listProjects: Effect.suspend(() => (key ? Effect.succeed(projects) : Effect.fail(new CapyConfigError({ message: "No Capy API key: set CAPY_API_KEY." }))))
      })
    )
    const { sessionId } = await client.agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] })
    const first = await client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] })
    expect(first.stopReason).toBe("end_turn")
    expect(client.updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: expect.stringMatching(/^\*\*Add your Capy API key\*\*\n\n/) } }])
    expect(JSON.stringify(client.updates)).toContain("npx -y capy-acp --setup")
    key = true
    await client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] })
    expect(log.creates).toHaveLength(1)
    await client.close()
  })

  it("lets Capy check a folder that the local list does not show, and gives the fix when Capy refuses it", async () => {
    const { repo, config, home } = machine()
    writeFileSync(join(home, "capy", "device", "workspaces.json"), JSON.stringify({ folders: [] }))
    const log: Log = { creates: [], sends: [], streams: [] }
    let linked = false
    const client = await connect(
      config,
      fakeCapy(log, [turn("01A", "hi")], {
        createThread: (body) =>
          linked
            ? Effect.sync(() => (log.creates.push(body), { id: "jam_TEST", status: "working" as const }))
            : Effect.fail(new CapyApiError({ status: 400, tag: "capy/InvalidRequest", message: `This device does not link a folder at ${repo}`, retryAfterMs: undefined }))
      })
    )
    const { sessionId } = await client.agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] })
    await client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] })
    const reply = client.updates.flatMap((u) => (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? [u.content.text] : [])).join("")
    expect(reply).toContain("**Link this folder to Capy**")
    expect(reply).toContain(`${repo} is not linked`)
    expect(reply).toContain("https://capy.ai/settings/projects")
    // The user links the folder in Capy; the local list stays empty.
    linked = true
    await client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello" }] })
    expect(log.creates.map((c) => c.device)).toEqual([{ deviceId: "device_TEST", workspace: { kind: "linked", root: repo } }])
    await client.close()
  })

  it("shows the diffs of Capy's own worktree in worktree mode", async () => {
    const { repo, config, home } = machine({ CAPY_ACP_WORKSPACE: "worktree" })
    // Capy made the thread's worktree at the base commit, and its first call edited README.md.
    const worktree = join(home, "capy", "worktrees", "jam_TEST", "app")
    mkdirSync(worktree, { recursive: true })
    const git = (...args: Array<string>) => execFileSync("git", ["-C", worktree, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args])
    git("init", "-q")
    writeFileSync(join(worktree, "README.md"), "a\n")
    git("add", "README.md")
    git("commit", "-q", "-m", "base")
    writeFileSync(join(worktree, "README.md"), "b\n")
    const log: Log = { creates: [], sends: [], streams: [] }
    const events: Array<CapyEvent> = [
      { _tag: "Status", status: "working" },
      { _tag: "ToolCall", callId: "c1", name: "execute", text: "" },
      { _tag: "Transcript", cursor: "01M84P0000000000000000001U", message: { id: "01M84P0000000000000000001U", source: "user", text: "edit" } },
      { _tag: "Transcript", cursor: "01M84P0000000000000000001T", message: { id: "c1", source: "tool", tool: "execute", calls: [{ tool: "write", durationMs: 50 }] } },
      { _tag: "Status", status: "idle" }
    ]
    const client = await connect(config, fakeCapy(log, [events]))
    const { sessionId } = await client.agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] })
    await client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "edit" }] })
    expect(log.creates.map((c) => c.device?.workspace)).toEqual([{ kind: "worktree" }])
    expect(client.updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.kind === "edit")).toMatchObject([
      { toolCallId: "c1", title: "Edited README.md", content: [{ type: "diff", path: join(worktree, "README.md"), oldText: "a\n", newText: "b\n" }] }
    ])
    await client.close()
  })

  it("refuses a second prompt while the first is still setting up", async () => {
    const { repo, config } = machine()
    const log: Log = { creates: [], sends: [], streams: [] }
    const gate = Deferred.makeUnsafe<void>()
    let calls = 0
    const projects = [{ id: "project_TEST", name: "Acme", repos: [{ repoFullName: "acme/app" }] }]
    const client = await connect(
      config,
      fakeCapy(log, [turn("01A", "hi")], {
        // Unresolved when the session opens, then slow on the prompt's re-check.
        listProjects: Effect.suspend(() =>
          ++calls === 1 ? Effect.fail(new CapyConfigError({ message: "No key" })) : Deferred.await(gate).pipe(Effect.as(projects))
        )
      })
    )
    const { sessionId } = await client.agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] })
    const first = client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "one" }] })
    await expect(client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "two" }] })).rejects.toThrow(
      /already running/
    )
    Deferred.doneUnsafe(gate, Effect.void)
    expect((await first).stopReason).toBe("end_turn")
    expect(log.creates).toHaveLength(1)
    await client.close()
  })

  it("keeps a session closed mid-turn until its turn settles, so a load can't run a second turn", async () => {
    const { repo, config } = machine()
    const log: Log = { creates: [], sends: [], streams: [] }
    const interrupted = Deferred.makeUnsafe<void>()
    const client = await connect(
      config,
      fakeCapy(log, [], {
        interrupt: () => Effect.sync(() => Deferred.doneUnsafe(interrupted, Effect.void)),
        // The run goes on until it is interrupted.
        stream: () => Stream.fromEffect(Deferred.await(interrupted)).pipe(Stream.flatMap(() => Stream.fromIterable(turn("01A", "stopped"))))
      })
    )
    const { sessionId } = await client.agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] })
    const running = client.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "long job" }] })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await client.agent.request(acp.methods.agent.session.close, { sessionId })
    await expect(client.agent.request(acp.methods.agent.session.load, { sessionId, cwd: repo, mcpServers: [] })).rejects.toThrow(/running a prompt/)
    expect((await running).stopReason).toBe("cancelled")
    // Settled: the saved session can be loaded again.
    await client.agent.request(acp.methods.agent.session.load, { sessionId, cwd: repo, mcpServers: [] })
    await client.close()
  })

  it("sends the reasoning level the picker shows when the saved one isn't offered", async () => {
    const { repo, config } = machine()
    const log: Log = { creates: [], sends: [], streams: [] }
    const client = await connect({ ...config, defaultReasoning: "max" }, fakeCapy(log, [turn("01A", "hi")]))
    const opened = await client.agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] })
    const shown = opened.configOptions?.find((o) => o.id === "reasoning")
    expect(shown && "currentValue" in shown ? shown.currentValue : undefined).toBe("high")
    await client.agent.request(acp.methods.agent.session.prompt, { sessionId: opened.sessionId, prompt: [{ type: "text", text: "hi" }] })
    expect(log.creates[0]?.model).toEqual({ modelId: "anthropic/claude-opus-5-5", reasoningMode: "high" })
    await expect(
      client.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: opened.sessionId, configId: "reasoning", value: "max" })
    ).rejects.toThrow(/does not offer/)
    await client.close()
  })

  it("prices models on Capy credits, and reports the credits that each turn used", async () => {
    const { repo, config } = machine({ CAPY_ACP_PRICING_URL: `data:text/markdown,${encodeURIComponent(PRICE_TABLE)}` })
    const log: Log = { creates: [], sends: [], streams: [] }
    let credits = 0
    const client = await connect(
      config,
      fakeCapy(log, [turn("01A", "one"), turn("01B", "two"), turn("01C", "three")], {
        listModels: Effect.succeed([
          { id: "anthropic/claude-opus-5-5", name: "Opus 5.5", route: "member_seat", billing: "Claude subscription" },
          { id: "particle/particle-1", name: "Particle-1", route: "capy", billing: "Capy API" },
          { id: "thinkingmachines/inkling-2-small", name: "Inkling 2 Small", route: "capy", billing: "Capy API" }
        ]),
        getThread: (id) =>
          Effect.sync(() => ({ id, status: "idle" as const, usage: { totalCredits: credits, llmCredits: credits - 2, vmCredits: 2, imageCredits: 0 } }))
      })
    )
    const opened = await client.agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] })
    const model = opened.configOptions?.find((o) => o.id === "model")
    expect(model && "options" in model ? model.options.map((o) => ("name" in o ? o.name : "")) : []).toEqual([
      "Opus 5.5",
      "Particle-1 · free",
      "Inkling 2 Small · $0.30/$1.00 per 1M"
    ])
    const notices = () => client.updates.filter((u) => u.sessionUpdate === "notice")
    const prompt = (text: string) =>
      client.agent.request(acp.methods.agent.session.prompt, { sessionId: opened.sessionId, prompt: [{ type: "text", text }] })

    credits = 12
    await prompt("one")
    expect(notices()).toEqual([
      {
        sessionUpdate: "notice",
        severity: "info",
        title: "Capy credits: $0.01",
        description: "This thread has used $0.01 of Capy credits (models $0.01, machines less than $0.01)."
      }
    ])
    // A turn on a subscription adds no credits and shows nothing.
    await prompt("two")
    expect(notices()).toHaveLength(1)
    credits = 5_012
    await prompt("three")
    expect(notices().at(-1)).toMatchObject({ title: "Capy credits: $5.00", description: expect.stringContaining("$5.01") })
    await client.close()
  })
})
