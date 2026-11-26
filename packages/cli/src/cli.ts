/**
 * `capy-cli run|threads|status|follow|send|stop|setup|doctor`: Capy threads from a terminal, a script
 * or another agent.
 *
 * Reply text goes to stdout and activity to stderr, so `capy-cli run ... > reply.md` keeps only the
 * reply. `--json` prints NDJSON on stdout instead: every line has a `type`, and an error carries a
 * `nextAction`. The exit code says how the thread ended (see HELP). The first Ctrl+C stops following
 * and leaves the thread running; the second exits at once.
 */
import { resolve } from "node:path"
import { parseArgs, type ParseArgsOptionsConfig } from "node:util"
import type { CapyClient } from "@capy-acp/core/capy/client.js"
import { type AdapterConfig, SHARED_KEY } from "@capy-acp/core/config.js"
import {
  type ActionableProblem,
  type DelegateError,
  MACHINE_SIZES,
  type MachineSize,
  makeDelegate,
  type Outcome,
  settle,
  type StartInput,
  type ThreadReport,
  type ThreadRow,
  type WaitResult,
  type WhereChoice
} from "@capy-acp/core/delegate.js"
import { checkDeviceAndFolder, checkKey, checkOutput } from "@capy-acp/core/doctor.js"
import { toText } from "@capy-acp/core/problems.js"
import type { ProjectSummary } from "@capy-acp/core/workspace.js"
import { Effect, type Layer } from "effect"
import { AGENT_NAME, AGENT_VERSION } from "./version.js"

const CMD = "npx -y capy-cli"

export const HELP = `${AGENT_NAME} ${AGENT_VERSION}: runs Capy coding-agent threads from a terminal, a script or CI.
A community project. Not made, endorsed or supported by Capy.

Usage:
  npx -y capy-cli run [options] <task...>     Start a thread and stream its reply.
  npx -y capy-cli threads [options]           List recent threads.
  npx -y capy-cli status <thread-id>          Show a thread: status, last reply, pull requests.
  npx -y capy-cli follow <thread-id>          Stream a thread until its run ends.
  npx -y capy-cli send <thread-id> <text...>  Send a message to a thread.
  npx -y capy-cli stop <thread-id>            Stop the current run of a thread.
  npx -y capy-cli setup                       Save a Capy API key on this machine, and set up a Capy device.
  npx -y capy-cli doctor [folder]             Check the setup for a folder (default: this folder).
  npx -y capy-cli help <command>              Show the options of a command.
  npx -y capy-cli --version

The key is ${SHARED_KEY}: CAPY_API_KEY, else ~/.config/capy-acp/api-key.

Exit codes: 0 done, 1 failed or error, 2 usage error, 3 Capy waits on a person,
4 timed out or Capy has not started yet (the thread keeps running), 130 stopped following with Ctrl+C.

Docs: https://github.com/yazcaleb/capy-acp/tree/main/packages/cli#readme
`

const EXIT_CODES = `Exit codes: 0 done, 1 failed or error, 2 usage error, 3 Capy waits on a person,
4 timed out or Capy has not started yet (the thread keeps running), 130 stopped following with Ctrl+C.`

const CTRL_C = "Ctrl+C once stops following, and the thread keeps running. Ctrl+C twice exits at once."

const JSON_OPTION = "  --json                   Print NDJSON on stdout. Every line has a \"type\"; errors have a \"nextAction\"."

