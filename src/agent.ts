/**
 * The ACP agent: maps ACP sessions to Capy threads on this machine's Capy device.
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
import { CapyClient, type CapyError, describeError, type Model, layer as capyLayer } from "./capy/client.js"
import { type ChangeTracker, makeChangeTracker } from "./changes.js"
import type { AdapterConfig } from "./config.js"
import { promptParts } from "./prompt.js"
import { API_KEY_AUTH, savedApiKey } from "./setup.js"
import { makeSessionStore, type SessionRecord } from "./store.js"
import { history } from "./translate.js"
import { fileLink, runTurn, titleOf } from "./turn.js"
import { AGENT_NAME, AGENT_VERSION } from "./version.js"
import { readDeviceId, readGit, readLinkedFolders, resolveWorkspace, type ResolvedWorkspace } from "./workspace.js"

/** Where a session's threads run. Replaced as a whole when a prompt re-checks the folder. */
interface Setup {
  /** Undefined when the folder cannot run Capy threads; `problem` then says why and how to fix it. */
  resolved: ResolvedWorkspace | undefined
  problem: string | undefined
  deviceId: string
  /** Set in linked mode, where Capy edits the open folder and the adapter can show the diffs. */
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
}

/** A Capy stream event id (a ULID), the only thing a stream cursor may be. */
const EVENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

const log = (message: string) => process.stderr.write(`[capy-acp] ${message}\n`)

/** Models billed to Capy credits are labelled, since device threads otherwise cost nothing. */
const modelLabel = (model: Model) => (model.route === "capy" ? `${model.name} (Capy credits)` : model.name)

/** Capy's answer when a linked root is not (or no longer) linked to this device. */
const isNotLinked = (error: CapyError) => error._tag === "CapyApiError" && /does not link a folder/i.test(error.message)

const linkFix = (root: string, projectName: string) =>
  `Link it to this device in Capy: open https://capy.ai/settings/projects, choose "${projectName}", and add ${root} under ` +
  "Project folders (or use Scan a folder in the Capy desktop app). Then send your message again."

/** The reasoning level a session really sends: its own when the model offers it, else the model's highest. */
const effectiveReasoning = (reasoning: string, modes: ReadonlyArray<string>): string | undefined =>
  modes.includes(reasoning) ? reasoning : modes.at(-1)

export const makeAgent = (config: AdapterConfig, capy: Layer.Layer<CapyClient> = capyLayer(config)) => {
  const runtime = ManagedRuntime.make(capy)
  const sessions = new Map<string, SessionState>()
  const store = makeSessionStore(config.stateDir)
  let models: ReadonlyArray<Model> | undefined

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

  const loadModels = async (): Promise<ReadonlyArray<Model>> => {
    if (models === undefined) models = await run(withCapy((capy) => capy.listModels))
    return models
  }

  const configOptions = (session: SessionState, available: ReadonlyArray<Model>): Array<SessionConfigOption> => {
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
          (m) => ({ value: m.id, name: modelLabel(m), ...(m.billing ? { description: `Billed to: ${m.billing}` } : {}) })
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
    throw new Error(failure === undefined ? Cause.pretty(exit.cause) : describeError(failure.error))
  }

  /** Folder → project → device workspace. Never throws: failures become the session's `problem`. */
  const setUp = async (cwd: string): Promise<Setup> => {
    const [projects, deviceId, linked, git] = await Promise.allSettled([
      attempt(withCapy((capy) => capy.listProjects)),
      readDeviceId(config),
      readLinkedFolders(config),
      readGit(cwd)
    ])
    // Reported in this order: the API key first, then the paired device, since nothing else can be
    // fixed without them. (Folder and git reads never reject.)
    if (projects.status === "rejected" || deviceId.status === "rejected" || linked.status === "rejected" || git.status === "rejected") {
      const reason: unknown = [projects, deviceId, linked, git].flatMap((r) => (r.status === "rejected" ? [r.reason] : []))[0]
      return { deviceId: "", resolved: undefined, problem: reason instanceof Error ? reason.message : String(reason), changes: undefined }
    }
    const resolution = resolveWorkspace({
      cwd,
      ...git.value,
      linked: linked.value,
      projects: projects.value,
      mode: config.workspaceMode,
      allowWorktreeFallback: config.allowWorktreeFallback
    })
    if (resolution._tag === "Unresolved") return { deviceId: deviceId.value, resolved: undefined, problem: resolution.message, changes: undefined }
    const workspace = resolution.value.workspace
    const changes = workspace.kind === "linked" ? makeChangeTracker(workspace.root, (message) => log(message)) : undefined
    return { deviceId: deviceId.value, resolved: resolution.value, problem: undefined, changes }
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
    const setup = await setUp(folder)
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
      cancel: undefined
    }
    sessions.set(sessionId, session)
    log(
      setup.resolved === undefined
        ? `session ${sessionId}: cannot run in ${folder}: ${setup.problem}`
        : `session ${sessionId}: ${setup.resolved.repo} in project ${setup.resolved.projectName} (${setup.resolved.workspace.kind})`
    )
    return configOptions(session, available)
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
      // Without a key, prompts still open and answer with the fix; this method lets a client offer setup.
      authMethods: [API_KEY_AUTH]
    }))
    .onRequest(acp.methods.agent.authenticate, async () => {
      if ((await savedApiKey(config)) === undefined) {
        throw acp.RequestError.authRequired(undefined, `No Capy API key. Run capy-acp --setup, or set CAPY_API_KEY.`)
      }
      return {}
    })
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      // Setup problems become the session's first reply instead of a session/new error: T3 Code
      // shows only "Provider session failed to open" and drops the error's message, which here
      // always names the fix. Each prompt re-checks, so linking the folder needs no new session.
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
      return { configOptions: configOptions(session, available) }
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
          Object.assign(session, await setUp(session.cwd))
          if (session.resolved !== undefined) log(`session ${params.sessionId}: setup resolved on retry`)
        }
        if (Deferred.isDoneUnsafe(cancel)) return { stopReason: "cancelled" as const }
        const resolved = session.resolved
        if (resolved === undefined) {
          await say(`capy-acp can't run here. ${session.problem ?? ""}`)
          return ended
        }
        if (!session.noteShown && resolved.note !== undefined) {
          session.noteShown = true
          await say(`_${resolved.note}_\n\n`)
        }
        const reasoningModes = (await loadModels().catch(() => [] as ReadonlyArray<Model>)).find((m) => m.id === session.model)?.reasoningModes ?? []
        const reasoningMode = effectiveReasoning(session.reasoning, reasoningModes)
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
            target: { projectId: resolved.projectId, deviceId: session.deviceId, workspace: resolved.workspace },
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
            const root = resolved.workspace.root
            Object.assign(session, {
              resolved: undefined,
              changes: undefined,
              problem: `Capy says this device does not link ${root}. ${linkFix(root, resolved.projectName)}`
            })
            await say(`capy-acp can't run here. ${session.problem}`)
          } else {
            await say(`capy-acp could not send this message to Capy, so nothing was sent. ${describeError(error)}`)
          }
          return ended
        }
        const result = exit.value
        session.threadId = result.threadId
        session.cursor = result.cursor
        if (session.threadId !== undefined) session.title ??= titleOf(text || files.map((f) => f.name).join(", "))
        await persist(params.sessionId, session)
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
