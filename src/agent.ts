/**
 * The ACP agent: maps ACP sessions to Capy threads on this machine's Capy device, or on Capy cloud
 * machines with `CAPY_ACP_WORKSPACE=cloud`.
 *
 * One ACP session is one Capy thread, created on the first prompt (Capy needs the first message
 * to create a thread). The session → thread mapping is saved (store.ts), so `session/load` (which
 * replays the transcript) and `session/resume` (which does not) continue the same thread after a
 * restart. Handlers are thin: they run Effects on a ManagedRuntime that holds the Capy client, and
 * every Capy failure becomes a JSON-RPC error with Capy's own message.
 */
import { randomUUID } from "node:crypto"
import * as acp from "@agentclientprotocol/sdk"
import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk"
import { Cause, Deferred, Effect, Exit, type Layer, ManagedRuntime } from "effect"
import { CapyClient, type CapyError, describeError, isCapyError, type Model, layer as capyLayer } from "./capy/client.js"
import type { Message } from "./capy/events.js"
import { type ChangeTracker, makeChangeTracker, makeWorktreeTracker } from "./changes.js"
import type { AdapterConfig } from "./config.js"
import { pullRequestLinks } from "./delegate.js"
import { fetchPrices, formatCredits, modelDescription, modelLabel, type Price } from "./pricing.js"
import { noApiKey, type Problem, problemOf, rejectedApiKey, toMarkdown, unreachable } from "./problems.js"
import { promptParts } from "./prompt.js"
import { API_KEY_AUTH, savedApiKey } from "./setup.js"
import { makeSessionStore, type SessionRecord } from "./store.js"
import { history } from "./translate.js"
import { fileLink, runTurn, titleOf } from "./turn.js"
import { AGENT_NAME, AGENT_VERSION } from "./version.js"
import {
  type CloudWorkspace,
  type DeviceWorkspace,
  readDevice,
  readGit,
  readLinkedFolders,
  resolveCloud,
  resolveWorkspace,
  type ResolvedWorkspace
} from "./workspace.js"

/** Where a session's threads run. Replaced as a whole when a prompt re-checks the folder. */
interface Setup {
  /** Undefined when the folder cannot run Capy threads; `problem` then says why and how to fix it. */
  resolved: ResolvedWorkspace<DeviceWorkspace | CloudWorkspace> | undefined
  problem: Problem | undefined
  /** Empty for a cloud session, which has no device. */
  deviceId: string
  /** Watches the folder the thread works in, so the adapter can show the diffs. */
  changes: ChangeTracker | undefined
}

interface SessionState extends Setup {
  readonly cwd: string
  threadId: string | undefined
  cursor: string | undefined
  model: string
  reasoning: string
  title: string | undefined
  noteShown: boolean
  busy: boolean
  /** Set by `session/close` while a prompt still runs; the prompt removes the session when it settles. */
  closed: boolean
  cancel: Deferred.Deferred<void> | undefined
  /** The thread's `usage.totalCredits` after the last turn, to report what each turn added. */
  credits: number | undefined
  /** The pull request or branch note last shown, so a cloud session shows each one once. */
  delivered: string | undefined
}

/** A Capy stream event id (a ULID), the only thing a stream cursor may be. */
const EVENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

const log = (message: string) => process.stderr.write(`[capy-acp] ${message}\n`)

/** Capy's answer when a linked root is not (or no longer) linked to this device. */
const isNotLinked = (error: CapyError) => error._tag === "CapyApiError" && /does not link a folder/i.test(error.message)

/** The reasoning level a session really sends: its own when the model offers it, else the model's highest. */
const effectiveReasoning = (reasoning: string, modes: ReadonlyArray<string>): string | undefined =>
  modes.includes(reasoning) ? reasoning : modes.at(-1)