export const COMMAND_HELP = {
  run: `Usage: ${CMD} run [options] <task...>

Starts a Capy thread for the GitHub repository of this folder. Capy's reply streams to stdout, and
what Capy does streams to stderr. A summary follows: status, pull requests, questions, cost and the
commands to follow, message or stop the thread. Pass - as the task, or pipe it in, to read it from stdin.

Where Capy runs (--where):
  auto       The default. A new Capy worktree on a Capy device. Never a cloud machine.
  worktree   A new git worktree on this computer's Capy device (or on --device). Your folder does not change.
  here       This folder, edited in place by this computer's Capy device.
  cloud      A Capy cloud machine. Machine time costs Capy credits.

Options:
  --where <where>          auto, worktree, here or cloud.
  --project <id or name>   The Capy project. Default: the project of the folder's GitHub remote.
  --repo <owner/name>      The repository, for a worktree on another computer's device.
  --device <device-id>     A Capy device on another computer. Default: CAPY_DEVICE_ID.
  --machine-size <size>    Cloud only: ${MACHINE_SIZES.join(", ")}. Default: the project's size.
  --model <model-id>       Default: the default model of the Capy account that owns the API key.
  --reasoning <level>      Needs --model. Default: CAPY_ACP_REASONING, else high when the model offers it.
  --folder <path>          The folder whose repository Capy works on. Default: this folder.
  --timeout <seconds>      Stop following after this long. The thread keeps running. Default: no limit.
  --detach                 Print the thread id and exit. Do not follow the thread.
${JSON_OPTION}

${CTRL_C}

${EXIT_CODES}

Example:
  ${CMD} run --timeout 900 "Fix the flaky test in test/sse.test.ts and open a pull request"
`,
  threads: `Usage: ${CMD} threads [options]

Lists recent Capy threads, newest first, with their status.

Options:
  --project <id or name>   Only this Capy project's threads.
  --folder <path>          Only the threads of this folder's Capy project.
  --limit <n>              How many threads, 1 to 100. Default: 20.
${JSON_OPTION}
`,
  status: `Usage: ${CMD} status <thread-id> [--json]

Shows a thread: its status, last reply, pull requests, questions for you and cost. It does not wait.

${JSON_OPTION}

Exit codes: 0 done or working, 1 failed or error, 2 usage error, 3 Capy waits on a person.
`,
  follow: `Usage: ${CMD} follow <thread-id> [options]

Streams a thread until its run ends, Capy waits on a person, or the timeout. Then prints the summary.
When the run already ended, it prints the last reply.

Options:
  --timeout <seconds>      Stop following after this long. The thread keeps running. Default: no limit.
${JSON_OPTION}

${CTRL_C}

${EXIT_CODES}
`,
  send: `Usage: ${CMD} send <thread-id> [options] <text...>

Sends a message to a thread. By default it waits in line behind the current run. Pass - as the text,
or pipe it in, to read it from stdin.

Options:
  --interrupt              Stop the current run first, then send.
  --follow                 Stream the thread until its run ends, as follow does.
  --timeout <seconds>      With --follow: stop following after this long. Default: no limit.
${JSON_OPTION}

${EXIT_CODES}
`,
  stop: `Usage: ${CMD} stop <thread-id> [--json]

Stops the current run of a thread. The thread keeps its transcript and takes new messages.

${JSON_OPTION}
`,
  setup: `Usage: ${CMD} setup

Saves ${SHARED_KEY}, after Capy accepts it. The key goes to ~/.config/capy-acp/api-key,
readable only by you; CAPY_API_KEY wins over it. Then, when this computer has no Capy device, it
offers to set one up with \`capy dock\` and to link this folder, asking before each step.
`,
  doctor: `Usage: ${CMD} doctor [folder]

Checks the setup that \`${CMD} run\` needs for a folder (default: this folder): the API key, this
computer's Capy device, and the folder's Capy project and link. Prints the fix for each problem.
It changes nothing. Exit code 0 when nothing needs a fix, else 1.
`,
  help: `Usage: ${CMD} help [command]

Shows the options of a command: run, threads, status, follow, send, stop, setup or doctor.
`
} as const

export type CommandName = keyof typeof COMMAND_HELP

const isCommand = (name: string): name is CommandName => Object.hasOwn(COMMAND_HELP, name)

interface Follow {
  readonly json: boolean
  readonly timeoutMs: number
}

export type Parsed =
  | ({ readonly command: "run"; readonly task: string | undefined; readonly start: Omit<StartInput, "task">; readonly detach: boolean } & Follow)
  | { readonly command: "threads"; readonly project: string | undefined; readonly folder: string | undefined; readonly limit: number | undefined; readonly json: boolean }
  | { readonly command: "status" | "stop"; readonly threadId: string; readonly json: boolean }
  | ({ readonly command: "follow"; readonly threadId: string } & Follow)
  | ({ readonly command: "send"; readonly threadId: string; readonly text: string | undefined; readonly interrupt: boolean; readonly follow: boolean } & Follow)
  | { readonly command: "setup" }
  | { readonly command: "doctor"; readonly folder: string | undefined }
  | { readonly command: "version" }
  | { readonly command: "help"; readonly topic: CommandName | undefined }
  | { readonly command: "usage"; readonly message: string; readonly topic: CommandName | undefined; readonly json: boolean }

