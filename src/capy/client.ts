/**
 * Typed Capy API client (https://docs.capy.ai/api-reference/overview).
 *
 * Every mutating call this adapter makes is idempotent: creates carry a `requestId` and messages
 * a `clientKey`. So all calls retry on rate limits (honoring `retry-after`), on 502/503/504, and on
 * transport failures.
 */
import { readFile } from "node:fs/promises"
import { Context, Data, Duration, Effect, Layer, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import type { AdapterConfig } from "../config.js"
import { makeSseParser } from "../sse.js"
import { type CapyEvent, decodeEvent, decodeMessage, type Message, ThreadStatus } from "./events.js"

/** A tagged JSON error from the API, such as `capy/RateLimited` or `ModelSelection.Rejected`. */
export class CapyApiError extends Data.TaggedError("CapyApiError")<{
  readonly status: number
  readonly tag: string
  readonly message: string
  readonly retryAfterMs: number | undefined
}> {}

export class CapyTransportError extends Data.TaggedError("CapyTransportError")<{
  readonly message: string
  readonly cause?: unknown
  /**
   * Capy answered, but with a body this version cannot read, such as a thread status it does not
   * know yet. Trying again gives the same answer, so it is never retried.
   */
  readonly decode?: boolean
}> {}

/** Something only the user can fix, such as a missing API key. Never retried. */
export class CapyConfigError extends Data.TaggedError("CapyConfigError")<{
  readonly message: string
}> {}

export type CapyError = CapyApiError | CapyTransportError | CapyConfigError

export const isCapyError = (error: unknown): error is CapyError =>
  error instanceof CapyApiError || error instanceof CapyTransportError || error instanceof CapyConfigError

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  billing: Schema.optionalKey(Schema.String),
  route: Schema.optionalKey(Schema.String),
  reasoningModes: Schema.optionalKey(Schema.Array(Schema.String))
})
export type Model = typeof Model.Type

const Project = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  repos: Schema.Array(Schema.Struct({ repoFullName: Schema.String }))
})

const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), cursor: Schema.optionalKey(Schema.NullOr(Schema.String)) })

/** Credits are thousandths of a dollar (see `formatCredits`). */
const Usage = Schema.Struct({
  totalCredits: Schema.Number,
  llmCredits: Schema.optionalKey(Schema.Number),
  imageCredits: Schema.optionalKey(Schema.Number),
  vmCredits: Schema.optionalKey(Schema.Number)
})

const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))

/** Something the thread needs from a person. `kind` is a string, so a new kind never fails the thread. */
const ThreadAsk = Schema.Struct({ kind: Schema.String, text: nullable(Schema.String) })

// Only id and status are required: other fields are read when present, and fields this adapter
// does not use are ignored.
export const Thread = Schema.Struct({
  id: Schema.String,
  status: ThreadStatus,
  usage: Schema.optionalKey(Usage),
  title: nullable(Schema.String),
  projectId: nullable(Schema.String),
  lastModelId: nullable(Schema.String),
  ask: nullable(ThreadAsk),
  needsYou: nullable(Schema.Boolean),
  createdAt: nullable(Schema.String),
  updatedAt: nullable(Schema.String),
  lastActivityAt: nullable(Schema.String)
})
export type Thread = typeof Thread.Type

const Receipt = Schema.Struct({ id: Schema.String })

const UploadTargets = Schema.Struct({
  targets: Schema.Array(Schema.Struct({ fileId: Schema.String, url: Schema.String }))
})

// Items are decoded one by one (`decodeMessage`), so an entry this adapter can't read is skipped.
const MessagePage = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String))
})

const Download = Schema.Struct({ url: Schema.String, expiresAt: Schema.optionalKey(Schema.String) })

/** A file to attach to a message: uploaded through `POST /files`, then referenced by id. */
export interface FileUpload {
  readonly name: string
  readonly mediaType: string
  readonly bytes: Uint8Array
}

export interface MessageFile {
  readonly fileId: string
  readonly name: string
}

export interface ModelSelection {
  readonly modelId: string
  readonly reasoningMode?: string
}

/** Cloud machine sizes, smallest first. Absent from a create, the project's size applies. */
export const MACHINE_SIZES = ["small", "medium", "large", "ultra", "hyper", "bigguy"] as const
export type MachineSize = (typeof MACHINE_SIZES)[number]

/**
 * Where on a device a thread works. A worktree with `repos` needs no local folder: the device makes it
 * from the repository on its own, and `startFromOrigin` starts it from the GitHub remote.
 */
