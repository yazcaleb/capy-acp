// The shared core of the CLI and the MCP server: where a thread runs, what a report says, when a wait
// ends, and the Problem (with its next action) for each failure. Capy is a fake; the folders are real.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { vi } from "vitest"
import { Effect, Fiber, Layer, Stream } from "effect"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { CapyApiError, CapyClient, CapyTransportError, type CreateThread, make, type SendMessage, type Thread } from "../src/capy/client.js"
import type { CapyEvent, Message } from "../src/capy/events.js"
import { readConfig } from "./config.js"
import { type Activity, DelegateError, makeDelegate, settle, type StartInput, threadReport, toProblem, webOrigin } from "../src/delegate.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tmp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** A clone of acme/app, and Capy files that make this computer a device, optionally linking the clone. */
const computer = (options: { device?: boolean; linked?: boolean; env?: Record<string, string> } = {}) => {
  const repo = tmp("capy-delegate-repo-")
  execFileSync("git", ["init", "-q", repo])
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/app.git"])
  const capyHome = tmp("capy-delegate-home-")
  const desktop = tmp("capy-delegate-desktop-")
  if (options.device === true) writeFileSync(join(desktop, "device-ids.json"), JSON.stringify({ orgs: { org_1: "device_LOCAL" } }))
  if (options.linked === true) {
    mkdirSync(join(capyHome, "device"))
    writeFileSync(join(capyHome, "device", "workspaces.json"), JSON.stringify({ folders: [{ root: repo, repos: ["acme/app"] }] }))
  }
  const config = readConfig({
    CAPY_HOME: capyHome,
    CAPY_DESKTOP_CONFIG_DIR: desktop,
    CAPY_API_KEY_FILE: join(capyHome, "no-such-key"),
    CAPY_API_URL: "https://api.capy.ai/api/v1",
    ...options.env
  })
  return { repo, config, empty: tmp("capy-delegate-empty-") }
}

const PROJECTS = [
  { id: "project_APP", name: "App", repos: [{ repoFullName: "acme/app" }] },
  { id: "project_MONO", name: "Mono", repos: [{ repoFullName: "acme/web" }, { repoFullName: "acme/api" }] }
]

const USER_ID = "01KA0000000000000000000001"

interface Log {
  readonly creates: Array<CreateThread>
  readonly sends: Array<{ threadId: string; body: SendMessage }>
  readonly interrupts: Array<string>
  readonly opens: Array<string | undefined>
  readonly listed: Array<string>
}

const newLog = (): Log => ({ creates: [], sends: [], interrupts: [], opens: [], listed: [] })

const fakeCapy = (
  log: Log,
  options: {
    thread?: () => Thread
    messages?: () => ReadonlyArray<Message>
    stream?: ReadonlyArray<CapyEvent> | "never"
    threads?: Record<string, ReadonlyArray<Thread>>
    /** Reads of the thread fail with a 503, as when Capy is briefly down. */
    unreadable?: boolean
  } = {}
) =>
  Layer.succeed(
    CapyClient,
    CapyClient.of({
      listModels: Effect.succeed([{ id: "anthropic/claude-opus-5-5", name: "Opus", reasoningModes: ["low", "high"] }]),
      listProjects: Effect.succeed(PROJECTS),
      createThread: (body) => Effect.sync(() => (log.creates.push(body), { id: "jam_new", status: "working" as const, projectId: body.projectId })),
      sendMessage: (threadId, body) => Effect.sync(() => (log.sends.push({ threadId, body }), { id: "msg" })),
      interrupt: (threadId) => Effect.sync(() => void log.interrupts.push(threadId)),
      getThread: (id) =>
        options.unreadable === true
          ? Effect.fail(new CapyApiError({ status: 503, tag: "http/503", message: "Service Unavailable", retryAfterMs: undefined }))
          : Effect.succeed(options.thread?.() ?? { id, status: "idle" as const }),
      listThreads: (projectId) => Effect.sync(() => (log.listed.push(projectId), options.threads?.[projectId] ?? [])),
      uploadFiles: () => Effect.succeed([]),
      listMessages: () => Effect.succeed(options.messages?.() ?? []),
      attachmentUrl: () => Effect.succeed(""),
      stream: (_, { cursor }) =>
        Stream.suspend(() => {
          log.opens.push(cursor)
          return options.stream === "never" ? Stream.never : Stream.fromIterable(options.stream ?? [])
        })
    })
  )

