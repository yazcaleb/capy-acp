/**
 * Runs one ACP prompt turn against a Capy thread: create or follow up, then stream until the
 * thread settles. Reconnects resume from the last transcript cursor, so nothing is shown twice.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ContentBlock, SessionUpdate, StopReason, ToolKind } from "@agentclientprotocol/sdk"
import { Duration, Effect, Option, Result, Stream } from "effect"
import { CapyClient, type CapyError, CapyTransportError, describeError, type FileUpload, isTransient, type MessageFile, type ModelSelection } from "./capy/client.js"
import type { MessageAttachment } from "./capy/events.js"
import type { ChangeTracker, FileChange } from "./changes.js"
import type { DeviceWorkspace } from "./workspace.js"
import { closedTools, fileChangeUpdate, finishTools, initialTurn, step, turnComplete, type TurnSignal, type TurnState } from "./translate.js"

export interface ThreadTarget {
  readonly projectId: string
  readonly deviceId: string
  readonly workspace: DeviceWorkspace
}

export interface TurnInput {
  readonly threadId: string | undefined
  readonly cursor: string | undefined
  readonly text: string
  /** Images and other media from the prompt, attached to the Capy message. */
  readonly files?: ReadonlyArray<FileUpload> | undefined
  /** Where a new thread's first-prompt files are saved for the agent to read (see below). */
  readonly attachmentsDir: string
  readonly model: ModelSelection
  readonly target: ThreadTarget
  readonly waitingLimitMs: number
  /** Resolves when the client cancels the prompt. */
  readonly cancelled: Effect.Effect<void>
  readonly emit: (update: SessionUpdate) => Effect.Effect<void>
  /** Watches the folder the thread works in (the open folder, or Capy's worktree) so edits reach the client as diffs. */
  readonly changes?: ChangeTracker | undefined
  /** Called whenever the resume cursor advances, so a restarted adapter picks up exactly there. */
  readonly onCursor?: ((threadId: string, cursor: string) => Effect.Effect<void>) | undefined
}

export interface TurnResult {
  /** Undefined only when a first prompt was cancelled before its thread was created. */
  readonly threadId: string | undefined
  readonly cursor: string | undefined
  readonly stopReason: StopReason
}

const MAX_IDLE_RECHECKS = 5
/** How long an `until=run` connection may stay open after the turn ended before it is dropped. */
const END_GRACE_MS = 10_000
const CANCEL_GRACE = Duration.seconds(20)
/** Failed reads in a row before the turn gives up on the connection: about four minutes of backoff. */
const MAX_FAILURES = 12
const backoff = (attempt: number) => Duration.millis(Math.min(30_000, 250 * 2 ** attempt))

const chunk = (text: string): SessionUpdate => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })

/** Kinds of calls that cannot write files: changes seen while one ran are not its doing. */
const READ_ONLY: ReadonlySet<ToolKind | undefined> = new Set(["read", "search", "fetch", "think"])

export const titleOf = (text: string) => {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "capy-acp session"
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

type Outcome = "ended" | "failed" | "archived" | "waiting-limit" | "cancelled" | "lost" | "not-started"

const attachedLabel = (files: ReadonlyArray<{ readonly name: string }>) => `Attached: ${files.map((f) => f.name).join(", ")}`

const savedNote = (paths: ReadonlyArray<string>) =>
  paths.length === 0 ? "" : `Attached files, saved on this machine:\n${paths.map((path) => `- ${path}`).join("\n")}`

/** Writes a prompt's files under a fresh directory (owner-only) and returns their paths. */
const saveAttachments = (dir: string, files: ReadonlyArray<FileUpload>): Effect.Effect<ReadonlyArray<string>, CapyTransportError> =>
  Effect.tryPromise({
    try: async () => {
      const folder = join(dir, randomUUID())
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const used = new Set<string>()
      const paths: Array<string> = []
      for (const file of files) {
        // Names come from the client: keep the last path segment only, and never reuse one. Characters
        // Windows forbids go too (a `:` would write an NTFS alternate stream of another file).
        const base = basename(file.name.replace(/\\/g, "/")).replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+/, "") || "attachment"
        let name = base
        for (let n = 2; used.has(name); n++) name = `${n}-${base}`
        used.add(name)
        const path = join(folder, name)
        await writeFile(path, file.bytes, { mode: 0o600 })
        paths.push(path)
      }
      return paths
    },
    catch: (cause) => new CapyTransportError({ message: `Could not save the attachments for Capy: ${String(cause)}`, cause })
  })

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

