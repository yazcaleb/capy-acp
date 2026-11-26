/**
 * Hands work to Capy threads and reports on them: the shared core of the CLI and the MCP server.
 *
 * `start` picks where the thread runs (a fresh Capy worktree on a Capy device by default, the folder in
 * place, or a Capy cloud machine), `wait` follows the thread's stream until the run settles, and
 * `report` reads the thread as one plain summary. Every failure is a `DelegateError` that carries a
 * Problem with the steps to fix it and a `nextAction` for a calling agent.
 *
 * The API does not say where a thread runs (docs/capy-api-notes.md, ask 4), so a report names it only
 * for threads that this process started.
 */
import { randomUUID } from "node:crypto"
import { Cause, Clock, Data, Duration, Effect, Option, Result, Stream } from "effect"
import {
  type CapyError,
  CapyClient,
  type CreateThread,
  describeError,
  isCapyError,
  isTransient,
  layer as capyLayer,
  MACHINE_SIZES,
  type MachineSize,
  type ModelSelection,
  type Thread
} from "./capy/client.js"
import type { CapyEvent, Message, ThreadStatus } from "./capy/events.js"
import { type AdapterConfig, type Product, SHARED_KEY } from "./config.js"
import { formatCredits } from "./pricing.js"
import { type NextAction, NO_DEVICE_TITLE, notGit, noGitHubRemote, outsideChat, type Problem, problemOf } from "./problems.js"
import { initialTurn, step, type Step, subagentCallId, turnComplete, type TurnSignal, type TurnState } from "./translate.js"
import { type ProjectSummary, readDevice, readGit, readLinkedFolders, resolveWorkspace } from "./workspace.js"

export { MACHINE_SIZES, type MachineSize }

/** Where a thread runs: a fresh Capy worktree on a Capy device, the folder in place, or a Capy cloud machine. */
export type Where = "worktree" | "here" | "cloud"
/** `auto` is `worktree` when a Capy device can run it; it never picks the cloud. */
export type WhereChoice = Where | "auto"

export interface StartInput {
  readonly task: string
  /** The folder whose repository the thread works on. Default: the process's working folder. */
  readonly folder?: string | undefined
  readonly where?: WhereChoice | undefined
  /** A Capy project id or exact name. Default: the project of the folder's GitHub remote. */
  readonly project?: string | undefined
  /** `owner/name`, for a worktree on another computer's device. Default: the folder's, else the project's only repository. */
  readonly repo?: string | undefined
  /** A Capy device id, for a worktree on another computer. Default: `CAPY_DEVICE_ID`. */
  readonly device?: string | undefined
  /** Cloud threads only. Absent, the project's machine size applies. */
  readonly machineSize?: MachineSize | undefined
  readonly model?: string | undefined
  readonly reasoning?: string | undefined
  readonly title?: string | undefined
}

/** A pull request that Capy's replies link to. The thread API lists none, so its state is unknown. */
export interface PullRequestLink {
  readonly url: string
  readonly repo: string
  readonly number: number
}

/** Something the thread needs from a person, such as an answer or a sign-in. */
export interface ThreadAsk {
  readonly kind: string
  readonly text: string | undefined
}

export interface ThreadUsage {
  /** Capy credits, thousandths of a dollar. */
  readonly totalCredits: number
  readonly llmCredits: number | undefined
  readonly vmCredits: number | undefined
  readonly imageCredits: number | undefined
  /** `totalCredits` in dollars, as the Capy app shows it: "$0.00". */
  readonly cost: string
}

export interface ThreadReport {
  readonly id: string
  readonly title: string | undefined
  readonly status: ThreadStatus
  /** Known only for threads this process started. */
  readonly where: Where | undefined
  /** The Capy device that runs the thread. Known only for device threads this process started. */
  readonly deviceId: string | undefined
  readonly projectId: string | undefined
  readonly model: string | undefined
  /** The last committed assistant reply, cut to about 8000 characters with a note. */
  readonly lastReply: string | undefined
  readonly pullRequests: ReadonlyArray<PullRequestLink>
  readonly asks: ReadonlyArray<ThreadAsk>
  /** Capy or a teammate waits on a person: an answer, a decision, a sign-in, or credits. */
  readonly needsYou: boolean
  readonly usage: ThreadUsage | undefined
  /** The thread in the Capy web app. */
  readonly url: string | undefined
  /** One sentence about where the thread runs, such as the cost of a cloud machine. */
  readonly note: string | undefined
}

export interface WaitResult extends ThreadReport {
  /** The wait ended before the run did. The thread keeps running. */
  readonly timedOut: boolean
  /**
   * Capy did not start on the message this process sent within two minutes. The message stays in the
   * queue; `lastReply` is left out, since it would be the reply to an earlier message.
   */
  readonly notStarted: boolean
}

/** One line of a thread list. */
export interface ThreadRow {
  readonly id: string
  readonly title: string | undefined
  readonly status: ThreadStatus
  readonly projectId: string | undefined
  readonly projectName: string | undefined
  readonly model: string | undefined
  readonly lastActivityAt: string | undefined
  readonly needsYou: boolean
  readonly url: string | undefined
}

/** What `wait` reports while it follows a thread: reply text as it streams, and short activity lines. */
export type Activity =
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "activity"; readonly text: string }

export interface WaitOptions {
  readonly timeoutMs: number
  readonly onActivity?: ((activity: Activity) => void | Effect.Effect<void>) | undefined
}

/** A Problem that always says what a calling agent does next. */
export type ActionableProblem = Problem & { readonly nextAction: NextAction }

