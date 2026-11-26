/**
 * Translates one prompt turn's Capy stream events into ACP `session/update` payloads.
 *
 * Pure and synchronous so recorded streams replay deterministically in tests. Rules come from
 * the spike recordings (see docs/capy-api-notes.md):
 * - The turn is driven by `status` and `transcript` frames. `run`/`turn` framing is unreliable
 *   at stream start (stray aborted turns, missing or late `run start`), so it is ignored.
 * - Live `assistant` fragments stream as message chunks. A committed assistant entry only adds
 *   text the fragments missed (fast finishes, resumed streams, dropped frames).
 * - Capy commits the final reply's transcript entry after the `idle` status, so `Ended` waits for
 *   every streamed reply to commit; otherwise the next turn's resume cursor would replay it. A reply
 *   that streamed no fragments (a `dropped` turn) can still commit after `Ended`: the runner keeps
 *   reading until the server closes the stream (see turn.ts).
 * - Strong models report every tool as `execute` with empty text; the committed tool entry's
 *   `calls` list names the inner tools, so the title is upgraded when it lands. An `execute` entry
 *   without that list is a call an interrupt stopped (see `toolStatus`).
 * - Capy never sends a tool's command line, file paths or output. Kinds that promise those
 *   (`execute`, `edit`) are therefore not used for Capy's own frames: clients render them as an
 *   empty command or a nameless file. File edits are reported by `fileChangeUpdate` instead, from
 *   changes the adapter observes on disk (see changes.ts).
 */