const text = { type: "string" } as const
const flag = { type: "boolean" } as const
const common = { json: flag, help: { type: "boolean", short: "h" } } as const

const OPTIONS = {
  run: {
    ...common,
    where: text,
    project: text,
    repo: text,
    device: text,
    "machine-size": text,
    model: text,
    reasoning: text,
    folder: text,
    timeout: text,
    detach: flag
  },
  threads: { ...common, project: text, folder: text, limit: text },
  status: common,
  follow: { ...common, timeout: text },
  send: { ...common, interrupt: flag, follow: flag, timeout: text },
  stop: common,
  setup: { help: common.help },
  doctor: { help: common.help },
  help: { help: common.help }
} satisfies Record<CommandName, ParseArgsOptionsConfig>

const WHERE: ReadonlyArray<WhereChoice> = ["auto", "worktree", "here", "cloud"]

class UsageError extends Error {}

const seconds = (value: string | undefined): number => {
  if (value === undefined) return Number.POSITIVE_INFINITY
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--timeout takes a number of seconds above 0, not "${value}".`)
  return n * 1000
}

const oneOf = <A extends string>(option: string, value: string | undefined, allowed: ReadonlyArray<A>): A | undefined => {
  if (value === undefined || (allowed as ReadonlyArray<string>).includes(value)) return value as A | undefined
  throw new UsageError(`--${option} takes ${allowed.join(", ")}, not "${value}".`)
}

/** The rest of the arguments as one text, or undefined to read stdin (`-`, or nothing). */
const joined = (words: ReadonlyArray<string>): string | undefined =>
  words.length === 0 || (words.length === 1 && words[0] === "-") ? undefined : words.join(" ")

const threadIdOf = (positionals: ReadonlyArray<string>, command: CommandName): string => {
  const id = positionals[0]
  if (id === undefined || id.trim() === "") throw new UsageError(`Give the thread id: ${CMD} ${command} <thread-id>. \`${CMD} threads\` lists them.`)
  return id
}

/** Parses the arguments after `capy-cli`. Pure: never reads stdin or the environment. */
export const parseCommand = (args: ReadonlyArray<string>): Parsed => {
  const [name = "", ...rest] = args
  if (args.length === 0 || ((name === "--help" || name === "-h") && rest.length === 0)) return { command: "help", topic: undefined }
  if ((name === "--version" || name === "-v") && rest.length === 0) return { command: "version" }
  const json = rest.includes("--json")
  if (!isCommand(name)) return { command: "usage", message: `Unknown command: ${name}`, topic: undefined, json }
  try {
    const { values: v, positionals } = parseArgs({ args: rest, options: OPTIONS[name] as ParseArgsOptionsConfig, allowPositionals: true, strict: true })
    const str = (key: string) => v[key] as string | undefined
    const bool = (key: string) => v[key] === true
    if (bool("help")) return { command: "help", topic: name }
    switch (name) {
      case "help": {
        const topic = positionals[0]
        if (topic === undefined) return { command: "help", topic: undefined }
        // The usage without a topic lists every command.
        if (!isCommand(topic)) return { command: "usage", message: `No command is called "${topic}".`, topic: undefined, json }
        return { command: "help", topic }
      }
      case "setup":
        if (positionals.length > 0) throw new UsageError("setup takes no arguments.")
        return { command: "setup" }
      case "doctor":
        if (positionals.length > 1) throw new UsageError(`doctor takes one folder. Got "${positionals.join(" ")}".`)
        return { command: "doctor", folder: positionals[0] }
      case "run": {
        const where = oneOf("where", str("where"), WHERE)
        const machineSize = oneOf<MachineSize>("machine-size", str("machine-size"), MACHINE_SIZES)
        if (machineSize !== undefined && where !== "cloud") throw new UsageError("--machine-size needs --where cloud. Machine time on a cloud machine costs Capy credits.")
        const start: Omit<StartInput, "task"> = {
          ...(where === undefined ? {} : { where }),
          ...(machineSize === undefined ? {} : { machineSize }),
          ...Object.fromEntries((["project", "repo", "device", "model", "reasoning", "folder"] as const).flatMap((key) => (str(key) === undefined ? [] : [[key, str(key)]])))
        }
        return { command: "run", task: joined(positionals), start, detach: bool("detach"), json, timeoutMs: seconds(str("timeout")) }
      }
      case "threads": {
        const limitText = str("limit")
        const limit = limitText === undefined ? undefined : Number(limitText)
        if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= 100)) throw new UsageError(`--limit takes a whole number from 1 to 100, not "${limitText}".`)
        if (positionals.length > 0) throw new UsageError(`threads takes no arguments, only options. Got "${positionals.join(" ")}".`)
        return { command: "threads", project: str("project"), folder: str("folder"), limit, json }
      }
      case "status":
      case "stop":
      case "follow": {
        const threadId = threadIdOf(positionals, name)
        if (positionals.length > 1) throw new UsageError(`${name} takes one thread id. Got "${positionals.join(" ")}".`)
        return name === "follow" ? { command: name, threadId, json, timeoutMs: seconds(str("timeout")) } : { command: name, threadId, json }
      }
      case "send": {
        const threadId = threadIdOf(positionals, name)
        return {
          command: "send",
          threadId,
          text: joined(positionals.slice(1)),
          interrupt: bool("interrupt"),
          follow: bool("follow"),
          json,
          timeoutMs: seconds(str("timeout"))
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { command: "usage", message, topic: name, json }
  }
}

/** Ways out to the terminal and the process, injected so tests run none of them for real. */
export interface CliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  readonly isTTY: { readonly stdin: boolean; readonly stdout: boolean; readonly stderr: boolean }
  /** stdout and stderr reach the same place (a terminal, or one file or pipe through `2>&1`). Default: true. */
  readonly merged?: boolean
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly readStdin: () => Promise<string>
  /** Calls `handler` on each Ctrl+C until the returned function is called. */
  readonly onInterrupt: (handler: () => void) => () => void
  /** Exits the process at once. */
  readonly exit: (code: number) => void
}