const start = (config: ReturnType<typeof computer>["config"], log: Log, input: StartInput) =>
  makeDelegate(config).start(input).pipe(Effect.provide(fakeCapy(log)))

const problemOf = <A>(effect: Effect.Effect<A, DelegateError>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.problem))

describe("where a thread runs", () => {
  it.effect("auto works in a fresh worktree on this computer when the folder's repository is linked", () =>
    Effect.gen(function*() {
      const { repo, config } = computer({ device: true, linked: true })
      const log = newLog()
      const report = yield* start(config, log, { task: "Fix the flaky test", folder: repo })
      expect(log.creates).toEqual([
        {
          requestId: expect.any(String),
          projectId: "project_APP",
          title: "Fix the flaky test",
          message: "Fix the flaky test",
          // No model given: none is sent, so Capy's own default applies.
          device: { deviceId: "device_LOCAL", workspace: { kind: "worktree" } }
        }
      ])
      expect(report).toMatchObject({ id: "jam_new", where: "worktree", deviceId: "device_LOCAL", url: "https://capy.ai/thread/jam_new" })
      expect(report.note).toContain("not in your folder")
    }))

  it.effect("here edits the linked folder in place, only when asked", () =>
    Effect.gen(function*() {
      const { repo, config } = computer({ device: true, linked: true })
      const log = newLog()
      const report = yield* start(config, log, { task: "Edit it", folder: repo, where: "here", model: "openai/gpt-6.2-astra", reasoning: "medium" })
      expect(log.creates[0]).toMatchObject({
        model: { modelId: "openai/gpt-6.2-astra", reasoningMode: "medium" },
        device: { deviceId: "device_LOCAL", workspace: { kind: "linked", root: repo } }
      })
      expect(report.where).toBe("here")
    }))

  it.effect("worktree uses CAPY_DEVICE_ID and the project's only repository when this computer has no Capy", () =>
    Effect.gen(function*() {
      const { empty, config } = computer({ env: { CAPY_DEVICE_ID: "device_REMOTE" } })
      const log = newLog()
      const report = yield* start(config, log, { task: "Do it", folder: empty, where: "worktree", project: "App" })
      expect(log.creates[0]?.device).toEqual({ deviceId: "device_REMOTE", workspace: { kind: "worktree", repos: ["acme/app"], startFromOrigin: true } })
      expect(log.creates[0]).not.toHaveProperty("machineSize")
      expect(report).toMatchObject({ where: "worktree", deviceId: "device_REMOTE" })
      expect(report.note).toContain("device_REMOTE")
    }))

  it.effect("auto takes the project and repository of the folder's remote for a named device", () =>
    Effect.gen(function*() {
      const { repo, config } = computer()
      const log = newLog()
      yield* start(config, log, { task: "Do it", folder: repo, device: "device_OTHER" })
      expect(log.creates[0]).toMatchObject({
        projectId: "project_APP",
        device: { deviceId: "device_OTHER", workspace: { kind: "worktree", repos: ["acme/app"], startFromOrigin: true } }
      })
    }))

  it.effect("asks for a repository when the project has several", () =>
    Effect.gen(function*() {
      const { empty, config } = computer({ env: { CAPY_DEVICE_ID: "device_REMOTE" } })
      const log = newLog()
      const problem = yield* problemOf(start(config, log, { task: "Do it", folder: empty, project: "Mono" }))
      expect(problem.nextAction).toEqual({ kind: "use_option", option: "repo", why: "Use one of: acme/web, acme/api." })
      yield* start(config, log, { task: "Do it", folder: empty, project: "Mono", repo: "Acme/API" })
      expect(log.creates[0]?.device?.workspace).toEqual({ kind: "worktree", repos: ["acme/api"], startFromOrigin: true })
    }))

  it.effect("auto with no device fails with the three ways out, and never starts a cloud thread", () =>
    Effect.gen(function*() {
      const { repo, config } = computer()
      const log = newLog()
      const problem = yield* problemOf(start(config, log, { task: "Do it", folder: repo }))
      expect(problem.title).toBe("Choose where Capy runs this thread")
      expect(problem.steps).toHaveLength(3)
      expect(problem.steps[0]).toContain("this folder linked")
      expect(problem.steps[1]).toContain("CAPY_DEVICE_ID")
      expect(problem.steps[2]).toContain('where "cloud"')
      expect(problem.steps.join(" ")).not.toContain("Send your message again")
      expect(problem.nextAction).toMatchObject({ kind: "ask_human", say: expect.stringContaining("`npx -y capy-acp --setup` in a terminal in this folder") })
      expect(log.creates).toEqual([])
    }))

  it.effect("without a folder, a working folder that is no repository asks for the folder option", () =>
    Effect.gen(function*() {
      const { empty, config } = computer({ device: true })
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(empty)
      const log = newLog()
      const problem = yield* problemOf(start(config, log, { task: "Fix it" })).pipe(Effect.ensuring(Effect.sync(() => cwd.mockRestore())))
      expect(problem.title).toBe("Pass the repository folder")
      expect(problem.nextAction).toMatchObject({ kind: "use_option", option: "folder", why: expect.stringContaining(`${empty} is not a git repository`) })
      // A folder that the caller named keeps the steps for that folder.
      const named = yield* problemOf(start(config, log, { task: "Fix it", folder: empty }))
      expect(named.title).toBe("Choose where Capy runs this thread")
      expect(log.creates).toEqual([])
    }))

  it.effect("auto with a device but an unlinked folder also fails with the three ways out", () =>
    Effect.gen(function*() {
      const { repo, config } = computer({ device: true })
      const log = newLog()
      const problem = yield* problemOf(start(config, log, { task: "Do it", folder: repo }))
      expect(problem.title).toBe("Choose where Capy runs this thread")
      expect(problem.detail).toContain("not linked")
      expect(log.creates).toEqual([])
    }))

  it.effect("cloud runs only when asked, with no device, and says machine time costs credits", () =>
    Effect.gen(function*() {
      const { repo, config } = computer({ device: true, linked: true })
      const log = newLog()
      const sized = yield* start(config, log, { task: "Do it", where: "cloud", project: "project_MONO", machineSize: "large" })
      const plain = yield* start(config, log, { task: "Do it", where: "cloud", folder: repo })
      expect(log.creates[0]).toMatchObject({ projectId: "project_MONO", machineSize: "large" })
      expect(log.creates[0]).not.toHaveProperty("device")
      expect(log.creates[1]).toMatchObject({ projectId: "project_APP" })
      expect(log.creates[1]).not.toHaveProperty("device")
      expect(log.creates[1]).not.toHaveProperty("machineSize")
      expect(sized).toMatchObject({ where: "cloud", deviceId: undefined })
      expect(sized.note).toContain("large cloud machine")
      expect(plain.note).toContain("costs Capy credits")
    }))

  it.effect("refuses a machine size for a device thread, and an unknown project", () =>
    Effect.gen(function*() {
      const { repo, config } = computer({ device: true, linked: true })
      const log = newLog()
      const sized = yield* problemOf(start(config, log, { task: "Do it", folder: repo, machineSize: "small" }))
      expect(sized.nextAction).toMatchObject({ kind: "use_option", option: "where" })
      const unknown = yield* problemOf(start(config, log, { task: "Do it", folder: repo, project: "Nope" }))
      expect(unknown.nextAction).toEqual({ kind: "use_option", option: "project", why: "Use one of these projects: App (project_APP), Mono (project_MONO)." })
      expect(log.creates).toEqual([])
    }))
})