/** GitHub links that exist only for a pushed branch: a compare (its head), or a new pull request. */
const BRANCH_LINK = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:compare\/\S+?\.\.\.|pull\/new\/)([^\s)\]>`'"#?]+)/g
/** A tree link, which counts only in a line that says something was pushed (it can name any file). */
const TREE_LINK = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/tree\/([^\s)\]>`'"#?]+)/g
/** A branch named in a line that says it was pushed: "Pushed the branch `capy/fix-login`". */
const PUSHED_BRANCH = /\bbranch\s+`([^`\s]+)`/gi

/**
 * Branches that Capy's replies say it pushed, first mention first, as `[repo, branch]`. The stream never
 * shows git commands, so the replies are the only record. `repo` is the session's, for branches named
 * without a link.
 */
export const pushedBranches = (messages: ReadonlyArray<Message>, repo: string): ReadonlyArray<readonly [string, string]> => {
  const found = new Map<string, readonly [string, string]>()
  const add = (owner: string, branch: string) => {
    const name = branch.replace(/[.,;:!]+$/, "")
    if (name !== "" && !found.has(`${owner.toLowerCase()}#${name}`)) found.set(`${owner.toLowerCase()}#${name}`, [owner, name])
  }
  for (const message of messages) {
    if (message.source !== "assistant" || message.text === undefined) continue
    for (const line of message.text.split("\n")) {
      const pushed = /\bpush/i.test(line)
      const links = [...line.matchAll(BRANCH_LINK), ...(pushed ? line.matchAll(TREE_LINK) : [])].sort((a, b) => a.index - b.index)
      for (const [, owner, branch] of links) add(owner!, branch!)
      if (links.length === 0 && pushed) for (const [, branch] of line.matchAll(PUSHED_BRANCH)) add(repo, branch!)
    }
  }
  return [...found.values()]
}

/**
 * What a cloud thread left on GitHub, in one line for the end of a reply: its pull requests, else the
 * branches it pushed. Undefined when there is neither. The files stay on Capy's machine, so this is how
 * the user gets the work.
 */
export const deliveryNote = (messages: ReadonlyArray<Message>, repo: string): string | undefined => {
  const pulls = pullRequestLinks(messages)
  if (pulls.length > 0) return `Pull request${pulls.length === 1 ? "" : "s"}: ${pulls.map((p) => p.url).join(", ")}`
  const branches = pushedBranches(messages, repo)
  if (branches.length === 0) return undefined
  return branches
    .map(([owner, branch]) => {
      const fetch = owner.toLowerCase() === repo.toLowerCase() ? ` Get it with \`git fetch origin ${branch}\`.` : ""
      return `Capy pushed the branch \`${branch}\`: https://github.com/${owner}/tree/${branch}.${fetch}`
    })
    .join("\n")
}