export interface CliDeps {
  readonly config: AdapterConfig
  readonly capy: Layer.Layer<CapyClient>
  readonly io: CliIo
}

const STATUS_HEADLINE: Record<ThreadReport["status"], string> = {
  working: "Capy is still working.",
  waiting: "Capy is waiting.",
  idle: "Capy is done.",
  failed: "The run failed.",
  archived: "The thread is archived."
}

/** 0 done, 1 failed, 3 waits on a person, 4 timed out or not started yet. Pure. */
export const exitCodeOf = (report: ThreadReport & { readonly timedOut?: boolean; readonly notStarted?: boolean }): number =>
  report.timedOut === true || report.notStarted === true ? 4 : report.status === "failed" ? 1 : report.needsYou ? 3 : 0

const formatSeconds = (ms: number) => `${Math.round(ms / 100) / 10} s`

/** The lines after a run: how it ended, where, pull requests, questions, cost and the next commands. Pure. */
export const summaryLines = (
  report: ThreadReport,
  options: {
    readonly timedOut?: boolean
    readonly timeoutMs?: number
    /** Capy has not started on the message after two minutes. */
    readonly notStarted?: boolean
    /** Right after `send`: the status is from before Capy read the message. */
    readonly sent?: boolean
  } = {}
): ReadonlyArray<string> => {
  const pending = options.sent === true || options.notStarted === true
  const running = pending || options.timedOut === true || report.status === "working" || report.status === "waiting"
  const headline = options.notStarted === true
    ? "Capy has not started on the message yet. It stays in the queue: check that the Capy device runs, then follow the thread again."
    : options.sent === true
    ? "Capy has the message."
    : options.timedOut === true
    ? `Stopped following after ${formatSeconds(options.timeoutMs ?? 0)}. The thread keeps running.`
    : report.needsYou
    ? "Capy needs you."
    : STATUS_HEADLINE[report.status]
  // Following a thread that waits on a person returns at once: the answer comes first.
  const answer = report.needsYou && !pending
  return [
    headline,
    `Thread: ${report.id}${report.title === undefined ? "" : ` (${report.title})`}`,
    ...(report.deviceId === undefined ? [] : [`Device: ${report.deviceId}`]),
    ...(report.note === undefined ? [] : [report.note]),
    ...report.pullRequests.map((pr) => `Pull request: ${pr.url}`),
    ...report.asks.map((ask) => `Capy asks (${ask.kind}): ${ask.text ?? "open the thread to see what it needs."}`),
    ...(report.usage === undefined ? [] : [`Cost so far: ${report.usage.cost} in Capy credits.`]),
    ...(report.url === undefined ? [] : [`Open: ${report.url}`]),
    ...(answer ? [`Answer: ${CMD} send ${report.id} "<answer>"`] : []),
    ...(running && !answer ? [`Follow: ${CMD} follow ${report.id}`] : []),
    ...(answer ? [] : [`Send:   ${CMD} send ${report.id} "<message>"`]),
    ...(running ? [`Stop:   ${CMD} stop ${report.id}`] : [])
  ]
}

