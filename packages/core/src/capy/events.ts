/**
 * Capy thread-stream events (`GET /threads/{id}/stream`), decoded from SSE frames.
 *
 * Event names this adapter does not know decode to `Unknown`, as Capy's docs ask: the
 * vocabulary grows over time. A known event whose payload fails to decode also becomes
 * `Unknown`, so one malformed frame never kills a session.
 */
import { Option, Schema } from "effect"
import type { SseFrame } from "../sse.js"

export const ThreadStatus = Schema.Literals(["working", "waiting", "idle", "failed", "archived"])
export type ThreadStatus = typeof ThreadStatus.Type

/** One transcript entry, the same shape `GET /threads/{id}/messages` pages. */
export interface Message {
  readonly id: string
  readonly source: "user" | "assistant" | "tool"
  readonly text?: string
  readonly tool?: string
  readonly callId?: string
  readonly calls?: ReadonlyArray<{ readonly tool: string; readonly durationMs?: number }>
  readonly model?: string
  readonly clientKey?: string
  readonly createdAt?: string
  /** Decoded item by item (see `messageFiles`), so one odd attachment never drops the whole entry. */
  readonly attachments?: ReadonlyArray<unknown>
}

const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

// The message list sends `null` for absent fields (`clientKey: null`) where the stream omits them,
// and documents `durationMs` as a number or "Infinity". Only id and source are strict.
const RawMessage = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["user", "assistant", "tool"]),
  text: nullable(Schema.String),
  tool: nullable(Schema.String),
  callId: nullable(Schema.String),
  calls: nullable(Schema.Array(Schema.Struct({ tool: Schema.String, durationMs: nullable(Schema.Unknown) }))),
  model: nullable(Schema.String),
  clientKey: nullable(Schema.String),
  createdAt: nullable(Schema.String),
  attachments: nullable(Schema.Array(Schema.Unknown))
})

const present = <A>(key: string, value: A | null | undefined) => (value === null || value === undefined ? {} : { [key]: value })

export const decodeMessage = (data: unknown): Option.Option<Message> =>
  Option.map(Schema.decodeUnknownOption(RawMessage)(data), (raw) => ({
    id: raw.id,
    source: raw.source,
    ...present("text", raw.text),
    ...present("tool", raw.tool),
    ...present("callId", raw.callId),
    ...present(
      "calls",
      raw.calls?.map((call) => ({
        tool: call.tool,
        ...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs) ? { durationMs: call.durationMs } : {})
      }))
    ),
    ...present("model", raw.model),
    ...present("clientKey", raw.clientKey),
    ...present("createdAt", raw.createdAt),
    ...present("attachments", raw.attachments)
  }))

/** A file a transcript entry carries: on assistant entries, a file the agent delivered. */
export interface MessageAttachment {
  readonly fileId: string
  readonly name: string
  readonly mediaType: string | undefined
  readonly sizeBytes: number | undefined
  /** Where the file came from on the agent's machine, when Capy knows. */
  readonly sourcePath: string | undefined
  readonly title: string | undefined
}

const Attachment = Schema.Struct({
  file: Schema.Struct({
    fileId: Schema.String,
    name: Schema.String,
    mediaType: Schema.optionalKey(Schema.NullOr(Schema.String)),
    sizeBytes: Schema.optionalKey(Schema.Unknown),
    sourcePath: Schema.optionalKey(Schema.NullOr(Schema.String))
  }),
  title: Schema.optionalKey(Schema.NullOr(Schema.String))
})

export const messageFiles = (message: Message): ReadonlyArray<MessageAttachment> =>
  (message.attachments ?? []).flatMap((item) =>
    Option.match(Schema.decodeUnknownOption(Attachment)(item), {
      onNone: () => [],
      onSome: ({ file, title }) => [{
        fileId: file.fileId,
        name: file.name,
        mediaType: file.mediaType ?? undefined,
        sizeBytes: typeof file.sizeBytes === "number" && Number.isFinite(file.sizeBytes) ? file.sizeBytes : undefined,
        sourcePath: file.sourcePath ?? undefined,
        title: title ?? undefined
      }]
    })
  )

