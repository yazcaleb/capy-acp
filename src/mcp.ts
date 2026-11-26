/**
 * `capy-acp mcp`: an MCP server on stdio, so a coding agent (Claude Code, Codex, Cursor, ...) can hand
 * work to Capy threads and come back for the result. stdout carries protocol messages only; logs go
 * to stderr.
 *
 * The tools are thin over src/delegate.ts. Each result has a short text for the calling model and the
 * same data as `structuredContent`. A failure is a result with `isError`, the Problem's text and its
 * `nextAction`, never a protocol error, so the calling model reads it and acts on it.
 *
 * The server starts and lists its tools without a Capy API key: the key is read on each request.
 */
import { resolve } from "node:path"
import { Cause, Context, Effect, Exit, Layer, Logger, PlatformError, Predicate, Schema, Sink, Stdio, Stream } from "effect"
import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import { CapyClient, layer as capyLayer, type Model } from "./capy/client.js"
import type { AdapterConfig } from "./config.js"
import {
  type ActionableProblem,
  type Activity,
  DelegateError,
  MACHINE_SIZES,
  makeDelegate,
  type ThreadReport,
  type ThreadRow,
  toProblem
} from "./delegate.js"
import { fetchPrices, modelDescription, type Price } from "./pricing.js"
import type { NextAction } from "./problems.js"
import { AGENT_VERSION } from "./version.js"

export const SERVER_NAME = "capy"

export const INSTRUCTIONS = `Capy runs coding-agent threads on a Capy device (a computer that runs the Capy desktop app or \`capy dock\`) or on a Capy cloud machine. Use these tools to hand work to Capy and to come back for the result.

Delegate to Capy when the work is independent of what you do now, when it is long, when several tasks can run in parallel, when it should end in a pull request, or when it should keep going after this session ends. Do small edits that you need right away yourself.

By default (where "auto"), start_thread runs the task in a new git worktree of the repository on a Capy device. It does not edit your files, so you can keep working in the folder while Capy works. where "here" edits the folder in place: use it only when the person asks for it. where "cloud" runs on a Capy cloud machine, and machine time costs Capy credits: use it only when the person allows it.

After start_thread or send_message, call wait_for_thread with the thread id. Do not call get_thread in a loop. wait_for_thread returns when the run ends, when Capy needs a person, or when its timeout passes. After a timeout the thread keeps running, so call wait_for_thread again. When a result has needsYou true or asks, ask the person and pass the answer to send_message.

Every error result has a nextAction: run_command (run that exact command), ask_human (ask the person exactly that), retry (wait afterMs milliseconds, then call again), or use_option (call again with another value for that option).`

const WHERE_CHOICES = ["auto", "worktree", "here", "cloud"] as const

const described = <S extends Schema.Top>(schema: S, description: string) => schema.annotate({ description })
const optional = <S extends Schema.Top>(schema: S, description: string) => Schema.optionalKey(described(schema, description))
const Text = Schema.String.check(Schema.isMinLength(1))
const ThreadId = described(Text, "The thread id that start_thread or list_threads returned, such as jam_01K...")

const StartInput = Schema.Struct({
  task: described(
    Text,
    "What Capy should do, written as for a capable engineer: the goal, where in the code, and how to check the result. Say whether Capy should open a pull request."
  ),
  folder: optional(
    Text,
    "The absolute path of a folder in the git repository to work on. Default: this MCP server's working folder, which is often not your repository, so pass it whenever you work in a repository."
  ),
  where: optional(
    Schema.Literals(WHERE_CHOICES),
    'Where Capy runs. "auto" (default) and "worktree": a new git worktree on a Capy device, which never edits your folder. "here": edits the folder in place, only when the person asks. "cloud": a Capy cloud machine, whose time costs Capy credits, only when the person allows it.'
  ),
  project: optional(Text, "A Capy project id or exact name. Default: the project of the folder's GitHub remote."),
  repo: optional(Text, 'A repository "owner/name", for a worktree on a Capy device on another computer. Default: the folder\'s repository, else the project\'s only one.'),
  device: optional(Text, "A Capy device id, to run on a Capy device on another computer. Default: CAPY_DEVICE_ID, else this computer's device."),
  machineSize: optional(
    Schema.Literals(MACHINE_SIZES),
    'Cloud machine size, for where "cloud" only. Default: the project\'s machine size. Bigger machines cost more credits.'
  ),
  model: optional(Text, "A model id from list_models. Default: CAPY_ACP_MODEL, else anthropic/claude-opus-5-5."),
  reasoning: optional(Text, "A reasoning mode of the model, such as low, medium or high (see list_models). Default: high, or the model's highest."),
  title: optional(Text, "The thread title. Default: the start of the task.")
})