export class DelegateError extends Data.TaggedError("DelegateError")<{ readonly problem: ActionableProblem }> {}

/** A thread title from the first line of a prompt or task. */
export const titleOf = (text: string) => {
  const line = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "capy-acp session"
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

const MAX_REPLY = 8000
/** A Capy stream event id (a ULID), the only thing a stream cursor may be. */
const EVENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
/** A message this process sent counts as not picked up yet for this long, so an early `idle` does not end a wait. */
const PICKUP_MS = 2 * 60_000
const MAX_IDLE_RECHECKS = 10
const MAX_FAILURES = 12
/** How long an `until=run` connection may stay open after the run ended before it is dropped. */
const END_GRACE_MS = 10_000
const backoff = (attempt: number) => Duration.millis(Math.min(30_000, 250 * 2 ** attempt))
/** How long to wait before trying again when Capy gave no `retry-after`. */
const RETRY_MS = 30_000

const TRY_AGAIN = "Try again."

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** A Problem with its chat-only steps left out and a next action: `next`, its own, or asking the person to fix it. */
export const actionable = (problem: Problem, next?: NextAction): ActionableProblem => ({
  ...outsideChat(problem),
  nextAction: next ?? problem.nextAction ?? { kind: "ask_human", say: `Ask the person to ${lowerFirst(problem.title)}. ${problem.detail}` }
})

const fail = (problem: ActionableProblem) => Effect.fail(new DelegateError({ problem }))

export const noKey = (keyFile: string, product: Product): ActionableProblem => ({
  title: "Add your Capy API key",
  detail: `${product.name} needs ${SHARED_KEY}, and found none.`,
  steps: [
    "Create a key in the Capy app under Settings, then API.",
    `Run \`${product.setup}\` in a terminal and paste the key (it goes to ${keyFile}). Or set \`CAPY_API_KEY\` in ${product.env}.`,
    TRY_AGAIN
  ],
  nextAction: {
    kind: "ask_human",
    say: `Ask the person to run \`${product.setup}\` in a terminal, or to set CAPY_API_KEY in ${product.env}.`
  }
})

export const badKey = (detail: string, product: Product): ActionableProblem => ({
  title: "Replace your Capy API key",
  detail: `Capy did not accept the API key (${detail}).`,
  steps: ["Create a new key in the Capy app under Settings, then API.", `Run \`${product.setup}\` and paste it.`, TRY_AGAIN],
  nextAction: {
    kind: "ask_human",
    say: `Ask the person to create a new Capy API key (Capy app, Settings, then API) and to run \`${product.setup}\` with it.`
  }
})

export const capyUnreachable = (apiUrl: string, detail: string, retryAfterMs = RETRY_MS): ActionableProblem => ({
  title: "Capy could not be reached",
  detail: `${detail}.`,
  steps: [`Check the network connection to ${apiUrl}.`, `Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`],
  nextAction: { kind: "retry", afterMs: retryAfterMs }
})

export const threadNotFound = (threadId: string, product: Product): ActionableProblem => ({
  title: "Check the thread id",
  detail: `Capy has no thread ${threadId} that this API key can see.`,
  steps: [`List recent threads (\`${product.threads}\`, or the list_threads tool) and use an id from there.`],
  nextAction: { kind: "run_command", command: product.threads }
})

const projectList = (projects: ReadonlyArray<ProjectSummary>) => projects.map((p) => `${p.name} (${p.id})`).join(", ")

export const projectNotFound = (name: string, projects: ReadonlyArray<ProjectSummary>): ActionableProblem => ({
  title: "Choose a Capy project",
  detail: `No Capy project has the id or name "${name}".`,
  steps: [
    projects.length === 0 ? "Create a project at https://capy.ai/settings/projects." : `Use one of these projects: ${projectList(projects)}.`,
    TRY_AGAIN
  ],
  nextAction: projects.length === 0
    ? { kind: "ask_human", say: "Ask the person to create a Capy project for this repository at https://capy.ai/settings/projects." }
    : { kind: "use_option", option: "project", why: `Use one of these projects: ${projectList(projects)}.` }
})

export const modelRejected = (detail: string): ActionableProblem => ({
  title: "Choose another model",
  detail: `Capy did not accept the model (${detail}).`,
  steps: ["Pick a model id from the list_models tool, or from https://capy.ai/settings/models. Or leave the model out to use the default.", TRY_AGAIN],
  nextAction: { kind: "use_option", option: "model", why: "Capy did not accept this model. Use an id from list_models, or leave model out." }
})

export const deviceNotFound = (deviceId: string, product: Product): ActionableProblem => ({
  title: "Check the Capy device id",
  detail: `Capy has no device ${deviceId} that this API key can use.`,
  steps: [
    `Run \`${product.doctor}\` on the computer that runs Capy (the desktop app or \`capy dock\`). It prints the device id.`,
    "Set `CAPY_DEVICE_ID` to that id, or pass it as the device option.",
    TRY_AGAIN
  ],
  nextAction: {
    kind: "ask_human",
    say: `Ask the person for the id of a Capy device that is running. \`${product.doctor}\` on that computer prints it.`
  }
})

/** A reasoning level belongs to a model. Without a model, Capy's default model runs at its own level. */
export const reasoningNeedsModel = (): ActionableProblem => ({
  title: "Pass a model with the reasoning level",
  detail: "A reasoning level belongs to a model, and no model was given.",
  steps: ["Pass model too (`--model` on the command line), with an id from list_models, or leave reasoning out to use the default model.", TRY_AGAIN],
  nextAction: { kind: "use_option", option: "model", why: "reasoning needs a model. Pass a model id from list_models, or leave reasoning out." }
})

export const machineSizeNeedsCloud = (): ActionableProblem => ({
  title: "Use a machine size only for a cloud thread",
  detail: "A machine size applies to Capy cloud machines, and this thread would run on a Capy device.",
  steps: ['Pass where "cloud" (`--where cloud`) to run on a cloud machine, or leave the machine size out.'],
  nextAction: { kind: "use_option", option: "where", why: 'machineSize needs where "cloud" (which costs machine credits). Or leave machineSize out.' }
})

const repoChoice = (project: ProjectSummary) => project.repos.map((r) => r.repoFullName).join(", ")

export const chooseRepo = (project: ProjectSummary, asked: string | undefined): ActionableProblem => ({
  title: "Choose a repository",
  detail: asked === undefined
    ? `The Capy project ${project.name} has ${project.repos.length} repositories, and the worktree needs one of them.`
    : `The Capy project ${project.name} does not include ${asked}.`,
  steps: [
    project.repos.length === 0
      ? `Add a repository to ${project.name} at https://capy.ai/settings/projects.`
      : `Pass repo as one of: ${repoChoice(project)}.`,
    TRY_AGAIN
  ],
  nextAction: project.repos.length === 0
    ? { kind: "ask_human", say: `Ask the person to add the repository to the Capy project ${project.name} at https://capy.ai/settings/projects.` }
    : { kind: "use_option", option: "repo", why: `Use one of: ${repoChoice(project)}.` }
})

export const chooseProject = (projects: ReadonlyArray<ProjectSummary>, cause: Problem): ActionableProblem => ({
  title: "Choose a Capy project",
  detail: `${cause.detail} A thread that does not run in a linked folder needs a Capy project.`,
  steps: [
    projects.length === 0 ? "Create a project at https://capy.ai/settings/projects." : `Pass project as one of: ${projectList(projects)}.`,
    TRY_AGAIN
  ],
  nextAction: projects.length === 0
    ? { kind: "ask_human", say: "Ask the person to create a Capy project for this repository at https://capy.ai/settings/projects." }
    : { kind: "use_option", option: "project", why: `Use one of these projects: ${projectList(projects)}.` }
})

/** Capy answered with something this version cannot read, such as a thread status that is new. */
export const updateNeeded = (detail: string, product: Product): ActionableProblem => ({
  title: `Update ${product.name}`,
  detail: `Capy sent a response that ${product.name} ${product.version} cannot read (${detail}). Trying again gives the same answer.`,
  steps: [
    `Run the newest ${product.name} with the same arguments: \`${product.latest}\`.${product.kind === "mcp" ? " Restart the MCP server with it." : ""}`,
    "If the newest version fails the same way, report it at https://github.com/yazcaleb/capy-acp/issues with the message above."
  ],
  nextAction: {
    kind: "ask_human",
    say: `Ask the person to update ${product.name} (\`${product.latest}\`) and restart it: Capy sent a response that this version cannot read.`
  }
})

/**
 * No folder was given, and the working folder (an MCP server often runs in `/` or the home folder) has
 * no repository that Capy can use. The caller can fix that itself.
 */
export const passFolder = (folder: string, cause: Problem, product: Product): ActionableProblem => ({
  title: "Pass the repository folder",
  detail: `${cause.detail} ${product.name} looked there because no folder was given.`,
  steps: ["Pass folder (`--folder` on the command line) as the absolute path of the repository you work in.", TRY_AGAIN],
  nextAction: {
    kind: "use_option",
    option: "folder",
    why: `${folder} is not a git repository with a GitHub remote. Pass the absolute path of the repository you are working in.`
  }
})

const CLOUD_OPTION =
  'Or run it on a Capy cloud machine: where "cloud" (`--where cloud` on the command line). Machine time there costs Capy credits.'

/**
 * No Capy device can run a worktree thread: neither this computer (with the folder's repository linked)
 * nor a device named by `CAPY_DEVICE_ID` or the device option. Lists the three ways out; never picks the cloud.
 */
export const noDeviceTarget = (cause: Problem, product: Product): ActionableProblem => {
  const local = actionable(cause)
  return {
    title: "Choose where Capy runs this thread",
    detail: `No Capy device can run it. On this computer: ${local.detail}`,
    steps: [
      `Run Capy on this computer with this folder linked. ${local.steps.join(" ")}`.trim(),
      `Or use a Capy device on another computer: set \`CAPY_DEVICE_ID\` (or pass the device option) to its id, which \`${product.doctor}\` prints on that computer, and pass project (and repo when the project has several repositories).`,
      CLOUD_OPTION
    ],
    nextAction: {
      kind: "ask_human",
      say:
        "Ask the person where Capy should run this: " +
        (cause.title === NO_DEVICE_TITLE
          ? `set up Capy on this computer by running \`${product.setup}\` in a terminal in this folder, `
          : "link this folder in Capy on this computer, ") +
        'give a Capy device id and project, or allow a Capy cloud machine (where "cloud"), which costs Capy credits.'
    }
  }
}

/** The Problem for any failure: Capy's own errors, setup problems, or something unexpected. */
export const toProblem = (config: AdapterConfig, error: unknown, context: { readonly threadId?: string; readonly deviceId?: string } = {}): ActionableProblem => {
  if (error instanceof DelegateError) return error.problem
  const known = problemOf(error)
  if (known !== undefined) return actionable(known)
  if (!isCapyError(error)) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      title: `${config.product.name} hit an unexpected error`,
      detail,
      steps: [TRY_AGAIN],
      nextAction: { kind: "ask_human", say: `Tell the person that ${config.product.name} failed: ${detail}` }
    }
  }
  if (error._tag === "CapyConfigError") return noKey(config.apiKeyFile, config.product)
  if (error._tag === "CapyTransportError" && error.decode === true) return updateNeeded(describeError(error), config.product)
  if (error._tag === "CapyTransportError" || isTransient(error)) {
    const after = error._tag === "CapyApiError" ? error.retryAfterMs : undefined
    return capyUnreachable(config.apiUrl, describeError(error), after ?? RETRY_MS)
  }
  if (error.status === 401) return badKey(describeError(error), config.product)
  if (error.tag === "capy/ThreadNotFound" && context.threadId !== undefined) return threadNotFound(context.threadId, config.product)
  if (error.tag === "ModelSelection.Rejected") return modelRejected(error.message)
  if (context.deviceId !== undefined && /device not found/i.test(error.message)) return deviceNotFound(context.deviceId, config.product)
  return {
    title: "Capy refused the request",
    detail: `${describeError(error)}.`,
    steps: ["Check the request against the message above.", TRY_AGAIN],
    nextAction: { kind: "ask_human", say: `Tell the person that Capy refused the request: ${describeError(error)}.` }
  }
}

