// How a turn behaves when the network or Capy misbehaves: drops, empty reconnects, cancels before
// the message goes out, a thread that never starts. Time is simulated, so backoffs cost nothing.
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { CapyApiError, CapyClient, type CapyError, CapyTransportError, type SendMessage, type Thread } from "@capy-acp/core/capy/client.js"
import type { CapyEvent } from "@capy-acp/core/capy/events.js"
import { runTurn, type TurnInput } from "../src/turn.js"

// Live tool frames and their transcript entry share one id, as in the recorded streams.
const toolStart: CapyEvent = { _tag: "ToolCall", callId: "call-1", name: "bash", text: "" }
const userEntry: CapyEvent = { _tag: "Transcript", cursor: "c1", message: { id: "u1", source: "user", text: "do it" } }
const replyEntries: Array<CapyEvent> = [
  { _tag: "Transcript", cursor: "c2", message: { id: "call-1", source: "tool", calls: [{ tool: "bash" }] } },
  { _tag: "Assistant", callId: "a1", text: "Done." },
  { _tag: "Transcript", cursor: "c3", message: { id: "m1", source: "assistant", callId: "a1", text: "Done." } },
  { _tag: "Status", status: "idle" }
]

interface Fake {
  /** One entry per stream open: events to send, then an optional failure. */
  readonly streams: Array<{ events: ReadonlyArray<CapyEvent>; fail?: CapyError }>
  readonly status?: () => Thread["status"]
  readonly getThread?: () => Effect.Effect<Thread, CapyError>
  readonly uploadFiles?: Effect.Effect<never>
  readonly opens: Array<string | undefined>
  readonly sends: Array<SendMessage>
  readonly calls: Array<string>
}

const fake = (f: Fake) =>
  Layer.succeed(
    CapyClient,
    CapyClient.of({
      listModels: Effect.succeed([]),
      listProjects: Effect.succeed([]),
      createThread: () => Effect.sync(() => (f.calls.push("create"), { id: "jam_test", status: "working" as const })),
      sendMessage: (_, body) => Effect.sync(() => (f.calls.push("send"), f.sends.push(body), { id: "msg" })),
      interrupt: () => Effect.sync(() => void f.calls.push("interrupt")),
      getThread: () => f.getThread?.() ?? Effect.succeed({ id: "jam_test", status: f.status?.() ?? "idle" }),
      listThreads: () => Effect.succeed([]),
      uploadFiles: (files) => f.uploadFiles ?? Effect.succeed(files.map((file, i) => ({ fileId: `file_${i}`, name: file.name }))),
      listMessages: () => Effect.succeed([]),
      attachmentUrl: () => Effect.succeed("https://files.example/x"),
      stream: (_, { cursor }) =>
        Stream.suspend(() => {
          f.opens.push(cursor)
          const next = f.streams.shift() ?? { events: [] }
          const events = Stream.fromIterable(next.events)
          return next.fail === undefined ? events : Stream.concat(events, Stream.fail(next.fail))
        })
    })
  )

const newFake = (streams: Fake["streams"], extra: Partial<Fake> = {}): Fake => ({ streams, opens: [], sends: [], calls: [], ...extra })

/** Runs a turn on simulated time, advancing the clock until it settles. */
const drive = (f: Fake, input: Partial<TurnInput> = {}) =>
  Effect.gen(function*() {
    const updates: Array<SessionUpdate> = []
    const fiber = yield* Effect.forkChild(
      runTurn({
        threadId: "jam_test",
        cursor: "c0",
        text: "do it",
        attachmentsDir: "/nonexistent",
        model: { modelId: "anthropic/claude-opus-5-5" },
        target: { projectId: "project_TEST", deviceId: "device_TEST", workspace: { kind: "worktree" } },
        waitingLimitMs: 60_000,
        cancelled: Effect.never,
        emit: (update) => Effect.sync(() => void updates.push(update)),
        ...input
      }).pipe(Effect.provide(fake(f)))
    )
    for (let i = 0; i < 400 && fiber.pollUnsafe() === undefined; i++) yield* TestClock.adjust("1 second")
    const result = yield* Fiber.join(fiber)
    return { result, updates }
  })

const texts = (updates: ReadonlyArray<SessionUpdate>) =>
  updates.flatMap((u) => (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? [u.content.text] : [])).join("")