const payloads = {
  status: Schema.Struct({ status: ThreadStatus }),
  run: Schema.Struct({ phase: Schema.Literals(["start", "end"]) }),
  turn: Schema.Struct({
    phase: Schema.Literals(["start", "end"]),
    outcome: Schema.optionalKey(Schema.String)
  }),
  assistant: Schema.Struct({ callId: Schema.String, text: Schema.String }),
  tool_call: Schema.Struct({ callId: Schema.String, name: Schema.String, text: Schema.optionalKey(Schema.String) }),
  error: Schema.Struct({ code: Schema.String, message: Schema.optionalKey(Schema.String) }),
  // Subagent lifecycle. Thread streams send `task` frames unless opened with `frames=subagent`.
  task: Schema.Struct({ taskId: Schema.String, taskPath: Schema.optionalKey(Schema.NullOr(Schema.String)), status: Schema.String }),
  subagent: Schema.Struct({ subagentId: Schema.String, subagentPath: Schema.optionalKey(Schema.NullOr(Schema.String)), status: Schema.String })
} as const

export type CapyEvent =
  | { readonly _tag: "Status"; readonly status: ThreadStatus }
  | { readonly _tag: "Transcript"; readonly cursor: string | undefined; readonly message: Message }
  | { readonly _tag: "Run"; readonly phase: "start" | "end" }
  | { readonly _tag: "Turn"; readonly phase: "start" | "end"; readonly outcome: string | undefined }
  | { readonly _tag: "Assistant"; readonly callId: string; readonly text: string }
  | { readonly _tag: "ToolCall"; readonly callId: string; readonly name: string; readonly text: string }
  | { readonly _tag: "StreamError"; readonly code: string; readonly message: string }
  /** A subagent under the thread was created or changed status (`draft`, `working`, `waiting`, `idle`, `done`, `failed`). */
  | { readonly _tag: "Subagent"; readonly id: string; readonly path: string | undefined; readonly status: string }
  | { readonly _tag: "Done" }
  | { readonly _tag: "Heartbeat" }
  | { readonly _tag: "Unknown"; readonly event: string }

const decode = <S extends Schema.Decoder<unknown>>(schema: S, data: unknown): Option.Option<S["Type"]> =>
  Schema.decodeUnknownOption(schema)(data)

export const decodeEvent = (frame: SseFrame): CapyEvent => {
  const unknown: CapyEvent = { _tag: "Unknown", event: frame.event }
  let data: unknown
  try {
    data = JSON.parse(frame.data)
  } catch {
    return unknown
  }
  switch (frame.event) {
    case "status":
      return Option.match(decode(payloads.status, data), {
        onNone: () => unknown,
        onSome: ({ status }) => ({ _tag: "Status", status })
      })
    case "transcript":
      return Option.match(decodeMessage(data), {
        onNone: () => unknown,
        onSome: (message) => ({ _tag: "Transcript", cursor: frame.id, message })
      })
    case "run":
      return Option.match(decode(payloads.run, data), {
        onNone: () => unknown,
        onSome: ({ phase }) => ({ _tag: "Run", phase })
      })
    case "turn":
      return Option.match(decode(payloads.turn, data), {
        onNone: () => unknown,
        onSome: (turn) => ({ _tag: "Turn", phase: turn.phase, outcome: turn.outcome })
      })
    case "assistant":
      return Option.match(decode(payloads.assistant, data), {
        onNone: () => unknown,
        onSome: ({ callId, text }) => ({ _tag: "Assistant", callId, text })
      })
    case "tool_call":
      return Option.match(decode(payloads.tool_call, data), {
        onNone: () => unknown,
        onSome: (call) => ({ _tag: "ToolCall", callId: call.callId, name: call.name, text: call.text ?? "" })
      })
    case "error":
      return Option.match(decode(payloads.error, data), {
        onNone: () => ({ _tag: "StreamError", code: "internal", message: frame.data }),
        onSome: (error) => ({ _tag: "StreamError", code: error.code, message: error.message ?? error.code })
      })
    case "task":
      return Option.match(decode(payloads.task, data), {
        onNone: () => unknown,
        onSome: (task) => ({ _tag: "Subagent", id: task.taskId, path: task.taskPath ?? undefined, status: task.status })
      })
    case "subagent":
      return Option.match(decode(payloads.subagent, data), {
        onNone: () => unknown,
        onSome: (sub) => ({ _tag: "Subagent", id: sub.subagentId, path: sub.subagentPath ?? undefined, status: sub.status })
      })
    case "done":
      return { _tag: "Done" }
    case "heartbeat":
      return { _tag: "Heartbeat" }
    default:
      return unknown
  }
}