const kebab = (option: string) => option.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** A Problem as text, with the next action last. Pure. */
export const problemText = (problem: ActionableProblem): string => {
  const next = problem.nextAction
  const line = next.kind === "run_command"
    ? `Next: run \`${next.command}\`.`
    : next.kind === "ask_human"
    ? `Next: ${next.say}`
    : next.kind === "retry"
    ? `Next: try again in ${Math.ceil(next.afterMs / 1000)} seconds.`
    : `Next: pass --${kebab(next.option)}. ${next.why}`
  return `${toText(problem, "  ")}\n${line}\n`
}

const noColor = (env: CliIo["env"]) => env.NO_COLOR !== undefined && env.NO_COLOR !== ""

/** Where each kind of output goes, for text or for NDJSON. */
const makeOutput = (io: CliIo, json: boolean) => {
  const dim = io.isTTY.stderr && !noColor(io.env)
  // Reply text and activity lines share one screen only when both streams are the terminal.
  const shared = io.isTTY.stdout && io.isTTY.stderr
  let open = false
  // The reply's last line has no newline yet, and no activity line followed it on stderr.
  let unbroken = false
  const endReply = () => {
    if (open) io.stdout("\n")
    open = false
    unbroken = false
  }
  return {
    json,
    event: (type: string, fields: object = {}) => io.stdout(`${JSON.stringify({ type, ...fields })}\n`),
    reply(text: string) {
      if (json) return io.stdout(`${JSON.stringify({ type: "reply", text })}\n`)
      io.stdout(text)
      open = !text.endsWith("\n")
      unbroken = open
    },
    activity(text: string) {
      if (json) return io.stdout(`${JSON.stringify({ type: "activity", text })}\n`)
      if (shared) endReply()
      // Output that merges both streams (2>&1) would run the reply into this line. stdout stays as it is.
      const lead = unbroken && io.merged !== false ? "\n" : ""
      unbroken = false
      io.stderr(dim ? `${lead}\x1b[2m- ${text}\x1b[22m\n` : `${lead}- ${text}\n`)
    },
    endReply,
    /** A note for a person; NDJSON leaves it out. */
    info(text: string) {
      if (!json) io.stderr(`${text}\n`)
    },
    problem(problem: ActionableProblem, fields: object = {}): number {
      if (json) io.stdout(`${JSON.stringify({ type: "error", ...fields, ...problem })}\n`)
      else io.stderr(problemText(problem))
      return 1
    }
  }
}

const usageProblem = (message: string, topic: CommandName | undefined): ActionableProblem => ({
  title: "Fix the command",
  detail: message,
  steps: [`Run \`${CMD} help${topic === undefined ? "" : ` ${topic}`}\` for the options.`],
  nextAction: { kind: "run_command", command: `${CMD} help${topic === undefined ? "" : ` ${topic}`}` }
})

const usage = (io: CliIo, parsed: Extract<Parsed, { command: "usage" }>): number => {
  if (parsed.json) io.stdout(`${JSON.stringify({ type: "error", ...usageProblem(parsed.message, parsed.topic) })}\n`)
  else if (parsed.topic === undefined) io.stderr(`${parsed.message}\n\n${HELP}`)
  else io.stderr(`${parsed.message}\nRun \`${CMD} help ${parsed.topic}\` for the options.\n`)
  return 2
}

const formatTime = (iso: string | undefined) => (iso === undefined ? "" : iso.replace("T", " ").slice(0, 16))