export type DeviceWorkspaceTarget =
  | { readonly kind: "linked"; readonly root: string }
  | { readonly kind: "worktree"; readonly repos?: ReadonlyArray<string>; readonly startFromOrigin?: boolean; readonly root?: string }

export interface CreateThread {
  readonly requestId: string
  readonly projectId: string
  readonly title?: string
  readonly message: string
  readonly model: ModelSelection
  /** Absent, the thread runs on a Capy cloud machine, whose time costs Capy credits. */
  readonly device?: {
    readonly deviceId: string
    readonly workspace: DeviceWorkspaceTarget
  }
  /** Cloud threads only. */
  readonly machineSize?: MachineSize
}

export interface SendMessage {
  readonly text: string
  readonly clientKey: string
  readonly model?: ModelSelection
  readonly delivery?: "interrupt" | "steer" | "queue"
  readonly files?: ReadonlyArray<MessageFile>
}

export class CapyClient extends Context.Service<
  CapyClient,
  {
    readonly listModels: Effect.Effect<ReadonlyArray<Model>, CapyError>
    readonly listProjects: Effect.Effect<ReadonlyArray<typeof Project.Type>, CapyError>
    readonly createThread: (body: CreateThread) => Effect.Effect<Thread, CapyError>
    readonly sendMessage: (threadId: string, body: SendMessage) => Effect.Effect<{ readonly id: string }, CapyError>
    readonly interrupt: (threadId: string) => Effect.Effect<void, CapyError>
    readonly getThread: (threadId: string) => Effect.Effect<Thread, CapyError>
    /** One page of a project's threads, as Capy orders them. */
    readonly listThreads: (projectId: string, options: { readonly limit: number }) => Effect.Effect<ReadonlyArray<Thread>, CapyError>
    /** Uploads files for a message, in order. The bytes go straight to storage through presigned URLs. */
    readonly uploadFiles: (files: ReadonlyArray<FileUpload>) => Effect.Effect<ReadonlyArray<MessageFile>, CapyError>
    /** The whole committed transcript, oldest first. */
    readonly listMessages: (threadId: string) => Effect.Effect<ReadonlyArray<Message>, CapyError>
    /** A short-lived URL for a file attached to the thread's transcript. */
    readonly attachmentUrl: (threadId: string, fileId: string) => Effect.Effect<string, CapyError>
    /** Thread events after `cursor`. With `untilRun`, the server closes the stream when the run ends. */
    readonly stream: (
      threadId: string,
      options: { readonly cursor: string | undefined; readonly untilRun: boolean }
    ) => Stream.Stream<CapyEvent, CapyError>
  }
>()("capy-acp/CapyClient") {}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const MAX_ATTEMPTS = 4
/** A `retry-after` longer than this is not honored: the call fails instead of hanging the prompt. */
const MAX_RETRY_AFTER_MS = 60_000

const retryDelay = (error: CapyError, attempt: number): number | undefined => {
  if (attempt >= MAX_ATTEMPTS) return undefined
  if (error._tag === "CapyTransportError") return error.decode === true ? undefined : 500 * 2 ** attempt
  if (error._tag === "CapyConfigError" || !RETRYABLE_STATUS.has(error.status)) return undefined
  const delay = error.retryAfterMs ?? 1000 * 2 ** attempt
  return delay > MAX_RETRY_AFTER_MS ? undefined : delay
}

/** Network trouble, rate limits and server errors: worth trying again later, unlike a rejected request. */
export const isTransient = (error: CapyError): boolean =>
  (error._tag === "CapyTransportError" && error.decode !== true) || (error._tag === "CapyApiError" && (error.status === 429 || error.status >= 500))

/** One line for the user: Capy's own tag and message when it sent them. */
export const describeError = (error: CapyError): string =>
  error._tag === "CapyApiError" ? `Capy ${error.tag} (${error.status}): ${error.message}` : error.message

export const withRetry = <A>(effect: Effect.Effect<A, CapyError>, attempt = 1): Effect.Effect<A, CapyError> =>
  effect.pipe(
    Effect.catch((error: CapyError) => {
      const delay = retryDelay(error, attempt)
      return delay === undefined
        ? Effect.fail(error)
        : Effect.sleep(Duration.millis(delay)).pipe(Effect.andThen(withRetry(effect, attempt + 1)))
    })
  )