const toolStatuses = (updates: ReadonlyArray<SessionUpdate>) =>
  updates.flatMap((u) => (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update" ? [u.status] : []))

const dropped = new CapyTransportError({ message: "Capy stream dropped: socket hang up" })

describe("runTurn when the connection fails", () => {
  it.effect("reconnects from the cursor after a mid-stream drop and shows each event once", () =>
    Effect.gen(function*() {
      const f = newFake([{ events: [{ _tag: "Status", status: "working" }, userEntry, toolStart], fail: dropped }, { events: replyEntries }], {
        status: () => "working"
      })
      const { result, updates } = yield* drive(f)
      expect(result.stopReason).toBe("end_turn")
      expect(result.cursor).toBe("c3")
      // The second connection resumes after the last committed entry the first one delivered.
      expect(f.opens).toEqual(["c0", "c1"])
      expect(texts(updates)).toBe("Done.")
      expect(toolStatuses(updates)).toEqual(["in_progress", "completed"])
    }))

  it.effect("gives up after repeated failures with a note, closing open tool calls", () =>
    Effect.gen(function*() {
      const f = newFake(
        [{ events: [{ _tag: "Status", status: "working" }, toolStart], fail: dropped }, ...Array.from({ length: 40 }, () => ({ events: [], fail: dropped }))],
        { status: () => "working" }
      )
      const { result, updates } = yield* drive(f)
      expect(result.stopReason).toBe("end_turn")
      expect(f.opens.length).toBe(13)
      expect(texts(updates)).toContain("**Lost the connection to Capy** (Capy stream dropped: socket hang up)")
      expect(toolStatuses(updates)).toEqual(["in_progress", "failed"])
    }))

  it.effect("reports a rejected status check in the reply instead of failing the prompt", () =>
    Effect.gen(function*() {
      const gone = new CapyApiError({ status: 404, tag: "capy/NotFound", message: "Thread not found", retryAfterMs: undefined })
      const f = newFake([{ events: [toolStart] }], { getThread: () => Effect.fail(gone) })
      const { result, updates } = yield* drive(f)
      expect(result.stopReason).toBe("end_turn")
      expect(texts(updates)).toContain("Capy capy/NotFound (404): Thread not found")
      expect(toolStatuses(updates)).toEqual(["in_progress", "failed"])
    }))

  it.effect("backs off when the stream keeps closing empty while the thread works", () =>
    Effect.gen(function*() {
      // Busy for one simulated minute, then idle.
      const f = newFake([], {
        getThread: () => Clock.currentTimeMillis.pipe(Effect.map((now) => ({ id: "jam_test", status: now < 60_000 ? "working" as const : "idle" as const })))
      })
      yield* drive(f)
      // Without a pause this loop reconnected tens of thousands of times a second; with a 4 s cap
      // on the pause, a minute holds a couple of dozen reconnects.
      expect(f.opens.length).toBeLessThanOrEqual(30)
    }))

  it.effect("clears a cursor Capy rejects instead of failing every read", () =>
    Effect.gen(function*() {
      const badCursor = new CapyApiError({ status: 400, tag: "capy/InvalidRequest", message: "Invalid event cursor: c0", retryAfterMs: undefined })
      const f = newFake([{ events: [], fail: badCursor }, { events: [userEntry, ...replyEntries] }])
      const { result, updates } = yield* drive(f)
      expect(f.opens).toEqual(["c0", undefined])
      expect(result.cursor).toBe("c3")
      expect(texts(updates)).toBe("Done.")
    }))
})

describe("runTurn edge cases", () => {
  it.effect("a cancel while files upload sends nothing", () =>
    Effect.gen(function*() {
      const f = newFake([], { uploadFiles: Effect.never })
      const { result } = yield* drive(f, {
        files: [{ name: "shot.png", mediaType: "image/png", bytes: new Uint8Array([1]) }],
        cancelled: Effect.sleep("2 seconds")
      })
      expect(result.stopReason).toBe("cancelled")
      expect(f.calls).toEqual([])
    }))

  it.effect("shows the call a cancel stopped as failed, though Capy commits it like a finished one", () =>
    Effect.gen(function*() {
      // As seen live: the call's first frame is its transcript entry, committed after the interrupt.
      const stopped: CapyEvent = { _tag: "Transcript", cursor: "c2", message: { id: "call-1", source: "tool", tool: "execute", text: "" } }
      const f: Fake = newFake(
        [
          { events: [{ _tag: "Status", status: "working" }, userEntry] },
          { events: [] },
          { events: [] },
          { events: [] },
          { events: [stopped, { _tag: "Status", status: "idle" }] }
        ],
        { status: () => (f.opens.length >= 5 ? "idle" : "working") }
      )
      const { result, updates } = yield* drive(f, { cancelled: Effect.sleep("1 second") })
      expect(result.stopReason).toBe("cancelled")
      expect(f.calls).toContain("interrupt")
      expect(toolStatuses(updates)).toEqual(["failed"])
    }))

  it.effect("keeps a call that finished just before the cancel as completed", () =>
    Effect.gen(function*() {
      // A finished call lists its inner tools; the stopped one does not.
      const finished: CapyEvent = {
        _tag: "Transcript",
        cursor: "c2",
        message: { id: "call-1", source: "tool", tool: "execute", text: "", calls: [{ tool: "bash", durationMs: 800 }] }
      }
      const stopped: CapyEvent = { _tag: "Transcript", cursor: "c3", message: { id: "call-2", source: "tool", tool: "execute", text: "" } }
      const f: Fake = newFake(
        [
          { events: [{ _tag: "Status", status: "working" }, userEntry] },
          { events: [] },
          { events: [] },
          { events: [] },
          { events: [finished, stopped, { _tag: "Status", status: "idle" }] }
        ],
        { status: () => (f.opens.length >= 5 ? "idle" : "working") }
      )
      const { result, updates } = yield* drive(f, { cancelled: Effect.sleep("1 second") })
      expect(result.stopReason).toBe("cancelled")
      expect(toolStatuses(updates)).toEqual(["completed", "failed"])
    }))

  it.effect("says so when Capy never starts on the message", () =>
    Effect.gen(function*() {
      const f = newFake([])
      const { result, updates } = yield* drive(f)
      expect(result.stopReason).toBe("end_turn")
      expect(texts(updates)).toContain("Capy has not started on this message yet")
    }))

  it.effect("blames a starting cloud machine, not this computer, when a cloud thread never starts", () =>
    Effect.gen(function*() {
      const f = newFake([])
      const { updates } = yield* drive(f, { target: { projectId: "project_TEST", workspace: { kind: "cloud" } } })
      expect(texts(updates)).toContain("Its cloud machine may still be starting.")
      expect(texts(updates)).not.toContain("capy dock")
    }))
})