describe("reports", () => {
  const thread: Thread = {
    id: "jam_1",
    status: "waiting",
    title: "Fix it",
    projectId: "project_APP",
    lastModelId: "anthropic/claude-opus-5-5",
    ask: { kind: "conversation", text: "Which branch?" },
    needsYou: true,
    usage: { totalCredits: 1234, llmCredits: 1000, vmCredits: 234 }
  }

  it("reads the last reply, linked pull requests, asks and credits", () => {
    const long = "x".repeat(9000)
    const report = threadReport(
      thread,
      [
        { id: "u1", source: "user", text: "Fix it https://github.com/acme/app/pull/1" },
        { id: "a1", source: "assistant", text: "Opened https://github.com/acme/app/pull/7 and https://capy.ai/pull/acme/web/8." },
        { id: "t1", source: "tool", text: "bash" },
        { id: "a2", source: "assistant", text: long },
        { id: "a3", source: "assistant", text: "  " }
      ],
      { target: undefined, origin: "https://capy.ai" }
    )
    expect(report.pullRequests).toEqual([
      { url: "https://github.com/acme/app/pull/7", repo: "acme/app", number: 7 },
      { url: "https://github.com/acme/web/pull/8", repo: "acme/web", number: 8 }
    ])
    expect(report.lastReply?.startsWith("x".repeat(8000))).toBe(true)
    expect(report.lastReply).toContain("1000 more characters")
    expect(report.asks).toEqual([{ kind: "conversation", text: "Which branch?" }])
    expect(report).toMatchObject({ needsYou: true, where: undefined, deviceId: undefined, url: "https://capy.ai/thread/jam_1" })
    expect(report.usage).toMatchObject({ totalCredits: 1234, vmCredits: 234, cost: expect.stringMatching(/^\$1\.23/) })
  })

  it("gives a web link only for Capy's own API host", () => {
    expect(webOrigin("https://api.capy.ai/api/v1")).toBe("https://capy.ai")
    expect(webOrigin("https://capy.test/api/v1")).toBeUndefined()
    expect(threadReport(thread, [], { target: undefined, origin: undefined }).url).toBeUndefined()
  })

  it("gives every Capy error a next action", () => {
    const config = readConfig({ CAPY_API_URL: "https://api.capy.ai/api/v1" })
    const api = (status: number, tag: string, message = "no", retryAfterMs?: number) =>
      new CapyApiError({ status, tag, message, retryAfterMs })
    expect(toProblem(config, api(401, "capy/Unauthorized")).nextAction.kind).toBe("ask_human")
    expect(toProblem(config, api(429, "capy/RateLimited", "slow down", 90_000)).nextAction).toEqual({ kind: "retry", afterMs: 90_000 })
    expect(toProblem(config, api(503, "http/503")).nextAction).toEqual({ kind: "retry", afterMs: 30_000 })
    expect(toProblem(config, api(404, "capy/ThreadNotFound"), { threadId: "jam_x" }).nextAction).toEqual({ kind: "run_command", command: "npx -y capy-acp threads" })
    expect(toProblem(config, api(400, "ModelSelection.Rejected", "Unknown model")).nextAction).toMatchObject({ kind: "use_option", option: "model" })
    expect(toProblem(config, api(400, "capy/InvalidRequest", "Device not found"), { deviceId: "device_X" }).title).toBe("Check the Capy device id")
    expect(toProblem(config, api(403, "capy/DeviceAccessDenied")).nextAction.kind).toBe("ask_human")
    expect(toProblem(config, new Error("boom")).detail).toBe("boom")
    // A response this version cannot read does not clear on a retry.
    const unreadable = toProblem(config, new CapyTransportError({ message: "Unexpected Capy API response: SchemaError(status)", decode: true }))
    expect(unreadable).toMatchObject({ title: "Update capy-acp", nextAction: { kind: "ask_human", say: expect.stringContaining("npx -y capy-acp@latest") } })
    expect(toProblem(config, new CapyTransportError({ message: "socket hang up" })).nextAction.kind).toBe("retry")
  })
})