export const makeAgent = (config: AdapterConfig, capy: Layer.Layer<CapyClient> = capyLayer(config)) => {
  const runtime = ManagedRuntime.make(capy)
  const sessions = new Map<string, SessionState>()
  const store = makeSessionStore(config.stateDir)
  let models: ReadonlyArray<Model> | undefined
  let prices: Promise<ReadonlyMap<string, Price>> | undefined

  /** Saves the session → thread mapping. A failed write costs only resumability, so it is logged. */
  const persist = async (sessionId: string, session: SessionState) => {
    if (session.threadId === undefined) return
    const record: SessionRecord = {
      sessionId,
      cwd: session.cwd,
      threadId: session.threadId,
      ...(session.cursor === undefined ? {} : { cursor: session.cursor }),
      model: session.model,
      reasoning: session.reasoning,
      ...(session.title === undefined ? {} : { title: session.title }),
      updatedAt: new Date().toISOString()
    }
    await store.save(record).catch((error: unknown) => log(`could not save session ${sessionId}: ${String(error)}`))
  }

  /** Runs an Effect, converting a typed Capy failure into a JSON-RPC error the client can show. */
  const run = async <A>(effect: Effect.Effect<A, CapyError, CapyClient>): Promise<A> => {
    const exit = await runtime.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    const failure = exit.cause.reasons.find(Cause.isFailReason)
    if (failure !== undefined) {
      const error = failure.error
      const message = "_tag" in error ? describeError(error as CapyError) : String(error)
      log(message)
      throw acp.RequestError.internalError(undefined, message)
    }
    log(Cause.pretty(exit.cause))
    throw acp.RequestError.internalError(undefined, "capy-acp hit an unexpected error; see its stderr log.")
  }

  const withCapy = <A>(f: (capy: CapyClient["Service"]) => Effect.Effect<A, CapyError>) =>
    Effect.gen(function*() {
      return yield* f(yield* CapyClient)
    })

  const loadPrices = () =>
    (prices ??= config.pricingUrl === ""
      ? Promise.resolve(new Map())
      : fetchPrices(config.pricingUrl).catch((error: unknown) => {
          log(`no model prices: ${error instanceof Error ? error.message : String(error)}`)
          return new Map()
        }))

  const loadModels = async (): Promise<ReadonlyArray<Model>> => {
    if (models === undefined) {
      void loadPrices()
      models = await run(withCapy((capy) => capy.listModels))
    }
    return models
  }

  /**
   * Shows what the turn added to the thread's Capy credits, as an ACP notice. Turns on a subscription
   * add nothing and show nothing. Capy can book a turn's credits late; they then show after the next turn.
   */
  const reportCredits = async (session: SessionState, notify: (update: SessionUpdate) => Promise<unknown>) => {
    const before = session.credits
    const usage = await readCredits(session.threadId!)
    if (usage === undefined) return
    session.credits = usage.totalCredits
    if (before === undefined || usage.totalCredits <= before) return
    const parts = [
      ["models", usage.llmCredits],
      ["machines", usage.vmCredits],
      ["images", usage.imageCredits]
    ].flatMap(([name, credits]) => (typeof credits === "number" && credits > 0 ? [`${name} ${formatCredits(credits)}`] : []))
    await notify({
      sessionUpdate: "notice",
      severity: "info",
      title: `Capy credits: ${formatCredits(usage.totalCredits - before)}`,
      description: `This thread has used ${formatCredits(usage.totalCredits)} of Capy credits${parts.length > 1 ? ` (${parts.join(", ")})` : ""}.`
    })
  }

  /**
   * Ends a cloud session's reply with the pull requests or branches its thread left on GitHub, the first
   * time each set shows up. Never fails the prompt: without the transcript, nothing is shown.
   */
  const reportDelivery = async (session: SessionState, repo: string, say: (text: string) => Promise<unknown>) => {
    const exit = await runtime.runPromiseExit(withCapy((capy) => capy.listMessages(session.threadId!)))
    const note = Exit.isSuccess(exit) ? deliveryNote(exit.value, repo) : undefined
    if (note === undefined || note === session.delivered) return
    session.delivered = note
    await say(`\n\n${note}`)
  }

  /** The thread's credit total, or undefined when Capy does not answer. Never fails the prompt. */
  const readCredits = async (threadId: string) => {
    const exit = await runtime.runPromiseExit(withCapy((capy) => capy.getThread(threadId)))
    return Exit.isSuccess(exit) ? exit.value.usage : undefined
  }

  const configOptions = (
    session: SessionState,
    available: ReadonlyArray<Model>,
    priced: ReadonlyMap<string, Price>
  ): Array<SessionConfigOption> => {
    const current = available.find((m) => m.id === session.model)
    const modes = current?.reasoningModes ?? []
    const options: Array<SessionConfigOption> = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: session.model,
        options: (current === undefined ? [{ id: session.model, name: session.model } as Model, ...available] : available).map(
          (m) => {
            const description = modelDescription(m, priced.get(m.id))
            return { value: m.id, name: modelLabel(m, priced.get(m.id)), ...(description === undefined ? {} : { description }) }
          }
        )
      }
    ]
    if (modes.length > 0) {
      options.push({
        id: "reasoning",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: effectiveReasoning(session.reasoning, modes) ?? session.reasoning,
        options: modes.map((mode) => ({ value: mode, name: mode }))
      })
    }
    return options
  }

  /** Runs a Capy call for setup, turning any failure into a sentence for the user. */
  const attempt = async <A>(effect: Effect.Effect<A, CapyError, CapyClient>): Promise<A> => {
    const exit = await runtime.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) return exit.value
    const failure = exit.cause.reasons.find(Cause.isFailReason)
    throw failure === undefined ? new Error(Cause.pretty(exit.cause)) : failure.error
  }

  /** The fix for a failed setup step: a missing or rejected key, no network, no device. */
  const setupProblem = (reason: unknown): Problem => {
    const known = problemOf(reason)
    if (known !== undefined) return known
    if (isCapyError(reason)) {
      if (reason._tag === "CapyConfigError") return noApiKey(config.apiKeyFile)
      if (reason._tag === "CapyApiError" && (reason.status === 401 || reason.status === 403)) return rejectedApiKey(describeError(reason))
      return unreachable(config.apiUrl, describeError(reason))
    }
    return { title: "capy-acp could not start", detail: reason instanceof Error ? reason.message : String(reason), steps: ["Send your message again."] }
  }

  /** Folder → project → device workspace. Never throws: failures become the session's `problem`. */
  const setUp = async (cwd: string, threadId: () => string | undefined): Promise<Setup> => {
    if (config.workspaceMode === "cloud") {
      // A cloud machine clones the repository itself: no device, no linked folder, no diffs to read.
      const projects = await attempt(withCapy((capy) => capy.listProjects)).then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason })
      )
      if (!projects.ok) return { deviceId: "", resolved: undefined, problem: setupProblem(projects.reason), changes: undefined }
      const resolution = resolveCloud({ cwd, ...(await readGit(cwd)), projects: projects.value })
      return resolution._tag === "Unresolved"
        ? { deviceId: "", resolved: undefined, problem: resolution.problem, changes: undefined }
        : { deviceId: "", resolved: resolution.value, problem: undefined, changes: undefined }
    }
    const [projects, device, linked, git] = await Promise.allSettled([
      attempt(withCapy((capy) => capy.listProjects)),
      readDevice(config),
      readLinkedFolders(config),
      readGit(cwd)
    ])
    // Reported in this order: the API key first, then the paired device, since nothing else can be
    // fixed without them. (Folder and git reads never reject.)
    if (projects.status === "rejected" || device.status === "rejected" || linked.status === "rejected" || git.status === "rejected") {
      const reason: unknown = [projects, device, linked, git].flatMap((r) => (r.status === "rejected" ? [r.reason] : []))[0]
      return { deviceId: "", resolved: undefined, problem: setupProblem(reason), changes: undefined }
    }
    const resolution = resolveWorkspace({
      cwd,
      ...git.value,
      linked: linked.value,
      projects: projects.value,
      mode: config.workspaceMode,
      allowWorktreeFallback: config.allowWorktreeFallback,
      device: device.value.kind
    })
    if (resolution._tag === "Unresolved") return { deviceId: device.value.id, resolved: undefined, problem: resolution.problem, changes: undefined }
    const workspace = resolution.value.workspace
    const changes = workspace.kind === "linked"
      ? makeChangeTracker(workspace.root, log)
      : makeWorktreeTracker(config.capyHome, resolution.value.repo, threadId, log)
    return { deviceId: device.value.id, resolved: resolution.value, problem: undefined, changes }
  }

  const requireApiKey = async () => {
    if ((await savedApiKey(config)) === undefined) {
      throw acp.RequestError.authRequired(undefined, "No Capy API key. Run `npx -y capy-acp --setup`, or set CAPY_API_KEY.")
    }
  }

  /** A saved session to continue. A session that never sent a prompt has no record, and opens empty. */
  const restorable = async (sessionId: string): Promise<SessionRecord | undefined> => {
    const busy = sessions.get(sessionId)?.busy === true
    if (busy) throw acp.RequestError.invalidRequest(undefined, "This session is running a prompt.")
    return store.get(sessionId)
  }

  /** Builds a session's state, from its record when it continues a thread, and returns its options. */
  const openSession = async (sessionId: string, cwd: string, record: SessionRecord | undefined) => {
    // A thread works in the folder it was created for, so a saved session keeps its own folder.
    const folder = record?.cwd ?? cwd
    if (record !== undefined && record.cwd !== cwd) log(`session ${sessionId}: client opened ${cwd}; the thread works in ${record.cwd}`)
    void loadPrices()
    const setup = await setUp(folder, () => sessions.get(sessionId)?.threadId)
    const available = await loadModels().catch(() => [] as ReadonlyArray<Model>)
    const session: SessionState = {
      ...setup,
      cwd: folder,
      threadId: record?.threadId,
      cursor: record?.cursor,
      model: record?.model ?? config.defaultModel,
      reasoning: record?.reasoning ?? config.defaultReasoning,
      title: record?.title,
      noteShown: record !== undefined,
      busy: false,
      closed: false,
      cancel: undefined,
      credits: undefined,
      delivered: undefined
    }
    sessions.set(sessionId, session)
    log(
      setup.resolved === undefined
        ? `session ${sessionId}: cannot run in ${folder}: ${setup.problem?.title}`
        : `session ${sessionId}: ${setup.resolved.repo} in project ${setup.resolved.projectName} (${setup.resolved.workspace.kind})`
    )
    return configOptions(session, available, await loadPrices())
  }

  const app = acp
    .agent({ name: AGENT_NAME })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        // Media is attached to the Capy message as files (prompt.ts).
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} }
      },
      agentInfo: { name: AGENT_NAME, title: "Capy", version: AGENT_VERSION },
      // Without a key, sessions fail with auth_required; this method lets a client offer setup.
      authMethods: [API_KEY_AUTH]
    }))
    .onRequest(acp.methods.agent.authenticate, async () => {
      await requireApiKey()
      return {}
    })
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      // A missing key fails here with auth_required, so clients offer sign-in (T3 Code shows the
      // agent as signed out). Other setup problems become the session's first reply instead: T3 Code
      // shows only "Provider session failed to open" and drops the error's message, which here
      // always names the fix. Each prompt re-checks, so linking the folder needs no new session.
      await requireApiKey()
      const sessionId = randomUUID()
      return { sessionId, configOptions: await openSession(sessionId, params.cwd, undefined) }
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      const record = await restorable(params.sessionId)
      const configOptions = await openSession(params.sessionId, params.cwd, record)
      if (record !== undefined) {
        // Replay the committed transcript as history before answering, as `session/load` requires.
        const threadId = record.threadId
        const notify = (update: SessionUpdate) =>
          client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update }).catch(() => undefined)
        const messages = await run(withCapy((capy) => capy.listMessages(threadId)))
        for (const entry of history(messages)) {
          await notify(entry.update)
          for (const file of entry.files ?? []) {
            const content = await runtime.runPromise(withCapy((capy) => fileLink(capy, threadId, file)))
            await notify(entry.source === "user" ? { sessionUpdate: "user_message_chunk", content } : { sessionUpdate: "agent_message_chunk", content })
          }
        }
        // The client now has everything, so the next turn streams from the newest entry. User and
        // assistant entries carry their stream event id as their id (tool entries do not), and event
        // ids sort by time, so this only ever moves the saved cursor forward.
        const newest = messages.findLast((m) => m.source !== "tool" && EVENT_ID.test(m.id))?.id
        const session = sessions.get(params.sessionId)
        if (session !== undefined && newest !== undefined && (session.cursor === undefined || newest > session.cursor)) {
          session.cursor = newest
          await persist(params.sessionId, session)
        }
        log(`session ${params.sessionId}: loaded thread ${threadId} (${messages.length} entries)`)
      }
      return { configOptions }
    })
    .onRequest(acp.methods.agent.session.resume, async ({ params }) => {
      const record = await restorable(params.sessionId)
      const configOptions = await openSession(params.sessionId, params.cwd, record)
      if (record !== undefined) log(`session ${params.sessionId}: resumed thread ${record.threadId}`)
      return { configOptions }
    })
    .onRequest(acp.methods.agent.session.list, async ({ params }) => {
      const records = await store.list()
      return {
        sessions: records
          .filter((record) => params.cwd == null || record.cwd === params.cwd)
          .map((record) => ({ sessionId: record.sessionId, cwd: record.cwd, title: record.title ?? null, updatedAt: record.updatedAt }))
      }
    })
    .onRequest(acp.methods.agent.session.close, async ({ params }) => {
      const session = sessions.get(params.sessionId)
      if (session === undefined) return {}
      if (session.busy) {
        // Keep the entry until the cancelled prompt settles, so a load of this id can't start a
        // second turn on the same thread meanwhile. The prompt removes it on the way out.
        session.closed = true
        if (session.cancel !== undefined) Deferred.doneUnsafe(session.cancel, Exit.void)
      } else {
        sessions.delete(params.sessionId)
      }
      return {}
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => {
      const session = sessions.get(params.sessionId)
      if (session === undefined || session.closed) throw acp.RequestError.sessionNotFound(params.sessionId)
      const available = await loadModels()
      if (!("value" in params) || typeof params.value !== "string") {
        throw acp.RequestError.invalidParams(undefined, `Unsupported value for ${params.configId}`)
      }
      if (params.configId === "model") {
        if (!available.some((m) => m.id === params.value)) {
          throw acp.RequestError.invalidParams(undefined, `Capy does not offer the model ${params.value}`)
        }
        session.model = params.value
      } else if (params.configId === "reasoning") {
        const modes = available.find((m) => m.id === session.model)?.reasoningModes ?? []
        if (!modes.includes(params.value)) {
          throw acp.RequestError.invalidParams(undefined, `${session.model} does not offer the reasoning level ${params.value}`)
        }
        session.reasoning = params.value
      } else {
        throw acp.RequestError.invalidParams(undefined, `Unknown option ${params.configId}`)
      }
      await persist(params.sessionId, session)
      return { configOptions: configOptions(session, available, await loadPrices()) }
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const session = sessions.get(params.sessionId)
      if (session === undefined || session.closed) throw acp.RequestError.sessionNotFound(params.sessionId)
      if (session.busy) throw acp.RequestError.invalidRequest(undefined, "A prompt is already running in this session.")
      const { text, files } = promptParts(params.prompt, { forwardHostInstructions: config.forwardHostInstructions })
      if (text === "" && files.length === 0) throw acp.RequestError.invalidParams(undefined, "The prompt is empty.")

      // Busy from here on, before any await: a second prompt must not slip in while setup runs.
      const cancel = Deferred.makeUnsafe<void>()
      session.busy = true
      session.cancel = cancel
      const notify = (update: SessionUpdate) =>
        client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update }).catch(() => undefined)
      // A client that stops listening must not fail the turn: Capy keeps working either way.
      const emit = (update: SessionUpdate) => Effect.promise(() => notify(update))
      const say = (text: string) => notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } })
      const ended = { stopReason: "end_turn" as const }
      try {
        if (session.resolved === undefined) {
          // The user may have fixed the setup (linked the folder, added the repo) since the last try.
          Object.assign(session, await setUp(session.cwd, () => session.threadId))
          if (session.resolved !== undefined) log(`session ${params.sessionId}: setup resolved on retry`)
        }
        if (Deferred.isDoneUnsafe(cancel)) return { stopReason: "cancelled" as const }
        const resolved = session.resolved
        if (resolved === undefined) {
          if (session.problem !== undefined) await say(toMarkdown(session.problem))
          return ended
        }
        if (!session.noteShown && resolved.note !== undefined) {
          session.noteShown = true
          await say(`_${resolved.note}_\n\n`)
        }
        // A new thread starts at 0 credits.
        if (session.threadId === undefined) session.credits = 0
        else if (session.credits === undefined) session.credits = (await readCredits(session.threadId))?.totalCredits
        const reasoningModes = (await loadModels().catch(() => [] as ReadonlyArray<Model>)).find((m) => m.id === session.model)?.reasoningModes ?? []
        const reasoningMode = effectiveReasoning(session.reasoning, reasoningModes)
        const workspace = resolved.workspace
        const exit = await runtime.runPromiseExit(
          runTurn({
            changes: session.changes,
            threadId: session.threadId,
            cursor: session.cursor,
            text,
            files,
            attachmentsDir: config.attachmentsDir,
            onCursor: (threadId, cursor) =>
              Effect.promise(() => {
                session.threadId = threadId
                session.cursor = cursor
                session.title ??= titleOf(text || files.map((f) => f.name).join(", "))
                return persist(params.sessionId, session)
              }),
            model: { modelId: session.model, ...(reasoningMode === undefined ? {} : { reasoningMode }) },
            target: workspace.kind === "cloud"
              ? { projectId: resolved.projectId, workspace }
              : { projectId: resolved.projectId, deviceId: session.deviceId, workspace },
            waitingLimitMs: config.waitingLimitMs,
            cancelled: Deferred.await(cancel),
            emit
          })
        )
        if (Exit.isFailure(exit)) {
          // runTurn fails only before Capy accepted the message (afterwards it reports problems in
          // the reply), so saying that nothing was sent is accurate, and a resend is safe.
          const failure = exit.cause.reasons.find(Cause.isFailReason)
          if (failure === undefined) {
            log(Cause.pretty(exit.cause))
            throw acp.RequestError.internalError(undefined, "capy-acp hit an unexpected error; see its stderr log.")
          }
          const error = failure.error
          log(`session ${params.sessionId}: ${describeError(error)}`)
          if (resolved.workspace.kind === "linked" && session.threadId === undefined && isNotLinked(error)) {
            // The folder list on disk can lag the server, or the link was removed: say how to fix it.
            Object.assign(session, { resolved: undefined, changes: undefined, problem: resolved.notLinked })
            await say(toMarkdown(resolved.notLinked))
          } else if (error._tag === "CapyApiError" && error.status >= 400 && error.status < 500 && error.status !== 429) {
            await say(toMarkdown(error.status === 401 || error.status === 403 ? rejectedApiKey(describeError(error)) : {
              title: "Capy did not take this message",
              detail: `Nothing was sent. ${describeError(error)}`,
              steps: ["Fix what the error names, then send your message again."]
            }))
          } else {
            await say(toMarkdown(error._tag === "CapyConfigError" ? noApiKey(config.apiKeyFile) : {
              title: "Send your message again",
              detail: `capy-acp could not reach Capy, so nothing was sent. ${describeError(error)}`,
              steps: []
            }))
          }
          return ended
        }
        const result = exit.value
        session.threadId = result.threadId
        session.cursor = result.cursor
        if (session.threadId !== undefined) session.title ??= titleOf(text || files.map((f) => f.name).join(", "))
        await persist(params.sessionId, session)
        if (session.threadId !== undefined && workspace.kind === "cloud") await reportDelivery(session, resolved.repo, say)
        if (session.threadId !== undefined) await reportCredits(session, notify)
        if (session.threadId !== undefined) log(`session ${params.sessionId}: thread ${session.threadId} → ${result.stopReason}`)
        return { stopReason: result.stopReason }
      } finally {
        session.busy = false
        session.cancel = undefined
        if (session.closed) sessions.delete(params.sessionId)
      }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      const cancel = sessions.get(params.sessionId)?.cancel
      if (cancel !== undefined) Deferred.doneUnsafe(cancel, Exit.void)
    })

  return { app, dispose: () => runtime.dispose() }
}