const WaitInput = Schema.Struct({
  threadId: ThreadId,
  timeoutSeconds: optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600 })),
    "How long to wait before returning with timedOut true, from 1 to 600. Default: 120. The thread keeps running after the timeout."
  )
})

const ThreadInput = Schema.Struct({ threadId: ThreadId })

const SendInput = Schema.Struct({
  threadId: ThreadId,
  text: described(Text, "The message: an answer to Capy's question, or follow-up work."),
  interrupt: optional(Schema.Boolean, "true stops the current run and starts on this message now. Default: false, the message waits until the current run ends.")
})

const ListInput = Schema.Struct({
  project: optional(Text, "Only threads of this Capy project (id or exact name)."),
  folder: optional(Text, "Only threads of the Capy project of this folder's repository."),
  limit: optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })), "How many threads, from 1 to 100. Default: 20.")
})

const NoInput = Schema.Struct({})

/** A tool result's text for the calling model, and the same data for `structuredContent`. */
interface Answer {
  readonly text: string
  readonly structured: object
}

interface Hints {
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotent: boolean
}

const inputSchemaOf = (schema: Schema.Top): McpSchema.Tool["inputSchema"] => {
  const { additionalProperties: _, ...json } = Schema.toJsonSchemaDocument(schema).schema as Record<string, unknown>
  // An empty struct compiles to "any value but null"; MCP wants an object.
  return (json.type === "object" ? json : { type: "object", properties: {} }) as McpSchema.Tool["inputSchema"]
}

const nextActionText = (next: NextAction): string => {
  switch (next.kind) {
    case "run_command":
      return `Run \`${next.command}\`.`
    case "ask_human":
      return next.say
    case "retry":
      return `Try again in ${Math.ceil(next.afterMs / 1000)} seconds.`
    case "use_option":
      return `Call again with another ${next.option}. ${next.why}`
  }
}

export const problemText = (problem: ActionableProblem): string =>
  [
    `${problem.title}. ${problem.detail}`,
    ...problem.steps.map((step, i) => `${i + 1}. ${step}`),
    `Next: ${nextActionText(problem.nextAction)}`
  ].join("\n")

/** A next action written for the command line, as the tool that does the same. */
export const forTools = (problem: ActionableProblem): ActionableProblem =>
  problem.nextAction.kind === "run_command" && /^npx -y capy-acp threads\b/.test(problem.nextAction.command)
    ? { ...problem, nextAction: { kind: "use_option", option: "threadId", why: "Use an id from list_threads." } }
    : problem

const errorResult = (failure: ActionableProblem) => {
  const problem = forTools(failure)
  return new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: problemText(problem) }],
    structuredContent: { error: { title: problem.title, detail: problem.detail, steps: problem.steps }, nextAction: problem.nextAction }
  })
}

// The result encoder rejects `undefined` values (a defect, sent as "Internal error"), so fields that a
// report leaves undefined are dropped, as JSON would drop them.
const okResult = (answer: Answer) =>
  new McpSchema.CallToolResult({
    isError: false,
    content: [{ type: "text", text: answer.text }],
    structuredContent: JSON.parse(JSON.stringify(answer.structured)) as unknown
  })