describe("wait", () => {
  const userEntry: Message = { id: USER_ID, source: "user", text: "do it" }
  const reply: Message = { id: "01KA0000000000000000000002", source: "assistant", callId: "a1", text: "Done. See https://github.com/acme/app/pull/3" }

  /** Follows jam_1 from a delegate that has not started it, collecting activity. */
  const follow = (log: Log, options: Parameters<typeof fakeCapy>[1], timeoutMs = 60_000) =>
    Effect.gen(function*() {
      const activity: Array<Activity> = []
      const result = yield* makeDelegate(readConfig({ CAPY_API_URL: "https://api.capy.ai/api/v1" }))
        .wait("jam_1", { timeoutMs, onActivity: (a) => void activity.push(a) })
        .pipe(Effect.provide(fakeCapy(log, options)))
      return { result, activity }
    })

  it.effect("ends when the run ends, with the reply, activity lines and pull requests", () =>
    Effect.gen(function*() {
      const log = newLog()
      let reads = 0
      const { result, activity } = yield* follow(log, {
        messages: () => (reads++ === 0 ? [userEntry] : [userEntry, reply]),
        stream: [
          { _tag: "Status", status: "working" },
          { _tag: "ToolCall", callId: "call-1", name: "bash", text: "" },
          { _tag: "Transcript", cursor: "c1", message: { id: "call-1", source: "tool", calls: [{ tool: "bash", durationMs: 1200 }] } },
          { _tag: "Assistant", callId: "a1", text: "Done." },
          { _tag: "Transcript", cursor: reply.id, message: reply },
          { _tag: "Status", status: "idle" }
        ],
        thread: () => ({ id: "jam_1", status: "idle" })
      })
      expect(log.opens).toEqual([USER_ID])
      expect(result).toMatchObject({ status: "idle", timedOut: false, lastReply: reply.text, pullRequests: [{ number: 3 }] })
      expect(activity).toEqual([
        { kind: "activity", text: "Capy is working" },
        { kind: "activity", text: "ran bash (1.2 s)" },
        { kind: "reply", text: "Done." },
        { kind: "reply", text: " See https://github.com/acme/app/pull/3" },
        { kind: "activity", text: "Capy is done" }
      ])
    }))

  it.effect("ends when the thread waits on a person, with the ask", () =>
    Effect.gen(function*() {
      const log = newLog()
      const { result } = yield* follow(log, {
        messages: () => [userEntry],
        stream: [{ _tag: "Status", status: "working" }, { _tag: "Status", status: "waiting" }],
        thread: () => ({ id: "jam_1", status: "waiting", ask: { kind: "environment", text: "Add STRIPE_KEY" }, needsYou: true })
      })
      expect(result).toMatchObject({ status: "waiting", timedOut: false, needsYou: true, asks: [{ kind: "environment", text: "Add STRIPE_KEY" }] })
    }))

  it.effect("ends when the run fails", () =>
    Effect.gen(function*() {
      const log = newLog()
      const { result } = yield* follow(log, {
        messages: () => [userEntry],
        stream: [{ _tag: "Status", status: "working" }, { _tag: "Status", status: "failed" }],
        thread: () => ({ id: "jam_1", status: "failed" })
      })
      expect(result).toMatchObject({ status: "failed", timedOut: false })
    }))

  it.effect("times out without stopping the thread", () =>
    Effect.gen(function*() {
      const log = newLog()
      const fiber = yield* Effect.forkChild(
        follow(log, { messages: () => [userEntry], stream: "never", thread: () => ({ id: "jam_1", status: "working" }) }, 5_000)
      )
      yield* TestClock.adjust("6 seconds")
      const { result } = yield* Fiber.join(fiber)
      expect(result).toMatchObject({ status: "working", timedOut: true })
      expect(log.interrupts).toEqual([])
      expect(log.sends).toEqual([])
    }))
})