/**
 * A link to a file on a transcript entry. A file the agent made on this machine links to its
 * path; anything else gets Capy's short-lived download URL. Never fails: without either, the
 * file is named in text.
 */
export const fileLink = (capy: CapyClient["Service"], threadId: string, file: MessageAttachment): Effect.Effect<ContentBlock> =>
  Effect.gen(function*() {
    // Capy reports Windows paths with forward slashes (`C:/Users/…`); isAbsolute takes either form.
    const local = file.sourcePath !== undefined && isAbsolute(file.sourcePath) && existsSync(file.sourcePath)
    const uri = local
      ? pathToFileURL(file.sourcePath!).href
      : yield* capy.attachmentUrl(threadId, file.fileId).pipe(Effect.orElseSucceed(() => undefined))
    const details = [file.mediaType, file.sizeBytes === undefined ? undefined : formatBytes(file.sizeBytes)].filter((d) => d !== undefined)
    if (uri === undefined) return { type: "text", text: `\n\n[Capy attached ${file.name}]` }
    return {
      type: "resource_link",
      uri,
      name: file.name,
      ...(file.title === undefined ? {} : { title: file.title }),
      ...(file.mediaType === undefined ? {} : { mimeType: file.mediaType }),
      ...(file.sizeBytes === undefined ? {} : { size: file.sizeBytes }),
      ...(details.length > 0 ? { description: details.join(", ") } : {})
    }
  })