/** The Capy web app's origin, for links. Known only for Capy's own API host. */
export const webOrigin = (apiUrl: string): string | undefined => {
  try {
    return new URL(apiUrl).hostname === "api.capy.ai" ? "https://capy.ai" : undefined
  } catch {
    return undefined
  }
}

/**
 * The desktop app's share and "Copy link" give `<web origin>/thread/<thread id>`, with the web origin
 * `https://capy.ai` for the API at `https://api.capy.ai` (checked in the Linux desktop bundle 0.6.0).
 */
export const threadUrl = (origin: string | undefined, threadId: string): string | undefined =>
  origin === undefined ? undefined : `${origin}/thread/${encodeURIComponent(threadId)}`

const CLOUD_COST = "Machine time costs Capy credits, even when the model runs on your subscription."

/** Where a thread this process started runs, for its reports. */
export interface Target {
  readonly where: Where
  readonly deviceId: string | undefined
  /** One sentence for the report. */
  readonly note: string
}

export const capReply = (text: string): string =>
  text.length <= MAX_REPLY
    ? text
    : `${text.slice(0, MAX_REPLY)}\n\n[Cut here: the reply has ${text.length - MAX_REPLY} more characters. Read the whole reply in Capy.]`

const PR_LINKS = [
  /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g,
  /https:\/\/capy\.ai\/pull\/([\w.-]+)\/([\w.-]+)\/(\d+)/g
]