/** Arguments that do not match the tool's input schema, as a Problem the calling model can fix. */
export const invalidInput = (tool: string, error: Schema.SchemaError): ActionableProblem => {
  const option = /at \["([^"]+)"\]/.exec(error.message)?.[1] ?? "arguments"
  return {
    title: "Fix the tool arguments",
    detail: `The ${tool} arguments do not match its input schema: ${error.message.replace(/\s+/g, " ").trim()}.`,
    steps: [`Call ${tool} again with arguments that match its input schema.`],
    nextAction: { kind: "use_option", option, why: error.message.replace(/\s+/g, " ").trim() }
  }
}

const statusLine = (report: ThreadReport) =>
  `Thread ${report.id}${report.title === undefined ? "" : ` "${report.title}"`} is ${report.status}.`

const waitNext = (id: string) => `Call wait_for_thread with threadId "${id}" to follow the run.`

/** The next step after a report that `get_thread` or `wait_for_thread` returned. */
const nextStep = (report: ThreadReport, timedOut: boolean, notStarted: boolean): string => {
  if (notStarted) {
    return `Capy has not started on the message yet, and it stays in the queue. Check that the Capy device runs (or the cloud machine starts), then call wait_for_thread with threadId "${report.id}" again. Do not send the message again.`
  }
  if (report.needsYou || report.asks.length > 0) return `Ask the person what Capy needs, then pass the answer to send_message with threadId "${report.id}".`
  if (timedOut) return `The wait timed out and the thread keeps running. ${waitNext(report.id)}`
  switch (report.status) {
    case "working":
    case "waiting":
      return waitNext(report.id)
    case "idle":
      return "The run is done. Review the last reply and any pull request. For more work on it, call send_message."
    case "failed":
      return "The run failed. Read the last reply, then call send_message to try again or to change course."
    case "archived":
      return "The thread is archived. Start a new thread for more work."
  }
}

/** A report as plain text for the calling model: the facts first, the next step, then the reply. */
export const reportText = (
  report: ThreadReport,
  options: { readonly lead?: string; readonly next?: string; readonly timedOut?: boolean; readonly notStarted?: boolean } = {}
): string => {
  const lines = [options.lead ?? (options.notStarted === true ? `Thread ${report.id}: Capy has not started on the message yet.` : statusLine(report))]
  if (report.note !== undefined) lines.push(report.note)
  if (report.model !== undefined) lines.push(`Model: ${report.model}.`)
  for (const ask of report.asks) lines.push(`Capy needs a person (${ask.kind})${ask.text === undefined ? "." : `: ${ask.text}`}`)
  if (report.needsYou && report.asks.length === 0) lines.push("Capy needs a person to look at the thread.")
  if (report.pullRequests.length > 0) lines.push(`Pull requests: ${report.pullRequests.map((pr) => pr.url).join(", ")}`)
  if (report.usage !== undefined) lines.push(`Credits used so far: ${report.usage.cost}.`)
  if (report.url !== undefined) lines.push(`Open in Capy: ${report.url}`)
  lines.push(`Next: ${options.next ?? nextStep(report, options.timedOut === true, options.notStarted === true)}`)
  if (report.lastReply !== undefined) lines.push("", "Last reply from Capy:", report.lastReply)
  return lines.join("\n")
}

export const rowsText = (rows: ReadonlyArray<ThreadRow>): string =>
  rows.length === 0
    ? "No Capy threads found."
    : rows
        .map((row) =>
          [
            `${row.id} [${row.status}${row.needsYou ? ", needs a person" : ""}]`,
            row.title ?? "(no title)",
            row.projectName === undefined ? undefined : `project ${row.projectName}`,
            row.lastActivityAt === undefined ? undefined : `last activity ${row.lastActivityAt}`
          ]
            .filter((part) => part !== undefined)
            .join(" · ")
        )
        .join("\n")

export interface ModelRow {
  readonly id: string
  readonly name: string
  /** `capy`: billed to Capy credits. Anything else: the person's own subscription or key. */
  readonly route: string | undefined
  readonly billing: string | undefined
  readonly reasoningModes: ReadonlyArray<string>
  readonly price: string | undefined
  readonly isDefault: boolean
}