export const runTurn = (input: TurnInput): Effect.Effect<TurnResult, CapyError, CapyClient> =>
  Effect.gen(function*() {
    const capy = yield* CapyClient
    const tracker = input.changes
    // Before the message goes out, so the user's own uncommitted edits are not credited to Capy.
    if (tracker !== undefined) yield* tracker.baseline

    let threadId = input.threadId
    const attachments = input.files ?? []
    // Thread create takes text only. Files sent right after it race the agent's first step (a
    // fast model answers "no image came through"), so the first message names copies saved on
    // this machine instead, which is where the device agent runs and can read them. Follow-ups
    // upload first, so a failed upload sends nothing.
    const prepare = threadId === undefined
      ? (attachments.length === 0 ? Effect.succeed([]) : saveAttachments(input.attachmentsDir, attachments)).pipe(
        Effect.map((saved) => ({ saved, uploaded: [] as ReadonlyArray<MessageFile> }))
      )
      : capy.uploadFiles(attachments).pipe(Effect.map((uploaded) => ({ saved: [] as ReadonlyArray<string>, uploaded })))
    // Uploads can take a while. A cancel before the message goes out sends nothing. The send itself
    // is not raced: a request Capy may already have accepted is followed through and interrupted.
    const prepared = yield* Effect.raceFirst(prepare.pipe(Effect.map(Option.some)), input.cancelled.pipe(Effect.as(Option.none())))
    if (Option.isNone(prepared)) return { threadId, cursor: input.cursor, stopReason: "cancelled" as const }
    const { saved, uploaded } = prepared.value

    if (threadId === undefined) {
      const text = [input.text, savedNote(saved)].filter((part) => part !== "").join("\n\n")
      const thread = yield* capy.createThread({
        requestId: randomUUID(),
        projectId: input.target.projectId,
        title: titleOf(input.text !== "" ? input.text : attachments.map((f) => f.name).join(", ")),
        message: text,
        model: input.model,
        device: { deviceId: input.target.deviceId, workspace: input.target.workspace }
      })
      threadId = thread.id
    } else {
      const text = input.text !== "" ? input.text : attachedLabel(uploaded)
      yield* capy.sendMessage(threadId, { text, clientKey: randomUUID(), model: input.model, ...(uploaded.length > 0 ? { files: uploaded } : {}) })
    }
    const id = threadId

    let state: TurnState = initialTurn(input.cursor)
    let waitingSince: number | undefined
    let idleRechecks = 0
    /** Stream events seen this turn (heartbeats aside): tells a productive read from an empty one. */
    let received = 0
    /** Failed reads or status checks in a row; any event resets it. */
    let failures = 0
    /** Reads in a row that closed without an event while the thread was still busy. */
    let emptyReads = 0
    /** Why the turn gave up on the connection, for the closing note. */
    let lost: CapyError | undefined
    /** Set once the client cancels; the loop keeps reading until the thread settles. */
    let cancelRequested = false

    /**
     * Shows changes on the tool call that made them. Each call is credited once, when it closes (or at the
     * end of the turn if it never did), so its content is never replaced. Changes with no call to credit
     * (`undefined`) get an item of their own that says they came from outside Capy's tool calls.
     */
    const showChanges = (toolCallId: string | undefined, changes: ReadonlyArray<FileChange>, status: "completed" | "failed") => {
      if (changes.length === 0) return Effect.void
      return toolCallId === undefined
        ? input.emit(fileChangeUpdate(`capy-acp-changes-${randomUUID()}`, changes, { outside: true }))
        : input.emit(fileChangeUpdate(toolCallId, changes, { status }))
    }

    const apply = (event: Parameters<typeof step>[1]): Effect.Effect<TurnSignal | undefined> =>
      Effect.gen(function*() {
        if (event._tag !== "Heartbeat") received++
        const before = state.cursor
        const running = [...state.tools.values()].some((tool) => !tool.done)
        const result = step(cancelRequested ? { ...state, cancelled: true } : state, event)
        state = result.state
        const updates = result.updates
        // A call starts while none runs: the changes since the last look were not made by a Capy tool call.
        const starts = updates.some((u) => u.sessionUpdate === "tool_call" && u.status === "in_progress")
        if (starts && !running && tracker !== undefined) yield* showChanges(undefined, yield* tracker.collect, "completed")
        yield* Effect.forEach(updates, input.emit, { discard: true })
        for (const file of result.files ?? []) {
          yield* input.emit({ sessionUpdate: "agent_message_chunk", content: yield* fileLink(capy, id, file) })
        }
        if (state.cursor !== undefined && state.cursor !== before && input.onCursor !== undefined) {
          yield* input.onCursor(id, state.cursor)
        }
        const last = closedTools(updates).at(-1)
        if (last !== undefined && tracker !== undefined) {
          // The call just finished, so whatever changed on disk since the last look is its doing, unless it cannot write.
          yield* showChanges(READ_ONLY.has(last.kind) ? undefined : last.toolCallId, yield* tracker.collect, last.status)
        }
        return result.signal
      })

    // Reads one stream connection; resolves with the signal that ended it, if any.
    // An `until=run` connection is read until the server closes it, even after `Ended`: entries
    // that streamed no fragments commit after `idle`, and the server sends them before `done`.
    // Should it not close, the next frame (a heartbeat comes every 15 s) after a grace ends it.
    const readOnce = (follow: boolean): Effect.Effect<TurnSignal | undefined, CapyError> => {
      let last: TurnSignal | undefined
      let endedAt: number | undefined
      const stream = capy.stream(id, { cursor: state.cursor, untilRun: !follow }).pipe(
        Stream.mapEffect(apply),
        Stream.takeUntil((signal) => {
          if (signal !== undefined) last = signal
          if (signal?._tag === "Ended") endedAt ??= Date.now()
          if (signal === undefined || signal._tag === "Waiting") return endedAt !== undefined && Date.now() - endedAt > END_GRACE_MS
          return follow || signal._tag !== "Ended"
        }),
        Stream.runDrain
      )
      if (!follow) return stream.pipe(Effect.map(() => last))
      // While the thread waits, hold a live stream open until it wakes or the waiting limit passes.
      const remaining = Math.max(0, input.waitingLimitMs - (Date.now() - (waitingSince ?? Date.now())))
      return stream.pipe(
        Effect.timeoutOption(Duration.millis(remaining)),
        Effect.map((done) => (Option.isNone(done) ? ({ _tag: "Waiting" } as const) : last))
      )
    }

    /**
     * A failed read or status check. Transient failures (a dropped connection, a 5xx) wait and try
     * again from the cursor, so nothing is shown twice; after too many in a row the turn ends with
     * a note instead of an error, since Capy keeps working either way. Anything else fails the turn.
     */
    const recover = (error: CapyError): Effect.Effect<boolean, CapyError> => {
      // A cursor Capy no longer accepts would fail every read. Reading without one can repeat
      // entries the client already has, which beats a session that can never stream again.
      const badCursor = error._tag === "CapyApiError" && error.status === 400 && /cursor/i.test(error.message)
      if (badCursor && state.cursor !== undefined) {
        state = { ...state, cursor: undefined }
      } else if (!isTransient(error)) {
        return Effect.fail(error)
      }
      if (++failures > MAX_FAILURES) {
        lost = error
        return Effect.succeed(false)
      }
      return Effect.sleep(backoff(failures)).pipe(Effect.as(true))
    }

    const loop: Effect.Effect<Outcome, CapyError> = Effect.gen(function*() {
      for (;;) {
        const follow = state.status === "waiting"
        const seen = received
        const read = yield* Effect.result(readOnce(follow))
        if (received > seen) failures = 0
        if (Result.isFailure(read)) {
          if (!(yield* recover(read.failure))) return "lost"
          continue
        }
        const signal = read.success
        switch (signal?._tag) {
          case "Ended":
            // A live (waiting) connection stops at `idle`; drain the rest with an `until=run` read.
            if (!follow) return "ended"
            state = { ...state, status: "idle" }
            continue
          case "Failed":
            return "failed"
          case "Archived":
            return "archived"
          case "StreamError":
            if (signal.code === "unauthorized" || signal.code === "forbidden") return "failed"
            break
          case "Waiting":
            waitingSince ??= Date.now()
            if (Date.now() - waitingSince >= input.waitingLimitMs) return "waiting-limit"
            break
          default:
            break
        }
        // The connection closed (run ended, `done`, or a drop): ask the thread where it stands.
        const checked = yield* Effect.result(capy.getThread(id))
        if (Result.isFailure(checked)) {
          if (!(yield* recover(checked.failure))) return "lost"
          continue
        }
        const thread = checked.success
        state = { ...state, status: thread.status }
        if (thread.status === "idle") {
          if (state.active && turnComplete(state)) return "ended"
          // Capy never started on the message: tell the user rather than end silently.
          if (++idleRechecks > MAX_IDLE_RECHECKS) return state.active ? "ended" : "not-started"
          // Not picked up yet, or a reply has not committed: read again from the cursor.
          yield* Effect.sleep(Duration.seconds(1))
        } else if (thread.status === "failed") {
          return "failed"
        } else if (thread.status === "archived") {
          return "archived"
        } else {
          if (thread.status === "waiting") {
            waitingSince ??= Date.now()
            if (Date.now() - waitingSince >= input.waitingLimitMs) return "waiting-limit"
          }
          // Still busy, but the stream closed with nothing new (or sent an error frame): don't spin.
          emptyReads = received > seen ? 0 : emptyReads + 1
          if (emptyReads > 0) yield* Effect.sleep(backoff(Math.min(emptyReads, 4)))
        }
      }
    })

    // Cancel = interrupt the Capy thread and let the one running loop settle, so the cursor stays right.
    // If the thread does not settle within the grace period, the loop is abandoned.
    const cancel = input.cancelled.pipe(
      Effect.tap(() => Effect.sync(() => (cancelRequested = true))),
      Effect.andThen(capy.interrupt(id).pipe(Effect.ignore)),
      Effect.andThen(Effect.sleep(CANCEL_GRACE)),
      Effect.as("cancelled" as const)
    )

    // A failure after the message went out is reported in the reply, not as a request error: Capy
    // has the message and keeps working, and an error invites a resend that would duplicate it.
    const raced = yield* Effect.result(Effect.raceFirst(loop, cancel))
    if (Result.isFailure(raced)) lost = raced.failure
    const outcome: Outcome = cancelRequested ? "cancelled" : Result.isSuccess(raced) ? raced.success : "lost"

    const closeAs = outcome === "ended" || outcome === "waiting-limit" ? "completed" : "failed"
    const closed = finishTools(state, closeAs)
    state = closed.state
    yield* Effect.forEach(closed.updates, input.emit, { discard: true })
    // A last look catches edits from a call that never reported completing (interrupts, a final
    // entry that lagged). With no call left open, the edits came after the last call finished.
    if (tracker !== undefined) {
      const stillOpen = closedTools(closed.updates).at(-1)?.toolCallId
      yield* showChanges(stillOpen, yield* tracker.collect, closeAs)
    }
    if (outcome === "failed") yield* input.emit(chunk("\n\nCapy reported that this run failed. The thread keeps its transcript; send another message to retry."))
    if (outcome === "archived") yield* input.emit(chunk("\n\nThe Capy thread was archived. Start a new session to continue."))
    if (outcome === "lost") {
      yield* input.emit(
        chunk(
          `\n\nLost the connection to Capy (${lost === undefined ? "unknown error" : describeError(lost)}). Capy may still be working in its ` +
            "thread; your next message here continues from where this reply stopped."
        )
      )
    }
    if (outcome === "not-started") {
      yield* input.emit(
        chunk(
          "Capy has not started on this message yet. Make sure that the Capy desktop app or `capy dock` runs on this machine " +
            "and is signed in. The message stays in the thread queue."
        )
      )
    }
    if (outcome === "waiting-limit") {
      yield* input.emit(
        chunk("\n\nCapy is still waiting on a background command or event. It will continue in its thread on its own; send a message here to check on it.")
      )
    }
    return { threadId: id, cursor: state.cursor, stopReason: outcome === "cancelled" ? "cancelled" : "end_turn" }
  })