/** Pull requests that Capy's replies link to, first mention first. */
export const pullRequestLinks = (messages: ReadonlyArray<Message>): ReadonlyArray<PullRequestLink> => {
  const found = new Map<string, PullRequestLink>()
  for (const message of messages) {
    if (message.source !== "assistant" || message.text === undefined) continue
    const hits = PR_LINKS.flatMap((pattern) => [...message.text!.matchAll(pattern)])
      .sort((a, b) => a.index - b.index)
    for (const [, owner, repo, number] of hits) {
      const name = `${owner}/${repo}`
      const key = `${name.toLowerCase()}#${number}`
      if (!found.has(key)) found.set(key, { url: `https://github.com/${name}/pull/${number}`, repo: name, number: Number(number) })
    }
  }
  return [...found.values()]
}

export const threadUsage = (thread: Thread): ThreadUsage | undefined =>
  thread.usage === undefined
    ? undefined
    : {
        totalCredits: thread.usage.totalCredits,
        llmCredits: thread.usage.llmCredits,
        vmCredits: thread.usage.vmCredits,
        imageCredits: thread.usage.imageCredits,
        cost: formatCredits(thread.usage.totalCredits)
      }

const needsPerson = (thread: Thread) => thread.ask != null || thread.needsYou === true

/** A thread and its transcript as one report. Pure. */
export const threadReport = (
  thread: Thread,
  messages: ReadonlyArray<Message>,
  context: { readonly target: Target | undefined; readonly origin: string | undefined }
): ThreadReport => {
  const reply = messages.findLast((m) => m.source === "assistant" && (m.text ?? "").trim() !== "")?.text?.trim()
  return {
    id: thread.id,
    title: thread.title ?? undefined,
    status: thread.status,
    where: context.target?.where,
    deviceId: context.target?.deviceId,
    projectId: thread.projectId ?? undefined,
    model: thread.lastModelId ?? undefined,
    lastReply: reply === undefined ? undefined : capReply(reply),
    pullRequests: pullRequestLinks(messages),
    asks: thread.ask == null ? [] : [{ kind: thread.ask.kind, text: thread.ask.text ?? undefined }],
    needsYou: needsPerson(thread),
    usage: threadUsage(thread),
    url: threadUrl(context.origin, thread.id),
    note: context.target?.note
  }
}

export const threadRow = (thread: Thread, projectName: string | undefined, origin: string | undefined): ThreadRow => ({
  id: thread.id,
  title: thread.title ?? undefined,
  status: thread.status,
  projectId: thread.projectId ?? undefined,
  projectName,
  model: thread.lastModelId ?? undefined,
  lastActivityAt: thread.lastActivityAt ?? thread.updatedAt ?? thread.createdAt ?? undefined,
  needsYou: needsPerson(thread),
  url: threadUrl(origin, thread.id)
})

const STATUS_LINES: Record<ThreadStatus, string> = {
  working: "Capy is working",
  waiting: "Capy is waiting",
  idle: "Capy is done",
  failed: "Capy reported that the run failed",
  archived: "The thread is archived"
}