export const modelRows = (models: ReadonlyArray<Model>, prices: ReadonlyMap<string, Price>, defaultModel: string): ReadonlyArray<ModelRow> =>
  models.map((m) => ({
    id: m.id,
    name: m.name,
    route: m.route,
    billing: m.billing,
    reasoningModes: m.reasoningModes ?? [],
    price: modelDescription(m, prices.get(m.id)),
    isDefault: m.id === defaultModel
  }))

export const modelsText = (rows: ReadonlyArray<ModelRow>): string =>
  rows.length === 0
    ? "Capy lists no models for this API key."
    : rows
        .map((m) =>
          [
            `${m.id}${m.isDefault ? " (default)" : ""}: ${m.name}`,
            m.reasoningModes.length === 0 ? undefined : `reasoning ${m.reasoningModes.join("/")}`,
            m.price
          ]
            .filter((part) => part !== undefined)
            .join(" · ")
        )
        .join("\n")

/** Reply text is sent as progress in pieces of about this many characters, not token by token. */
const REPLY_CHUNK = 300

/** The progress token of the current tool call, when the client asked for progress. */
const progressToken = McpSchema.McpRequestContext.useSync(({ requestMetadata }) => {
  const token = Predicate.hasProperty(requestMetadata, "progressToken") ? requestMetadata.progressToken : undefined
  return typeof token === "string" || typeof token === "number" ? token : undefined
})