describe("wait after a message", () => {
  const config = readConfig({ CAPY_API_URL: "https://api.capy.ai/api/v1" })
  const earlier: ReadonlyArray<Message> = [
    { id: "01KA0000000000000000000001", source: "user", text: "first" },
    { id: "01KA0000000000000000000002", source: "assistant", text: "Done with the first task." }
  ]

  it.effect("keeps looking for two minutes when Capy has not started on the message, then says so without the old reply", () =>
    Effect.gen(function*() {
      const log = newLog()
      const layer = fakeCapy(log, { messages: () => earlier, stream: [], thread: () => ({ id: "jam_1", status: "idle" }) })
      const delegate = makeDelegate(config)
      yield* delegate.send("jam_1", "Now the second task").pipe(Effect.provide(layer))
      const fiber = yield* Effect.forkChild(delegate.wait("jam_1", { timeoutMs: 600_000 }).pipe(Effect.provide(layer)))
      yield* TestClock.adjust("1 minute")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("2 minutes")
      const result = yield* Fiber.join(fiber)
      expect(result).toMatchObject({ status: "idle", timedOut: false, notStarted: true, lastReply: undefined })
      expect(log.sends).toHaveLength(1)
      expect(log.opens.length).toBeLessThan(100)
    }))

  it.effect("ends at once when Capy already answered the message", () =>
    Effect.gen(function*() {
      const log = newLog()
      const answered = (): ReadonlyArray<Message> => [
        ...earlier,
        { id: "01KA0000000000000000000003", source: "user", text: "Now the second task", clientKey: log.sends[0]!.body.clientKey },
        { id: "01KA0000000000000000000004", source: "assistant", text: "Done with the second task." }
      ]
      const layer = fakeCapy(log, { messages: answered, stream: [], thread: () => ({ id: "jam_1", status: "idle" }) })
      const delegate = makeDelegate(config)
      yield* delegate.send("jam_1", "Now the second task").pipe(Effect.provide(layer))
      const result = yield* delegate.wait("jam_1", { timeoutMs: 600_000 }).pipe(Effect.provide(layer))
      expect(result).toMatchObject({ status: "idle", notStarted: false, lastReply: "Done with the second task." })
      expect(log.opens).toHaveLength(1)
    }))

  it.effect("backs off while the thread waits on a background command and its stream closes with nothing new", () =>
    Effect.gen(function*() {
      const log = newLog()
      const layer = fakeCapy(log, { messages: () => earlier, stream: [], thread: () => ({ id: "jam_1", status: "waiting" }) })
      const fiber = yield* Effect.forkChild(makeDelegate(config).wait("jam_1", { timeoutMs: 10_000 }).pipe(Effect.provide(layer)))
      yield* TestClock.adjust("11 seconds")
      const result = yield* Fiber.join(fiber)
      expect(result).toMatchObject({ status: "waiting", timedOut: true })
      expect(log.opens.length).toBeLessThan(10)
    }))
})