/**
 * The activity lines for one stream event: reply text as it streams, finished tool calls, subagents
 * and status changes. Capy sends no command lines or paths, so a tool shows as its summary (Haiku) or
 * as the tools it ran ("ran bash, write (1.6 s)"). Pure.
 */
export const activityOf = (before: TurnState, event: CapyEvent, result: Step): ReadonlyArray<Activity> => {
  const out: Array<Activity> = []
  // A fresh connection can read `idle` before Capy picks the message up, so `idle` shows only after work.
  if (event._tag === "Status" && event.status !== before.status && (event.status !== "idle" || before.active)) {
    out.push({ kind: "activity", text: STATUS_LINES[event.status] })
  }
  for (const update of result.updates) {
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text" && update.content.text !== "") out.push({ kind: "reply", text: update.content.text })
      continue
    }
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") continue
    const title = update.title ?? result.state.tools.get(update.toolCallId)?.title ?? "a tool call"
    if (update.toolCallId.startsWith(subagentCallId(""))) {
      const verb = update.status === "completed" ? "finished" : update.status === "failed" ? "failed" : update.status === "in_progress" ? "started" : undefined
      if (verb !== undefined) out.push({ kind: "activity", text: `${title} ${verb}` })
    } else if (update.status === "completed") {
      out.push({ kind: "activity", text: `ran ${title}` })
    } else if (update.status === "failed") {
      out.push({ kind: "activity", text: `stopped: ${title}` })
    }
  }
  return out
}

/** The reasoning level to send: the default when the model offers it, else the model's highest. */
const effectiveReasoning = (reasoning: string, modes: ReadonlyArray<string>): string | undefined =>
  modes.includes(reasoning) ? reasoning : modes.at(-1)

/** Capy's answer when a linked root is not (or no longer) linked to this device. */
const isNotLinked = (error: CapyError) => error._tag === "CapyApiError" && /does not link a folder/i.test(error.message)

interface Placement {
  readonly projectId: string
  readonly target: Target
  readonly device: CreateThread["device"]
  readonly machineSize: MachineSize | undefined
  /** What to show if Capy refuses the linked root. */
  readonly notLinked: Problem | undefined
}

/** A worktree thread on a device that makes the worktree itself, with no folder on this computer. */
const remoteWorktree = (deviceId: string, projectId: string, repo: string): Placement => ({
  projectId,
  target: {
    where: "worktree",
    deviceId,
    note: `Capy works in a new git worktree of ${repo} on the Capy device ${deviceId}, started from the GitHub remote. Nothing on this computer changes.`
  },
  device: { deviceId, workspace: { kind: "worktree", repos: [repo], startFromOrigin: true } },
  machineSize: undefined,
  notLinked: undefined
})

const cloudPlacement = (projectId: string, machineSize: MachineSize | undefined): Placement => ({
  projectId,
  target: {
    where: "cloud",
    deviceId: undefined,
    note: `Capy runs this thread on a ${machineSize === undefined ? "cloud machine of the project's size" : `${machineSize} cloud machine`}. ${CLOUD_COST}`
  },
  device: undefined,
  machineSize,
  notLinked: undefined
})

/** The last message this process sent to a thread: its clientKey (none for a new thread's task), and when. */
interface Sent {
  readonly clientKey: string | undefined
  readonly at: number
}

/** Capy replied to the message: an assistant entry follows it (any assistant entry, for a new thread's task). */
const answered = (messages: ReadonlyArray<Message>, sent: Sent): boolean => {
  const mine = sent.clientKey === undefined ? 0 : messages.findIndex((m) => m.source === "user" && m.clientKey === sent.clientKey)
  return mine >= 0 && messages.slice(mine).some((m) => m.source === "assistant")
}