/** Builds a `CapyApiError` from a non-2xx response, reading Capy's `_tag`/`message` and `retry-after`. */
const apiError = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<never, CapyError> =>
  response.json.pipe(
    Effect.orElseSucceed(() => ({})),
    Effect.flatMap((body) => {
      const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
      const header = Number(response.headers["retry-after"])
      const bodySeconds = typeof record.retryAfterSeconds === "number" ? record.retryAfterSeconds : undefined
      const seconds = Number.isFinite(header) ? header : bodySeconds
      return Effect.fail(
        new CapyApiError({
          status: response.status,
          tag: typeof record._tag === "string" ? record._tag : `http/${response.status}`,
          message: typeof record.message === "string" ? record.message : `Capy API answered ${response.status}`,
          retryAfterMs: seconds === undefined ? undefined : seconds * 1000
        })
      )
    })
  )

/**
 * Reads the API key for each request, so adding or rotating the key needs no restart. The read is
 * a small local file (or the environment), far cheaper than the request it authorizes.
 */
const readApiKey = (config: AdapterConfig): Effect.Effect<string, CapyConfigError> => {
  const fromEnv = process.env.CAPY_API_KEY?.trim()
  if (fromEnv) return Effect.succeed(fromEnv)
  return Effect.tryPromise({
    try: async () => (await readFile(config.apiKeyFile, "utf8")).trim(),
    catch: () =>
      new CapyConfigError({
        message: `No Capy API key. Run \`npx -y capy-acp --setup\` in a terminal, or set CAPY_API_KEY, or put the key in ${config.apiKeyFile} (mode 0600).`
      })
  }).pipe(
    Effect.filterOrFail(
      (key) => key.length > 0,
      () => new CapyConfigError({ message: `The Capy API key file ${config.apiKeyFile} is empty.` })
    )
  )
}