/** The tools, registered with the `McpServer`. Every Capy call goes through `CapyClient`. */
export const registrations = (config: AdapterConfig): Layer.Layer<never, never, McpServer.McpServer | CapyClient> =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const server = yield* McpServer.McpServer
      const capy = yield* Effect.context<CapyClient>()
      const delegate = makeDelegate(config)
      let prices: Promise<ReadonlyMap<string, Price>> | undefined

      const register = <S extends Schema.Codec<any, any, never, never>>(spec: {
        readonly name: string
        readonly title: string
        readonly description: string
        readonly input: S
        readonly hints: Hints
        readonly run: (input: S["Type"]) => Effect.Effect<Answer, DelegateError, CapyClient | McpSchema.McpRequestContext>
      }) =>
        server.addTool({
          tool: new McpSchema.Tool({
            name: spec.name,
            title: spec.title,
            description: spec.description,
            inputSchema: inputSchemaOf(spec.input),
            annotations: {
              title: spec.title,
              readOnlyHint: spec.hints.readOnly,
              destructiveHint: spec.hints.destructive,
              idempotentHint: spec.hints.idempotent,
              openWorldHint: true
            }
          }),
          annotations: Context.empty(),
          handle: (payload) =>
            Schema.decodeUnknownEffect(spec.input)(payload ?? {}, { errors: "all", onExcessProperty: "ignore" }).pipe(
              Effect.mapError((error) => new DelegateError({ problem: invalidInput(spec.name, error) })),
              Effect.flatMap(spec.run),
              Effect.map(okResult),
              // Typed failures and defects become results; an interruption (a cancelled call) stays one.
              Effect.catch((error) => Effect.succeed(errorResult(toProblem(config, error)))),
              Effect.catchDefect((defect) => Effect.succeed(errorResult(toProblem(config, defect)))),
              Effect.provideContext(capy)
            )
        })

      yield* register({
        name: "start_thread",
        title: "Start a Capy thread",
        description:
          "Start a Capy thread on a coding task and return at once, without waiting for the result. " +
          'By default (where "auto") Capy works in a new git worktree of the folder\'s repository on a Capy device, so your files do not change. ' +
          "Returns the thread report: id, status, where it runs, and a link to the thread in Capy. Next, call wait_for_thread with the id. " +
          'Cost: the run uses the chosen model, on Capy credits or the person\'s own subscription. where "cloud" also costs Capy credits for machine time.',
        input: StartInput,
        hints: { readOnly: false, destructive: false, idempotent: false },
        run: (input) =>
          // Without a folder, delegate uses the working folder and knows that none was given.
          delegate.start({ ...input, folder: input.folder === undefined ? undefined : resolve(input.folder) }).pipe(
            Effect.map((report) => ({
              text: reportText(report, { lead: `Started Capy thread ${report.id}${report.title === undefined ? "" : ` "${report.title}"`}.`, next: waitNext(report.id) }),
              structured: report
            }))
          )
      })

      yield* register({
        name: "wait_for_thread",
        title: "Wait for a Capy thread",
        description:
          "Wait until a Capy thread's run ends, then return its report: status, last reply, pull requests, what Capy needs from a person (asks, needsYou) and credits used. " +
          "Returns early when Capy needs a person, the run fails, or the thread is archived. " +
          "When timeoutSeconds passes first, it returns timedOut true and the thread keeps running: call it again. " +
          "Sends progress notifications with short activity lines when the call has a progress token. Cancelling the call stops the wait, never the thread. Changes nothing. " +
          "If your client ends tool calls sooner than timeoutSeconds, pass a smaller timeoutSeconds.",
        input: WaitInput,
        hints: { readOnly: true, destructive: false, idempotent: true },
        run: (input) =>
          Effect.gen(function*() {
            const token = yield* progressToken
            let progress = 0
            let reply = ""
            const notify = (message: string) =>
              token === undefined
                ? Effect.void
                : server.notifications["notifications/progress"]({ progressToken: token, progress: ++progress, message }).pipe(Effect.ignore)
            const flush = () => {
              const text = reply.replace(/\s+/g, " ").trim()
              reply = ""
              return text === "" ? Effect.void : notify(`Capy: ${text}`)
            }
            const onActivity = (activity: Activity) => {
              if (activity.kind === "activity") return Effect.andThen(flush(), notify(activity.text))
              reply += activity.text
              return reply.length >= REPLY_CHUNK || activity.text.includes("\n") ? flush() : Effect.void
            }
            const result = yield* delegate.wait(input.threadId, { timeoutMs: (input.timeoutSeconds ?? 120) * 1000, onActivity })
            yield* flush()
            return { text: reportText(result, { timedOut: result.timedOut, notStarted: result.notStarted }), structured: result }
          })
      })

      yield* register({
        name: "get_thread",
        title: "Read a Capy thread",
        description:
          "Read a Capy thread's report now, without waiting: status, last reply, pull requests, what Capy needs from a person (asks, needsYou), credits used, and a link. " +
          "Changes nothing. To wait for a run to end, call wait_for_thread instead of calling this in a loop.",
        input: ThreadInput,
        hints: { readOnly: true, destructive: false, idempotent: true },
        run: (input) => delegate.report(input.threadId).pipe(Effect.map((report) => ({ text: reportText(report), structured: report })))
      })

      yield* register({
        name: "send_message",
        title: "Message a Capy thread",
        description:
          "Send a message to a Capy thread: an answer to Capy's question, or follow-up work. " +
          "By default the message waits until the current run ends; interrupt true stops the current run and starts on the message now. " +
          "Returns the thread report; then call wait_for_thread. Cost: the message starts a Capy run, which uses the thread's model.",
        input: SendInput,
        hints: { readOnly: false, destructive: false, idempotent: false },
        run: (input) =>
          delegate.send(input.threadId, input.text, { interrupt: input.interrupt }).pipe(
            Effect.map((report) => ({ text: reportText(report, { lead: `Sent the message to thread ${report.id}.`, next: waitNext(report.id) }), structured: report }))
          )
      })

      yield* register({
        name: "stop_thread",
        title: "Stop a Capy thread's run",
        description:
          "Stop a Capy thread's current run. This interrupts the work in progress. The thread keeps its transcript and takes new messages. " +
          "Returns the thread report. Use it when the person asks, or when the run clearly works on the wrong thing.",
        input: ThreadInput,
        hints: { readOnly: false, destructive: false, idempotent: true },
        run: (input) =>
          delegate.stop(input.threadId).pipe(
            Effect.map((report) => ({
              text: reportText(report, { lead: `Stopped the current run of thread ${report.id}.`, next: "To give Capy new instructions, call send_message." }),
              structured: report
            }))
          )
      })

      yield* register({
        name: "list_threads",
        title: "List Capy threads",
        description:
          "List recent Capy threads, newest first: id, title, status, project, model, last activity, whether Capy needs a person, and a link. " +
          "Filter by project (id or exact name), or by the project of a folder's repository. Without either, it lists threads of every project. Changes nothing.",
        input: ListInput,
        hints: { readOnly: true, destructive: false, idempotent: true },
        run: (input) =>
          delegate
            .list({ project: input.project, folder: input.folder === undefined ? undefined : resolve(input.folder), limit: input.limit })
            .pipe(Effect.map((threads) => ({ text: rowsText(threads), structured: { threads } })))
      })

      yield* register({
        name: "list_models",
        title: "List Capy models",
        description:
          "List the models Capy can run a thread with: id, name, billing route (route \"capy\" bills Capy credits; other routes bill the person's own subscription), reasoning modes, and a price note when Capy's docs list one. " +
          "Pass an id as model to start_thread. Changes nothing.",
        input: NoInput,
        hints: { readOnly: true, destructive: false, idempotent: true },
        run: () =>
          Effect.gen(function*() {
            const models = yield* CapyClient.use((client) => client.listModels).pipe(Effect.mapError((error) => new DelegateError({ problem: toProblem(config, error) })))
            const table = yield* Effect.promise(
              () =>
                (prices ??= config.pricingUrl === ""
                  ? Promise.resolve(new Map())
                  : fetchPrices(config.pricingUrl).catch(() => new Map()))
            )
            const rows = modelRows(models, table, config.defaultModel)
            return { text: modelsText(rows), structured: { models: rows, defaultModel: config.defaultModel } }
          })
      })
    })
  )