export const makeDelegate = (config: AdapterConfig) => {
  const origin = webOrigin(config.apiUrl)
  /** Threads this process started or messaged: where they run, and the last message it sent. */
  const known = new Map<string, { target?: Target | undefined; sent?: Sent | undefined }>()
  const remember = (threadId: string, entry: { target?: Target | undefined; sent?: Sent | undefined }) =>
    known.set(threadId, { ...known.get(threadId), ...entry })

  const problem = (context: { readonly threadId?: string; readonly deviceId?: string } = {}) => (error: unknown) =>
    new DelegateError({ problem: toProblem(config, error, context) })

  const findProject = (projects: ReadonlyArray<ProjectSummary>, name: string) =>
    Option.fromNullishOr(projects.find((p) => p.id === name) ?? projects.find((p) => p.name === name))

  const local = <A>(read: () => Promise<A>) => Effect.tryPromise({ try: read, catch: problem() })

  /**
   * Where a new thread runs, and its project. `worktree` and `auto` try this computer's device with the
   * folder's repository linked, then a configured device (`device`, else `CAPY_DEVICE_ID`) that makes
   * the worktree itself. Neither: a Problem that lists the ways out. Only `cloud` uses the cloud.
   */
  const place = (input: StartInput) =>
    Effect.gen(function*() {
      const capy = yield* CapyClient
      const folder = input.folder ?? process.cwd()
      const choice = input.where ?? "auto"
      if (input.machineSize !== undefined && choice !== "cloud") return yield* fail(machineSizeNeedsCloud())
      const projects = yield* capy.listProjects.pipe(Effect.mapError(problem()))
      let chosen: ProjectSummary | undefined
      if (input.project !== undefined) {
        const found = findProject(projects, input.project)
        if (Option.isNone(found)) return yield* fail(projectNotFound(input.project, projects))
        chosen = found.value
      }
      const scoped = chosen === undefined ? projects : [chosen]
      if (choice === "cloud" && chosen !== undefined) return cloudPlacement(chosen.id, input.machineSize)

      const git = yield* local(() => readGit(folder))
      // With no folder given, a working folder that is no repository is the caller's to fix: it names one.
      const defaultNotRepo = input.folder !== undefined
        ? undefined
        : git.gitRoot === undefined
        ? notGit(folder)
        : git.repos.length === 0
        ? noGitHubRemote(git.gitRoot)
        : undefined
      // The project and repository of the folder's GitHub remote. Nothing else on this computer is read.
      const fromRemote = () => resolveWorkspace({ cwd: folder, ...git, linked: [], projects: scoped, mode: "linked", allowWorktreeFallback: false })
      if (choice === "cloud") {
        const resolution = fromRemote()
        if (resolution._tag === "Unresolved") return yield* fail(chooseProject(projects, resolution.problem))
        return cloudPlacement(resolution.value.projectId, input.machineSize)
      }

      const device = yield* Effect.result(local(() => readDevice(config)))
      const linked = yield* local(() => readLinkedFolders(config))

      if (choice === "here") {
        // Edits the folder in place, as the ACP agent does.
        if (input.device === undefined && Result.isFailure(device)) return yield* fail(actionable(device.failure.problem))
        const deviceId = input.device ?? (Result.isSuccess(device) ? device.success.id : "")
        const kind = Result.isSuccess(device) && device.success.id === deviceId ? device.success.kind : undefined
        const resolution = resolveWorkspace({ cwd: folder, ...git, linked, projects: scoped, mode: "linked", allowWorktreeFallback: false, device: kind, product: config.product })
        if (resolution._tag === "Unresolved") {
          return yield* fail(defaultNotRepo === undefined ? actionable(resolution.problem) : passFolder(folder, defaultNotRepo, config.product))
        }
        const { projectId, workspace } = resolution.value
        const root = workspace.kind === "linked" ? workspace.root : folder
        return {
          projectId,
          target: { where: "here", deviceId, note: `Capy edits ${root} in place.` },
          device: { deviceId, workspace },
          machineSize: undefined,
          notLinked: resolution.value.notLinked
        } satisfies Placement
      }

      // 1. This computer's device, with a folder on it that Capy links for the repository.
      let cause: Problem
      if (Result.isFailure(device)) {
        cause = device.failure.problem
      } else if (input.device !== undefined && input.device !== device.success.id) {
        cause = { title: "Use the device you named", detail: `The device ${input.device} is not this computer's.`, steps: [] }
      } else {
        const resolution = resolveWorkspace({
          cwd: folder,
          ...git,
          linked,
          projects: scoped,
          mode: "worktree",
          allowWorktreeFallback: true,
          device: device.success.kind
        })
        if (resolution._tag === "Resolved") {
          return {
            projectId: resolution.value.projectId,
            target: {
              where: "worktree",
              deviceId: device.success.id,
              note: "Capy works in its own git worktree on this computer (under ~/.capy/worktrees by default), not in your folder."
            },
            device: { deviceId: device.success.id, workspace: { kind: "worktree" } },
            machineSize: undefined,
            notLinked: undefined
          } satisfies Placement
        }
        cause = resolution.problem
      }

      // 2. A configured device, which makes the worktree from the repository itself.
      const remoteId = input.device ?? config.deviceIdOverride
      if (remoteId === undefined) return yield* fail(defaultNotRepo === undefined ? noDeviceTarget(cause, config.product) : passFolder(folder, defaultNotRepo, config.product))
      let project = chosen
      let repo = input.repo?.toLowerCase()
      if (project === undefined) {
        const resolution = fromRemote()
        if (resolution._tag === "Unresolved") return yield* fail(chooseProject(projects, resolution.problem))
        project = projects.find((p) => p.id === resolution.value.projectId)!
        repo ??= resolution.value.repo
      }
      const names = project.repos.map((r) => r.repoFullName)
      // Without a named repository: the folder's, when the project has it, else the project's only one.
      repo ??= git.repos.find((r) => names.some((name) => name.toLowerCase() === r))
      const repoName = repo === undefined ? (names.length === 1 ? names[0] : undefined) : names.find((name) => name.toLowerCase() === repo)
      if (repoName === undefined) return yield* fail(chooseRepo(project, input.repo))
      return remoteWorktree(remoteId, project.id, repoName)
    })

  /**
   * The model to send. None given: none sent, so Capy picks the default of the key's owner (their own,
   * else the organization's). `config.defaultModel` is the ACP adapter's setting and does not apply here.
   */
  const modelFor = (input: StartInput): Effect.Effect<ModelSelection | undefined, DelegateError, CapyClient> =>
    Effect.gen(function*() {
      const modelId = input.model
      if (modelId === undefined) return input.reasoning === undefined ? undefined : yield* fail(reasoningNeedsModel())
      if (input.reasoning !== undefined) return { modelId, reasoningMode: input.reasoning }
      const models = yield* CapyClient.use((capy) => capy.listModels).pipe(Effect.orElseSucceed(() => []))
      const reasoningMode = effectiveReasoning(config.defaultReasoning, models.find((m) => m.id === modelId)?.reasoningModes ?? [])
      return reasoningMode === undefined ? { modelId } : { modelId, reasoningMode }
    })

  const report = (threadId: string): Effect.Effect<ThreadReport, DelegateError, CapyClient> =>
    Effect.gen(function*() {
      const capy = yield* CapyClient
      const [thread, messages] = yield* Effect.all([capy.getThread(threadId), capy.listMessages(threadId)], { concurrency: 2 })
      return threadReport(thread, messages, { target: known.get(threadId)?.target, origin })
    }).pipe(Effect.mapError(problem({ threadId })))

  /** Starts a thread and returns at once; `wait` follows it. */
  const start = (input: StartInput): Effect.Effect<ThreadReport, DelegateError, CapyClient> =>
    Effect.gen(function*() {
      const capy = yield* CapyClient
      const placement = yield* place(input)
      const model = yield* modelFor(input)
      const deviceId = placement.device?.deviceId
      // One requestId for the whole call, so a retried create never makes a second thread.
      const thread = yield* capy.createThread({
        requestId: randomUUID(),
        projectId: placement.projectId,
        title: input.title ?? titleOf(input.task),
        message: input.task,
        ...(model === undefined ? {} : { model }),
        ...(placement.device === undefined ? {} : { device: placement.device }),
        ...(placement.machineSize === undefined ? {} : { machineSize: placement.machineSize })
      }).pipe(
        Effect.mapError((error) =>
          placement.notLinked !== undefined && isNotLinked(error)
            ? new DelegateError({ problem: actionable(placement.notLinked) })
            : problem(deviceId === undefined ? {} : { deviceId })(error)
        )
      )
      remember(thread.id, { target: placement.target, sent: { clientKey: undefined, at: yield* Clock.currentTimeMillis } })
      return threadReport(thread, [], { target: placement.target, origin })
    })

  /**
   * Sends a message. By default it waits in the queue behind the current run; `interrupt` stops the run
   * first. Once Capy has the message, a failed read of the thread is no error: an error invites a resend,
   * which would deliver the message twice. The report then says so, with the status `working`.
   */
  const send = (threadId: string, text: string, options: { readonly interrupt?: boolean | undefined } = {}) =>
    Effect.gen(function*() {
      const capy = yield* CapyClient
      const clientKey = randomUUID()
      yield* capy.sendMessage(threadId, { text, clientKey, delivery: options.interrupt === true ? "interrupt" : "queue" }).pipe(
        Effect.mapError(problem({ threadId }))
      )
      remember(threadId, { sent: { clientKey, at: yield* Clock.currentTimeMillis } })
      return yield* report(threadId).pipe(
        Effect.catch((error) => {
          const target = known.get(threadId)?.target
          const unread = `Capy has the message, but ${config.product.name} could not read the thread afterwards (${error.problem.title}: ${error.problem.detail.replace(/\.$/, "")}). ` +
            "Do not send the message again; follow the thread for the reply."
          return Effect.succeed<ThreadReport>({
            ...threadReport({ id: threadId, status: "working" }, [], { target, origin }),
            note: target === undefined ? unread : `${target.note} ${unread}`
          })
        })
      )
    })

  /** Interrupts the current run. The thread keeps its transcript and takes new messages. */
  const stop = (threadId: string) =>
    Effect.gen(function*() {
      const capy = yield* CapyClient
      yield* capy.interrupt(threadId).pipe(Effect.mapError(problem({ threadId })))
      return yield* report(threadId)
    })

  /**
   * Recent threads, newest first: of `project`, else of the folder's project when `folder` names one,
   * else of every project.
   */
  const list = (options: { readonly project?: string | undefined; readonly folder?: string | undefined; readonly limit?: number | undefined } = {}) =>
    Effect.gen(function*() {
      const capy = yield* CapyClient
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)))
      const projects = yield* capy.listProjects.pipe(Effect.mapError(problem()))
      let scoped: ReadonlyArray<ProjectSummary> = projects
      if (options.project !== undefined) {
        const chosen = findProject(projects, options.project)
        if (Option.isNone(chosen)) return yield* fail(projectNotFound(options.project, projects))
        scoped = [chosen.value]
      } else if (options.folder !== undefined) {
        const git = yield* local(() => readGit(options.folder!))
        const resolution = resolveWorkspace({ cwd: options.folder, ...git, linked: [], projects, mode: "linked", allowWorktreeFallback: false })
        if (resolution._tag === "Resolved") scoped = projects.filter((p) => p.id === resolution.value.projectId)
      }
      const pages = yield* Effect.forEach(
        scoped,
        (project) => capy.listThreads(project.id, { limit }).pipe(Effect.map((threads) => threads.map((t) => threadRow(t, project.name, origin)))),
        { concurrency: 4 }
      ).pipe(Effect.mapError(problem()))
      return pages
        .flat()
        .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))
        .slice(0, limit)
    })

  /**
   * Follows the thread until its run settles: done, failed, archived, or waiting on a person. A thread
   * that waits on a background command is followed until it wakes. The timeout ends the wait, never the thread.
   */
  const wait = (threadId: string, options: WaitOptions): Effect.Effect<WaitResult, DelegateError, CapyClient> =>
    Effect.gen(function*() {
      const capy = yield* CapyClient
      const emit = (activity: Activity): Effect.Effect<void> => {
        const result = options.onActivity?.(activity)
        return Effect.isEffect(result) ? result : Effect.void
      }
      const messages = yield* capy.listMessages(threadId).pipe(Effect.mapError(problem({ threadId })))
      // Resume after the newest committed reply, so the history is not shown again. User and assistant
      // entries carry their stream event id as their id; tool entries do not.
      const cursor = messages.findLast((m) => m.source !== "tool" && EVENT_ID.test(m.id))?.id
      const sent = known.get(threadId)?.sent
      const now = yield* Clock.currentTimeMillis
      // A message that went out moments ago and has no reply yet, or a thread with no entries yet, has
      // not been picked up: an `idle` before Capy starts on it does not end the wait, for up to PICKUP_MS.
      const pickupBy = messages.length === 0
        ? now + PICKUP_MS
        : sent !== undefined && now - sent.at < PICKUP_MS && !answered(messages, sent)
        ? sent.at + PICKUP_MS
        : undefined

      let state: TurnState = initialTurn(cursor)
      let received = 0
      let failures = 0
      let emptyReads = 0
      let idleRechecks = 0
      let notStarted = false

      const apply = (event: CapyEvent): Effect.Effect<TurnSignal | undefined> =>
        Effect.gen(function*() {
          if (event._tag !== "Heartbeat") received++
          const before = state
          const result = step(state, event)
          state = result.state
          yield* Effect.forEach(activityOf(before, event, result), emit, { discard: true })
          return result.signal
        })

      // An `until=run` read goes on until the server closes it, since replies can commit after `idle`.
      // A live read (while the thread waits on a background command) stops at the next settled state.
      const readOnce = (live: boolean): Effect.Effect<void, CapyError> => {
        let endedAt: number | undefined
        return capy.stream(threadId, { cursor: state.cursor, untilRun: !live }).pipe(
          Stream.mapEffect(apply),
          Stream.takeUntil((signal) => {
            if (signal?._tag === "Ended") endedAt ??= Date.now()
            if (signal?._tag === "Failed" || signal?._tag === "Archived") return true
            if (live) return signal !== undefined && signal._tag !== "Waiting"
            return endedAt !== undefined && Date.now() - endedAt > END_GRACE_MS
          }),
          Stream.runDrain
        )
      }

      const recover = (error: CapyError): Effect.Effect<void, DelegateError> => {
        // A cursor Capy no longer accepts would fail every read; reading without one repeats some lines.
        const badCursor = error._tag === "CapyApiError" && error.status === 400 && /cursor/i.test(error.message)
        if (badCursor && state.cursor !== undefined) {
          state = { ...state, cursor: undefined }
          return Effect.void
        }
        if (!isTransient(error) || ++failures > MAX_FAILURES) return Effect.fail(problem({ threadId })(error))
        return Effect.sleep(backoff(failures))
      }

      const follow: Effect.Effect<void, DelegateError> = Effect.gen(function*() {
        let live = false
        for (;;) {
          const seen = received
          const read = yield* Effect.result(readOnce(live))
          if (received > seen) failures = 0
          if (Result.isFailure(read)) {
            yield* recover(read.failure)
            continue
          }
          // The connection closed (run ended, `done`, or a drop): ask the thread where it stands.
          const checked = yield* Effect.result(capy.getThread(threadId))
          if (Result.isFailure(checked)) {
            yield* recover(checked.failure)
            continue
          }
          const thread = checked.success
          live = false
          switch (thread.status) {
            case "failed":
            case "archived":
              return
            case "idle":
              if (state.active) {
                if (turnComplete(state)) return
                // A reply has not committed yet: read again from the cursor, a few times.
                if (++idleRechecks > MAX_IDLE_RECHECKS) return
                yield* Effect.sleep(Duration.seconds(1))
                break
              }
              if (pickupBy === undefined) return
              // Not picked up yet: look again until PICKUP_MS has passed, unless the reply came unseen.
              if ((yield* Clock.currentTimeMillis) >= pickupBy) {
                const latest = yield* Effect.result(capy.listMessages(threadId))
                notStarted = !(Result.isSuccess(latest) && sent !== undefined && answered(latest.success, sent))
                return
              }
              yield* Effect.sleep(backoff(Math.min(++idleRechecks, 3)))
              break
            case "waiting":
              if (needsPerson(thread)) return
              // A background command: hold a live stream open until the thread wakes.
              live = true
            // falls through
            case "working":
              // Still busy, but the stream closed with nothing new (or sent an error frame): don't spin.
              emptyReads = received > seen ? 0 : emptyReads + 1
              if (emptyReads > 0) yield* Effect.sleep(backoff(Math.min(emptyReads, 4)))
              break
          }
        }
      })

      const finished = yield* follow.pipe(Effect.timeoutOption(Duration.millis(Math.max(0, options.timeoutMs))))
      if (state.active) remember(threadId, { sent: undefined })
      const result = yield* report(threadId)
      return notStarted
        ? { ...result, lastReply: undefined, timedOut: false, notStarted }
        : { ...result, timedOut: Option.isNone(finished), notStarted }
    })

  return { start, report, wait, send, stop, list }
}

export type Delegate = ReturnType<typeof makeDelegate>

export type Outcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly problem: ActionableProblem }

/** Settles an operation: its value, or the Problem for any failure or defect, never a stack trace. */
export const settle = <A>(config: AdapterConfig, operation: Effect.Effect<A, DelegateError, CapyClient>): Effect.Effect<Outcome<A>, never, CapyClient> =>
  operation.pipe(
    Effect.map((value): Outcome<A> => ({ ok: true, value })),
    Effect.catchCause((cause) =>
      Effect.succeed<Outcome<A>>({ ok: false, problem: toProblem(config, Cause.squash(cause)) })
    )
  )

/**
 * Runs one operation against the Capy API. An aborted `signal` stops the operation (a wait, never the
 * thread), and the promise then rejects.
 */
export const runOperation = <A>(
  config: AdapterConfig,
  operation: Effect.Effect<A, DelegateError, CapyClient>,
  options: { readonly signal?: AbortSignal | undefined } = {}
): Promise<Outcome<A>> =>
  Effect.runPromise(settle(config, operation).pipe(Effect.provide(capyLayer(config))), options.signal === undefined ? undefined : { signal: options.signal })