import type { SessionUpdate, ToolCallContent, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk"
import { type CapyEvent, type Message, type MessageAttachment, messageFiles, type ThreadStatus } from "./capy/events.js"

/** A file that changed on disk during a turn (see changes.ts in the ACP adapter). */
export interface FileChange {
  /** Absolute path. */
  readonly path: string
  /** Path relative to the folder root, for titles. */
  readonly relativePath: string
  readonly operation: "add" | "modify" | "delete"
  /** Text before the change; absent for added files and for files that cannot be previewed. */
  readonly oldText?: string
  /** Text after the change; absent for deleted files and for files that cannot be previewed. */
  readonly newText?: string
  /** False for binary or very large files: clients get the path but no diff. */
  readonly previewable: boolean
}

export type TurnSignal =
  | { readonly _tag: "Ended" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Archived" }
  | { readonly _tag: "StreamDone" }
  | { readonly _tag: "StreamError"; readonly code: string; readonly message: string }

interface ToolState {
  readonly title: string
  readonly kind: ToolKind
  readonly done: boolean
  /** Subagents only: the status last shown, and whether it was ever seen running. */
  readonly shown?: string
  readonly ran?: boolean
}

export interface TurnState {
  /** Last transcript cursor seen; the next stream resumes after it. */
  readonly cursor: string | undefined
  readonly status: ThreadStatus | undefined
  /** True once the agent has demonstrably picked up this turn's message. */
  readonly active: boolean
  readonly assistant: ReadonlyMap<string, string>
  /** Assistant callIds whose transcript entry has committed. */
  readonly settled: ReadonlySet<string>
  /** Saw `idle` while a streamed reply had not committed yet; end once it does. */
  readonly endPending: boolean
  readonly lastAssistantCallId: string | undefined
  readonly tools: ReadonlyMap<string, ToolState>
  /** The client cancelled the prompt. */
  readonly cancelled: boolean
}

export interface Step {
  readonly state: TurnState
  readonly updates: ReadonlyArray<SessionUpdate>
  readonly signal?: TurnSignal
  /** Files the agent delivered with a reply. Linking them needs I/O, so the runner emits them. */
  readonly files?: ReadonlyArray<MessageAttachment>
}

export const initialTurn = (cursor: string | undefined): TurnState => ({
  cursor,
  status: undefined,
  active: false,
  assistant: new Map(),
  settled: new Set(),
  endPending: false,
  lastAssistantCallId: undefined,
  tools: new Map(),
  cancelled: false
})

const READ_TOOLS = new Set(["read", "view", "cat", "open"])
const SEARCH_TOOLS = new Set(["grep", "glob", "search", "find", "ls", "list"])
const FETCH_TOOLS = new Set(["fetch", "web_fetch", "web_search", "browse"])

/**
 * The ACP kind for a Capy tool call, from the inner tools it ran. Shell and write tools map to
 * `other`, because Capy gives no command or path to fill `execute` and `edit` items with.
 */
export const toolKind = (names: ReadonlyArray<string>): ToolKind => {
  const lower = names.map((name) => name.toLowerCase())
  if (lower.length > 0 && lower.every((name) => READ_TOOLS.has(name))) return "read"
  if (lower.length > 0 && lower.every((name) => SEARCH_TOOLS.has(name) || READ_TOOLS.has(name))) return "search"
  if (lower.length > 0 && lower.every((name) => FETCH_TOOLS.has(name))) return "fetch"
  if (lower.length > 0 && lower.every((name) => name === "think")) return "think"
  return "other"
}

/**
 * How a committed tool entry ended. Each `execute` call that ran to its end lists its inner tools with
 * their durations, and Capy commits a call that an interrupt stopped with no `calls` list at all (seen
 * in every cancelled test turn). An entry that names its tool directly (Haiku's `bash`) never lists
 * inner tools, so after a cancel its outcome is unknown, and it shows as failed rather than finished.
 */
export const toolStatus = (message: Message, cancelled: boolean): "completed" | "failed" => {
  if ((message.calls?.length ?? 0) > 0) return "completed"
  if (message.tool === "execute") return "failed"
  return cancelled ? "failed" : "completed"
}

const formatSeconds = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`)

/** Title for a committed tool entry: its summary when it has one, else the inner tools it ran. */
export const toolTitle = (message: Message): string => {
  const summary = message.text?.trim() ?? ""
  if (summary !== "") return summary
  const calls = message.calls ?? []
  if (calls.length === 0) return message.tool === "execute" ? "Stopped tool call" : (message.tool ?? "Tool call")
  const names = [...new Set(calls.map((call) => call.tool))].join(", ")
  const total = calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0)
  return total > 0 ? `${names} (${formatSeconds(total)})` : names
}

const liveTitle = (name: string, text: string): string => {
  const summary = text.trim()
  if (summary !== "") return summary
  return name === "execute" ? "Running tools" : name
}

const chunk = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text }
})

/** Emits assistant text, separating consecutive replies (Astra sends interim messages). */
const emitAssistant = (state: TurnState, callId: string, text: string): Step => {
  if (text === "") return { state, updates: [] }
  const previous = state.assistant.get(callId) ?? ""
  const separate = previous === "" && state.lastAssistantCallId !== undefined && state.lastAssistantCallId !== callId
  const assistant = new Map(state.assistant).set(callId, previous + text)
  return {
    state: { ...state, active: true, assistant, lastAssistantCallId: callId },
    updates: [chunk(separate ? `\n\n${text}` : text)]
  }
}

const unsettled = (state: TurnState) => [...state.assistant.keys()].filter((id) => !state.settled.has(id)).length

/** Every reply that streamed has committed. */
export const turnComplete = (state: TurnState) => unsettled(state) === 0

const endIfComplete = (step: Step): Step =>
  step.state.endPending && turnComplete(step.state)
    ? { ...step, state: { ...step.state, endPending: false }, signal: { _tag: "Ended" } }
    : step

const onTranscript = (state: TurnState, cursor: string | undefined, message: Message): Step => {
  const base: TurnState = { ...state, cursor: cursor ?? state.cursor }
  switch (message.source) {
    case "user":
      // Our own message committing proves the agent picked the turn up.
      return { state: { ...base, active: true }, updates: [] }
    case "assistant": {
      const callId = message.callId ?? message.id
      const text = message.text ?? ""
      // A resumed stream can deliver a settled entry again; its files were already shown.
      const files = base.settled.has(callId) ? [] : messageFiles(message)
      const streamed = base.assistant.get(callId) ?? ""
      // If the committed text diverged from the fragments, keep what streamed: chunks cannot be retracted.
      const emitted = text.startsWith(streamed)
        ? emitAssistant(base, callId, text.slice(streamed.length))
        : { state: { ...base, active: true }, updates: [] }
      const state: TurnState = {
        ...emitted.state,
        assistant: new Map(emitted.state.assistant).set(callId, emitted.state.assistant.get(callId) ?? text),
        settled: new Set(emitted.state.settled).add(callId)
      }
      return endIfComplete({ state, updates: emitted.updates, ...(files.length > 0 ? { files } : {}) })
    }
    case "tool": {
      const known = base.tools.get(message.id)
      // Report a tool's completion once. A resumed stream can deliver its entry again, and a repeat
      // would replace the file diffs the runner attached to it.
      if (known?.done === true) return { state: { ...base, active: true }, updates: [] }
      const names = message.calls?.map((call) => call.tool) ?? (message.tool === undefined ? [] : [message.tool])
      const title = toolTitle(message)
      const kind = toolKind(names.length > 0 ? names : [message.tool ?? ""])
      const status = toolStatus(message, base.cancelled)
      const tools = new Map(base.tools).set(message.id, { title, kind, done: true })
      const next: TurnState = { ...base, active: true, tools }
      const fields = { toolCallId: message.id, title, kind, status }
      return {
        state: next,
        updates: [known === undefined ? { sessionUpdate: "tool_call", ...fields } : { sessionUpdate: "tool_call_update", ...fields }]
      }
    }
  }
}

/** Subagent ids are prefixed so they can never collide with Capy's own tool call ids. */
export const subagentCallId = (id: string) => `capy-subagent-${id}`

const SUBAGENT_STATUS: Record<string, "pending" | "in_progress" | "completed" | "failed"> = {
  draft: "pending",
  working: "in_progress",
  waiting: "in_progress",
  idle: "completed",
  done: "completed",
  failed: "failed"
}

/** A subagent shows as one tool call that follows its lifecycle. */
const onSubagent = (state: TurnState, event: Extract<CapyEvent, { _tag: "Subagent" }>): Step => {
  const toolCallId = subagentCallId(event.id)
  const known = state.tools.get(toolCallId)
  const mapped = SUBAGENT_STATUS[event.status] ?? "in_progress"
  const ran = known?.ran === true || mapped === "in_progress"
  // `idle` means at rest: a new subagent is idle before it starts (seen live), so only one that ran has finished.
  const status = event.status === "idle" && !ran ? "pending" : mapped
  const done = status === "completed" || status === "failed"
  if ((known?.done === true && done) || known?.shown === status) return { state, updates: [] }
  const title = `Subagent ${event.path ?? event.id}`
  const tools = new Map(state.tools).set(toolCallId, { title, kind: "other" as const, done, shown: status, ran })
  const update: SessionUpdate = known === undefined
    ? { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status }
    : { sessionUpdate: "tool_call_update", toolCallId, status }
  return { state: { ...state, tools }, updates: [update] }
}

export const step = (state: TurnState, event: CapyEvent): Step => {
  switch (event._tag) {
    case "Assistant":
      return emitAssistant(state, event.callId, event.text)
    case "ToolCall": {
      if (state.tools.has(event.callId)) return { state, updates: [] }
      const title = liveTitle(event.name, event.text)
      const kind = toolKind([event.name])
      return {
        state: { ...state, active: true, tools: new Map(state.tools).set(event.callId, { title, kind, done: false }) },
        updates: [{ sessionUpdate: "tool_call", toolCallId: event.callId, title, kind, status: "in_progress" }]
      }
    }
    case "Transcript":
      return onTranscript(state, event.cursor, event.message)
    case "Status": {
      const next: TurnState = { ...state, status: event.status, active: state.active || event.status === "working" }
      // The first status frame on a fresh connection can still read `idle` before the agent picks up
      // the message, so idle/failed end the turn only after the turn became active.
      if (event.status === "idle" && next.active) {
        return turnComplete(next)
          ? { state: next, updates: [], signal: { _tag: "Ended" } }
          : { state: { ...next, endPending: true }, updates: [] }
      }
      if (event.status === "failed" && next.active) return { state: next, updates: [], signal: { _tag: "Failed" } }
      if (event.status === "waiting" && next.active) return { state: next, updates: [], signal: { _tag: "Waiting" } }
      if (event.status === "archived") return { state: next, updates: [], signal: { _tag: "Archived" } }
      return { state: next, updates: [] }
    }
    case "Subagent":
      return onSubagent(state, event)
    case "StreamError":
      return { state, updates: [], signal: { _tag: "StreamError", code: event.code, message: event.message } }
    case "Done":
      return { state, updates: [], signal: { _tag: "StreamDone" } }
    case "Run":
    case "Turn":
    case "Heartbeat":
    case "Unknown":
      return { state, updates: [] }
  }
}

const MAX_TITLE_FILES = 3

/** "Edited README.md and docs/SPIKE.md", "Created a.ts, b.ts and 2 more files". */
export const changeTitle = (changes: ReadonlyArray<FileChange>): string => {
  const verb = changes.every((c) => c.operation === "add")
    ? "Created"
    : changes.every((c) => c.operation === "delete")
      ? "Deleted"
      : "Edited"
  const names = changes.map((c) => c.relativePath)
  if (names.length <= MAX_TITLE_FILES) {
    return `${verb} ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`
  }
  const rest = names.length - (MAX_TITLE_FILES - 1)
  return `${verb} ${names.slice(0, MAX_TITLE_FILES - 1).join(", ")} and ${rest} more files`
}

/**
 * The ACP update that shows a tool call's file changes as diffs. `status` keeps a call that was closed
 * as failed (cancelled, failed run) from reading as completed. With `outside`, it opens an item of its
 * own for changes that no Capy tool call made: they happened while no call that can write ran, so
 * they are the user's, or a background command's. Its kind is `other`, so that clients show the title,
 * which says so, and not a plain "changed files".
 */
export const fileChangeUpdate = (
  toolCallId: string,
  changes: ReadonlyArray<FileChange>,
  options: { readonly outside?: boolean; readonly status?: "completed" | "failed" } = {}
): SessionUpdate => {
  const content: Array<ToolCallContent> = changes.flatMap((change) =>
    change.previewable
      ? [{
          type: "diff" as const,
          path: change.path,
          ...(change.oldText === undefined ? {} : { oldText: change.oldText }),
          newText: change.newText ?? ""
        }]
      : []
  )
  const locations = changes.map((change) => ({ path: change.path }))
  if (options.outside === true) {
    const title = `${changeTitle(changes)} outside a Capy tool call`
    return { sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "completed", content, locations }
  }
  return {
    sessionUpdate: "tool_call_update",
    toolCallId,
    title: changeTitle(changes),
    kind: changes.every((c) => c.operation === "delete") ? "delete" : "edit",
    status: options.status ?? "completed",
    content,
    locations
  }
}

export interface ClosedTool {
  readonly toolCallId: string
  readonly status: Extract<ToolCallStatus, "completed" | "failed">
  /** Set when the update names it; subagent updates carry the status only. */
  readonly kind: ToolKind | undefined
}

/** The tool calls an update set closes, in order. */
export const closedTools = (updates: ReadonlyArray<SessionUpdate>): ReadonlyArray<ClosedTool> =>
  updates.flatMap((u) =>
    (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && (u.status === "completed" || u.status === "failed")
      ? [{ toolCallId: u.toolCallId, status: u.status, kind: u.kind ?? undefined }]
      : []
  )

/** Closes tool calls still in progress when the turn ends: completed on success, failed otherwise. */
export const finishTools = (state: TurnState, outcome: "completed" | "failed"): Step => {
  const updates: Array<SessionUpdate> = []
  const tools = new Map(state.tools)
  for (const [toolCallId, tool] of state.tools) {
    if (tool.done) continue
    tools.set(toolCallId, { ...tool, done: true })
    updates.push({ sessionUpdate: "tool_call_update", toolCallId, status: outcome })
  }
  return { state: { ...state, tools }, updates }
}

/**
 * A committed transcript as ACP history, for `session/load`: user and assistant text as message
 * chunks, tool entries as completed tool calls. Files are left to the caller, as in a live turn.
 */
export const history = (messages: ReadonlyArray<Message>): ReadonlyArray<{ readonly update: SessionUpdate; readonly files?: ReadonlyArray<MessageAttachment>; readonly source: "user" | "assistant" }> => {
  const out: Array<{ update: SessionUpdate; files?: ReadonlyArray<MessageAttachment>; source: "user" | "assistant" }> = []
  let previous: Message["source"] | undefined
  for (const message of messages) {
    const files = messageFiles(message)
    const withFiles = files.length > 0 ? { files } : {}
    const text = message.text ?? ""
    if (message.source === "tool") {
      const names = message.calls?.map((call) => call.tool) ?? (message.tool === undefined ? [] : [message.tool])
      out.push({
        source: "assistant",
        update: { sessionUpdate: "tool_call", toolCallId: message.id, title: toolTitle(message), kind: toolKind(names), status: toolStatus(message, false) }
      })
    } else if (message.source === "user") {
      out.push({ source: "user", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } }, ...withFiles })
    } else {
      // Consecutive replies with nothing between them read as one message unless separated.
      const separated = previous === "assistant" ? `\n\n${text}` : text
      out.push({ source: "assistant", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: separated } }, ...withFiles })
    }
    previous = message.source
  }
  return out
}

/** Replays a whole recorded stream; used by tests and the replay CLI. */
export const replay = (events: ReadonlyArray<CapyEvent>, cursor?: string) => {
  let state = initialTurn(cursor)
  const updates: Array<SessionUpdate> = []
  const signals: Array<TurnSignal> = []
  for (const event of events) {
    const result = step(state, event)
    state = result.state
    updates.push(...result.updates)
    if (result.signal !== undefined) signals.push(result.signal)
  }
  return { state, updates, signals }
}