/** The protocol revisions this server speaks, newest first. */
export const PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26, McpProtocol.v2024_11_05] as const

/** The MCP server on the `Stdio` it is given, with the tools wired to `capy`. */
export const serverLayer = (config: AdapterConfig, capy: Layer.Layer<CapyClient> = capyLayer(config)) =>
  McpServer.layerStdio({
    name: SERVER_NAME,
    version: AGENT_VERSION,
    instructions: INSTRUCTIONS,
    protocols: PROTOCOLS,
    registrations: registrations(config).pipe(Layer.provide(capy))
  })

const stdioError = (method: string) => (cause: unknown) =>
  PlatformError.systemError({ _tag: "Unknown", module: "Stdio", method, description: String(cause), cause })

const write = (stream: NodeJS.WriteStream) => () =>
  Sink.forEach((chunk: string | Uint8Array) =>
    Effect.callback<void, PlatformError.PlatformError>((resume) => {
      stream.write(chunk, (error) => resume(error == null ? Effect.void : Effect.fail(stdioError("write")(error))))
    })
  )

/** This process's stdin and stdout, for the stdio transport. */
const nodeStdio = Layer.succeed(
  Stdio.Stdio,
  Stdio.make({
    args: Effect.sync(() => process.argv.slice(2)),
    stdin: Stream.fromAsyncIterable(process.stdin as AsyncIterable<Uint8Array>, stdioError("stdin")),
    stdout: write(process.stdout),
    stderr: write(process.stderr)
  })
)

/**
 * Runs the server until the client closes stdin. The stdio transport then ends the server by
 * interrupting it, after the last response is written, which counts as a clean stop.
 */
export const runMcpServer = async (config: AdapterConfig): Promise<void> => {
  // A person who runs the command in a terminal wants to know what it is. An MCP client pipes stdin.
  if (process.stdin.isTTY) {
    process.stderr.write("capy-acp mcp is an MCP server on stdio: add it to your MCP client. It is waiting for MCP messages on stdin; press Ctrl+C to stop.\n")
  }
  const server = Layer.launch(serverLayer(config).pipe(Layer.provide(nodeStdio))).pipe(Effect.provideService(Logger.LogToStderr, true))
  const exit = await Effect.runPromiseExit(server)
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause)
}