describe("send, stop and list", () => {
  it.effect("does not turn a failed read after the send into an error, which would invite a resend", () =>
    Effect.gen(function*() {
      const log = newLog()
      const report = yield* makeDelegate(readConfig({})).send("jam_1", "Also add a test").pipe(Effect.provide(fakeCapy(log, { unreadable: true })))
      expect(log.sends).toHaveLength(1)
      expect(report).toMatchObject({ id: "jam_1", status: "working" })
      expect(report.note).toContain("Capy has the message, but capy-acp could not read the thread afterwards")
      expect(report.note).toContain("Do not send the message again")
    }))

  it.effect("queues a message by default, interrupts only when asked, and stops a run", () =>
    Effect.gen(function*() {
      const log = newLog()
      const delegate = makeDelegate(readConfig({}))
      const layer = fakeCapy(log, { thread: () => ({ id: "jam_1", status: "working" }) })
      yield* delegate.send("jam_1", "Also add a test").pipe(Effect.provide(layer))
      yield* delegate.send("jam_1", "Stop, use main", { interrupt: true }).pipe(Effect.provide(layer))
      const stopped = yield* delegate.stop("jam_1").pipe(Effect.provide(layer))
      expect(log.sends.map((s) => [s.threadId, s.body.text, s.body.delivery])).toEqual([
        ["jam_1", "Also add a test", "queue"],
        ["jam_1", "Stop, use main", "interrupt"]
      ])
      expect(log.sends[0]?.body.clientKey).not.toBe(log.sends[1]?.body.clientKey)
      expect(log.interrupts).toEqual(["jam_1"])
      expect(stopped.id).toBe("jam_1")
    }))

  it.effect("lists recent threads newest first, across projects or for one", () =>
    Effect.gen(function*() {
      const log = newLog()
      const threads = {
        project_APP: [{ id: "jam_a", status: "idle" as const, title: "A", lastActivityAt: "2026-11-20T10:00:00Z" }],
        project_MONO: [
          { id: "jam_b", status: "working" as const, lastActivityAt: "2026-11-26T10:00:00Z", needsYou: true },
          { id: "jam_c", status: "idle" as const, updatedAt: "2026-11-01T10:00:00Z" }
        ]
      }
      const delegate = makeDelegate(readConfig({ CAPY_API_URL: "https://api.capy.ai/api/v1" }))
      const rows = yield* delegate.list({ limit: 2 }).pipe(Effect.provide(fakeCapy(log, { threads })))
      expect(rows.map((r) => r.id)).toEqual(["jam_b", "jam_a"])
      expect(rows[0]).toMatchObject({ projectName: "Mono", needsYou: true, url: "https://capy.ai/thread/jam_b" })
      log.listed.length = 0
      const one = yield* delegate.list({ project: "App" }).pipe(Effect.provide(fakeCapy(log, { threads })))
      expect(one.map((r) => r.id)).toEqual(["jam_a"])
      expect(log.listed).toEqual(["project_APP"])
    }))
})

describe("without an API key", () => {
  it.effect("asks the person to run setup, and sends nothing to Capy", () =>
    Effect.gen(function*() {
      const saved = process.env.CAPY_API_KEY
      delete process.env.CAPY_API_KEY
      const { repo, config } = computer({ device: true, linked: true })
      const seen: Array<HttpClientRequest.HttpClientRequest> = []
      const http = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => (seen.push(request), HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }))))
        )
      )
      const layer = Layer.effect(CapyClient, make(config)).pipe(Layer.provide(http))
      const outcome = yield* settle(config, makeDelegate(config).start({ task: "Do it", folder: repo })).pipe(Effect.provide(layer))
      if (saved !== undefined) process.env.CAPY_API_KEY = saved
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.problem.title).toBe("Add your Capy API key")
      expect(outcome.problem.nextAction).toMatchObject({ kind: "ask_human", say: expect.stringContaining("npx -y capy-acp --setup") })
      expect(outcome.problem.nextAction).toMatchObject({ say: expect.stringContaining("CAPY_API_KEY") })
      expect(seen).toEqual([])
    }))
})