/** Thread rows as aligned columns. Pure. */
export const threadTable = (rows: ReadonlyArray<ThreadRow>): string => {
  if (rows.length === 0) return "No threads.\n"
  const cells = rows.map((row) => [
    row.id,
    row.needsYou ? "needs you" : row.status === "idle" ? "done" : row.status,
    row.projectName ?? row.projectId ?? "",
    formatTime(row.lastActivityAt),
    row.title ?? ""
  ])
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((c) => c[i]!.length)))
  return cells.map((c) => c.map((cell, i) => (i === c.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd()).join("\n") + "\n"
}

/** Runs a command and returns its exit code. Never throws for a Capy failure: it prints the Problem. */
export const runCli = async (args: ReadonlyArray<string>, deps: CliDeps): Promise<number> => {
  const { io, config } = deps
  const parsed = parseCommand(args)
  switch (parsed.command) {
    case "usage":
      return usage(io, parsed)
    case "help":
      io.stdout(parsed.topic === undefined ? HELP : COMMAND_HELP[parsed.topic])
      return 0
    case "version":
      io.stdout(`${AGENT_NAME} ${AGENT_VERSION}\n`)
      return 0
    case "setup":
    case "doctor":
      // bin.ts runs these; reaching here means the wiring is wrong.
      io.stderr(`Run \`${CMD} ${parsed.command}\` from a terminal.\n`)
      return 2
  }

  const out = makeOutput(io, parsed.json)
  const delegate = makeDelegate(config)
  const execute = <A>(operation: Effect.Effect<A, DelegateError, CapyClient>, signal?: AbortSignal): Promise<Outcome<A>> =>
    Effect.runPromise(settle(config, operation).pipe(Effect.provide(deps.capy)), signal === undefined ? undefined : { signal })

  const readText = async (given: string | undefined, what: string, topic: CommandName): Promise<string | number> => {
    if (given !== undefined) return given
    const piped = io.isTTY.stdin ? "" : (await io.readStdin()).trim()
    if (piped !== "") return piped
    return usage(io, { command: "usage", message: `Give the ${what} as arguments, or pipe it in.`, topic, json: parsed.json })
  }

  // The first Ctrl+C runs `onFirst`; the second exits at once.
  let presses = 0
  let onFirst = () => {}
  const withInterrupts = async (body: () => Promise<number>): Promise<number> => {
    const off = io.onInterrupt(() => {
      if (++presses > 1) return io.exit(130)
      onFirst()
    })
    try {
      return await body()
    } finally {
      off()
    }
  }

  const detached = (threadId: string): number => {
    if (out.json) {
      out.event("detached", {
        threadId,
        message: "Stopped following. The thread keeps running on Capy.",
        nextAction: { kind: "run_command", command: `${CMD} follow ${threadId} --json` }
      })
    } else {
      out.endReply()
      out.info(`Stopped following. The thread keeps running on Capy.\nFollow: ${CMD} follow ${threadId}\nStop:   ${CMD} stop ${threadId}`)
    }
    return 130
  }

  /** Follows a thread to the end of its run, then prints the report. */
  const follow = async (threadId: string, timeoutMs: number): Promise<number> => {
    const controller = new AbortController()
    onFirst = () => controller.abort()
    let streamed = false
    const operation = delegate.wait(threadId, {
      timeoutMs,
      onActivity: (activity) => {
        if (activity.kind === "reply") {
          streamed = true
          out.reply(activity.text)
        } else {
          out.activity(activity.text)
        }
      }
    })
    let outcome: Outcome<WaitResult>
    try {
      outcome = await execute(operation, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return detached(threadId)
      throw error
    }
    if (!outcome.ok) return out.problem(outcome.problem, { threadId })
    const result = outcome.value
    // Nothing streamed: the run had ended, or its reply committed without streaming.
    if (!streamed && !out.json && result.lastReply !== undefined) out.reply(result.lastReply)
    out.endReply()
    if (out.json) out.event("report", result)
    else out.info(`\n${summaryLines(result, { timedOut: result.timedOut, timeoutMs, notStarted: result.notStarted }).join("\n")}`)
    return exitCodeOf(result)
  }

  switch (parsed.command) {
    case "run": {
      const task = await readText(parsed.task, "task", "run")
      if (typeof task === "number") return task
      const start = { ...parsed.start, task, folder: resolve(io.cwd, parsed.start.folder ?? ".") }
      return withInterrupts(async () => {
        let detach = parsed.detach
        onFirst = () => {
          detach = true
          out.info(`Capy is creating the thread. ${AGENT_NAME} stops following once Capy returns its id. Press Ctrl+C again to exit now.`)
        }
        const started = await execute(delegate.start(start))
        if (!started.ok) return out.problem(started.problem)
        const report = started.value
        if (out.json) out.event("started", report)
        else if (parsed.detach) io.stdout(`${report.id}\n`)
        if (!out.json) {
          out.info(`Started thread ${report.id}.${report.note === undefined ? "" : ` ${report.note}`}`)
          if (report.url !== undefined) out.info(`Open: ${report.url}`)
        }
        if (parsed.detach) {
          out.info(`Follow: ${CMD} follow ${report.id}\nStatus: ${CMD} status ${report.id}\nStop:   ${CMD} stop ${report.id}`)
          return 0
        }
        if (detach) return detached(report.id)
        return follow(report.id, parsed.timeoutMs)
      })
    }
    case "follow":
      return withInterrupts(() => follow(parsed.threadId, parsed.timeoutMs))
    case "send": {
      const message = await readText(parsed.text, "message", "send")
      if (typeof message === "number") return message
      const sent = await execute(delegate.send(parsed.threadId, message, { interrupt: parsed.interrupt }))
      if (!sent.ok) return out.problem(sent.problem, { threadId: parsed.threadId })
      // The status is from before Capy read the message, so the next step is to follow the thread.
      if (out.json) out.event("sent", { ...sent.value, nextAction: { kind: "run_command", command: `${CMD} follow ${parsed.threadId} --json` } })
      else out.info(parsed.interrupt ? `Stopped the current run and sent the message to ${parsed.threadId}.` : `Sent. Capy reads the message after the current run, if one is going.`)
      if (parsed.follow) return withInterrupts(() => follow(parsed.threadId, parsed.timeoutMs))
      if (!out.json) out.info(summaryLines(sent.value, { sent: true }).join("\n"))
      return 0
    }
    case "status": {
      const outcome = await execute(delegate.report(parsed.threadId))
      if (!outcome.ok) return out.problem(outcome.problem, { threadId: parsed.threadId })
      const report = outcome.value
      if (out.json) out.event("report", report)
      else io.stdout(`${summaryLines(report).join("\n")}\n${report.lastReply === undefined ? "" : `\nLast reply:\n${report.lastReply}\n`}`)
      return exitCodeOf(report)
    }
    case "stop": {
      const outcome = await execute(delegate.stop(parsed.threadId))
      if (!outcome.ok) return out.problem(outcome.problem, { threadId: parsed.threadId })
      if (out.json) out.event("stopped", outcome.value)
      else io.stdout(`Stopped the current run of ${parsed.threadId}. The thread keeps its transcript and takes new messages.\n`)
      return 0
    }
    case "threads": {
      const outcome = await execute(delegate.list({
        project: parsed.project,
        folder: parsed.folder === undefined ? undefined : resolve(io.cwd, parsed.folder),
        limit: parsed.limit
      }))
      if (!outcome.ok) return out.problem(outcome.problem)
      // A last line with the count, so an empty list is not mistaken for lost output.
      if (out.json) {
        for (const row of outcome.value) out.event("thread", row)
        out.event("threads", { count: outcome.value.length })
      } else {
        io.stdout(threadTable(outcome.value))
      }
      return 0
    }
  }
}

export interface DoctorIo {
  readonly write: (text: string) => void
  /** The projects that the API key can see. */
  readonly listProjects: () => Promise<ReadonlyArray<ProjectSummary>>
}

/**
 * `capy-cli doctor [folder]`: the checks that `run` needs with its default, a worktree on this
 * computer's Capy device. Returns the exit code: 0 when nothing needs a fix. Read only.
 */
export const runDoctor = async (config: AdapterConfig, folder: string, io: DoctorIo): Promise<number> => {
  const out = checkOutput(io.write, config.product)
  io.write(`${AGENT_NAME} ${AGENT_VERSION} doctor: ${folder}\n\n`)
  const projects = await checkKey(config, io.listProjects, out)
  await checkDeviceAndFolder(config, folder, projects, out, {
    mode: "linked",
    linked: `The folder is linked to this device. \`${CMD} run\` starts a thread in a new Capy worktree of it (or in the folder itself with --where here).`
  })
  const problems = out.problems()
  io.write(
    problems === 0
      ? `\nReady. Start a thread: ${CMD} run "<task>"\n`
      : `\n${problems === 1 ? "1 problem" : `${problems} problems`} to fix. Then run \`${CMD} doctor\` again.\n` +
          "Or run threads on a Capy cloud machine with --where cloud, which needs no Capy device here. Machine time costs Capy credits.\n"
  )
  return problems === 0 ? 0 : 1
}