export const make = (config: AdapterConfig) =>
  Effect.gen(function*() {
    const base = yield* HttpClient.HttpClient
    const http = base.pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl(config.apiUrl)))
    const authorize = (request: HttpClientRequest.HttpClientRequest) =>
      readApiKey(config).pipe(Effect.map((key) => request.pipe(HttpClientRequest.bearerToken(key))))

    const send = (request: HttpClientRequest.HttpClientRequest) =>
      authorize(request).pipe(
        Effect.flatMap((authorized) =>
          http.execute(authorized).pipe(
            Effect.mapError((cause) => new CapyTransportError({ message: `Capy API request failed: ${cause.message}`, cause }))
          )
        ),
        Effect.flatMap((response) => (response.status >= 200 && response.status < 300 ? Effect.succeed(response) : apiError(response)))
      )

    const json = <S extends Schema.Top & Schema.Decoder<unknown>>(
      schema: S,
      request: HttpClientRequest.HttpClientRequest
    ): Effect.Effect<S["Type"], CapyError> =>
      withRetry(
        send(request.pipe(HttpClientRequest.acceptJson)).pipe(
          Effect.flatMap((response) => response.json),
          Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
          Effect.mapError((error) =>
            error instanceof CapyApiError || error instanceof CapyTransportError || error instanceof CapyConfigError
              ? error
              : new CapyTransportError({
                message: `Unexpected Capy API response: ${String(error)}`,
                cause: error,
                // A body that did not arrive whole is worth another try; one that does not match the schema is not.
                ...(error instanceof Schema.SchemaError ? { decode: true } : {})
              })
          ),
          Effect.timeout(Duration.seconds(30)),
          Effect.catchTag("TimeoutError", () => Effect.fail(new CapyTransportError({ message: "Capy API request timed out" })))
        )
      )

    const listProjects = Effect.gen(function*() {
      const projects: Array<typeof Project.Type> = []
      let cursor: string | null | undefined = undefined
      do {
        const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
        const page: { readonly items: ReadonlyArray<typeof Project.Type>; readonly cursor?: string | null } = yield* json(Page(Project), HttpClientRequest.get(`/projects${query}`))
        projects.push(...page.items)
        cursor = page.cursor
      } while (cursor)
      return projects
    })

    const listMessages = (threadId: string) =>
      Effect.gen(function*() {
        const messages: Array<Message> = []
        let after: string | null | undefined = undefined
        for (;;) {
          const query: string = after ? `?after=${encodeURIComponent(after)}` : ""
          const page: typeof MessagePage.Type = yield* json(MessagePage, HttpClientRequest.get(`/threads/${encodeURIComponent(threadId)}/messages${query}`))
          for (const item of page.items) {
            const message = decodeMessage(item)
            if (message._tag === "Some") messages.push(message.value)
          }
          // A page can be empty; an unchanged cursor means unsettled entries block paging for now.
          if (!page.cursor || page.cursor === after) return messages
          after = page.cursor
        }
      })

    // Presigned PUT: exact Content-Type and Content-Length, and no Authorization header.
    const putBytes = (url: string, file: FileUpload) =>
      withRetry(
        base.execute(HttpClientRequest.put(url).pipe(HttpClientRequest.bodyUint8Array(file.bytes, file.mediaType))).pipe(
          Effect.mapError((cause) => new CapyTransportError({ message: `Uploading ${file.name} failed: ${cause.message}`, cause })),
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.void
              : Effect.fail(
                new CapyApiError({ status: response.status, tag: `upload/${response.status}`, message: `Uploading ${file.name} failed (${response.status})`, retryAfterMs: undefined })
              )
          )
        )
      )

    const uploadFiles = (files: ReadonlyArray<FileUpload>) =>
      Effect.gen(function*() {
        if (files.length === 0) return []
        const { targets } = yield* json(
          UploadTargets,
          HttpClientRequest.post("/files").pipe(
            HttpClientRequest.bodyJsonUnsafe({ files: files.map((f) => ({ name: f.name, mediaType: f.mediaType, sizeBytes: f.bytes.byteLength })) })
          )
        )
        if (targets.length !== files.length) {
          return yield* Effect.fail(new CapyTransportError({ message: `Capy returned ${targets.length} upload targets for ${files.length} files` }))
        }
        yield* Effect.forEach(files, (file, i) => putBytes(targets[i]!.url, file), { concurrency: 4, discard: true })
        return files.map((file, i) => ({ fileId: targets[i]!.fileId, name: file.name }))
      })

    return CapyClient.of({
      listModels: json(Page(Model), HttpClientRequest.get("/models")).pipe(Effect.map((page) => page.items)),
      listProjects,
      createThread: (body) => json(Thread, HttpClientRequest.post("/threads").pipe(HttpClientRequest.bodyJsonUnsafe(body))),
      sendMessage: (threadId, body) =>
        json(
          Receipt,
          HttpClientRequest.post(`/threads/${encodeURIComponent(threadId)}/message`).pipe(HttpClientRequest.bodyJsonUnsafe(body))
        ),
      interrupt: (threadId) =>
        withRetry(send(HttpClientRequest.post(`/threads/${encodeURIComponent(threadId)}/interrupt`))).pipe(Effect.asVoid),
      getThread: (threadId) => json(Thread, HttpClientRequest.get(`/threads/${encodeURIComponent(threadId)}`)),
      listThreads: (projectId, { limit }) =>
        json(Page(Thread), HttpClientRequest.get(`/threads?projectId=${encodeURIComponent(projectId)}&limit=${limit}`)).pipe(
          Effect.map((page) => page.items)
        ),
      uploadFiles,
      listMessages,
      attachmentUrl: (threadId, fileId) =>
        json(
          Download,
          HttpClientRequest.get(`/threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(fileId)}/download`)
        ).pipe(Effect.map((download) => download.url)),
      stream: (threadId, { cursor, untilRun }) =>
        Stream.unwrap(
          withRetry(
            send(
              HttpClientRequest.get(`/threads/${encodeURIComponent(threadId)}/stream${untilRun ? "?until=run" : ""}`).pipe(
                HttpClientRequest.setHeader("accept", "text/event-stream"),
                cursor === undefined ? (request) => request : HttpClientRequest.setHeader("last-event-id", cursor)
              )
            )
          ).pipe(
            Effect.map((response) =>
              response.stream.pipe(
                Stream.mapError((cause) => new CapyTransportError({ message: `Capy stream dropped: ${cause.message}`, cause })),
                Stream.decodeText(),
                Stream.mapAccum(makeSseParser, (parser, text: string) => [parser, parser.push(text)] as const, {
                  onHalt: (parser) => parser.end()
                }),
                Stream.map(decodeEvent)
              )
            )
          )
        )
    })
  })

/** Never fails to build: a missing API key surfaces on the first request, where the user sees it. */
export const layer = (config: AdapterConfig): Layer.Layer<CapyClient> =>
  Layer.effect(CapyClient, make(config)).pipe(Layer.provide(FetchHttpClient.layer))
