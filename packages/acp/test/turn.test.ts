import type { SessionUpdate } from "@agentclientprotocol/sdk"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { basename, join } from "node:path"
import { afterEach } from "@effect/vitest"
import { CapyClient, type CreateThread, type FileUpload, type SendMessage } from "@capy-acp/core/capy/client.js"
import type { CapyEvent } from "@capy-acp/core/capy/events.js"
import type { ChangeTracker, FileChange } from "../src/changes.js"
import { fileLink, runTurn, type ThreadTarget } from "../src/turn.js"
import { loadEvents, scenarios } from "../../core/test/fixtures.js"

const recorded = (model: string, scenario: string) => {
  const found = scenarios().find((s) => s.model.includes(model) && s.scenario === scenario)
  if (found === undefined) throw new Error(`no fixture ${model}/${scenario}`)
  return loadEvents(found.dir)
}

/** A Capy client that replays one recorded stream and reports the thread idle afterwards. */
const fakeCapy = (events: ReturnType<typeof loadEvents>, calls: Array<string>, sent: Array<SendMessage> = [], creates: Array<CreateThread> = []) =>
  Layer.succeed(
    CapyClient,
    CapyClient.of({
      listModels: Effect.succeed([]),
      listProjects: Effect.succeed([]),
      createThread: (body) =>
        Effect.sync(() => (calls.push(`create ${body.device?.workspace.kind}`), creates.push(body), { id: "jam_test", status: "working" as const })),
      sendMessage: (_, body) => Effect.sync(() => (calls.push(`message${body.delivery ? ` ${body.delivery}` : ""}`), sent.push(body), { id: "msg" })),
      interrupt: () => Effect.sync(() => void calls.push("interrupt")),
      getThread: () => Effect.succeed({ id: "jam_test", status: "idle" as const }),
      listThreads: () => Effect.succeed([]),
      uploadFiles: (files) =>
        Effect.sync(() => (files.length > 0 && calls.push(`upload ${files.map((f) => f.name).join(",")}`), files.map((f, i) => ({ fileId: `file_${i}`, name: f.name })))),
      listMessages: () => Effect.succeed([]),
      attachmentUrl: (_, fileId) => Effect.succeed(`https://files.example/${fileId}?sig=1`),
      stream: () => Stream.fromIterable(events)
    })
  )

/** A tracker that hands out prepared change sets, one per collect, and logs when it is used. */
const fakeTracker = (sets: Array<ReadonlyArray<FileChange>>, calls: Array<string>): ChangeTracker => ({
  baseline: Effect.sync(() => void calls.push("baseline")),
  collect: Effect.sync(() => (calls.push("collect"), sets.shift() ?? []))
})

type ToolUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>
const isTool = (u: SessionUpdate): u is ToolUpdate => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update"

const readme: FileChange = {
  path: "/home/dev/capy-acp-spike/sandbox/README.md",
  relativePath: "README.md",
  operation: "modify",
  previewable: true,
  oldText: "# capy-acp-sandbox\n",
  newText: "# capy-acp-sandbox\n<!-- capy-acp spike -->\n"
}
const spike: FileChange = {
  path: "/home/dev/capy-acp-spike/sandbox/docs/SPIKE.md",
  relativePath: "docs/SPIKE.md",
  operation: "add",
  previewable: true,
  newText: "A sandbox.\n"
}

const run = (input: {
  events: ReturnType<typeof loadEvents>
  changes?: ChangeTracker
  calls: Array<string>
  threadId?: string
  text?: string
  files?: ReadonlyArray<FileUpload>
  sent?: Array<SendMessage>
  cursors?: Array<string>
  attachmentsDir?: string
  creates?: Array<CreateThread>
  target?: ThreadTarget
}) =>
  Effect.gen(function*() {
    const updates: Array<SessionUpdate> = []
    const result = yield* runTurn({
      threadId: input.threadId,
      cursor: undefined,
      text: input.text ?? "edit two files",
      files: input.files,
      attachmentsDir: input.attachmentsDir ?? "/nonexistent/attachments",
      onCursor: (_, cursor) => Effect.sync(() => void input.cursors?.push(cursor)),
      model: { modelId: "anthropic/claude-opus-5-5", reasoningMode: "high" },
      target: input.target ?? { projectId: "project_SPIKE", deviceId: "device_SPIKE", workspace: { kind: "linked", root: "/home/dev/capy-acp-spike/sandbox" } },
      waitingLimitMs: 60_000,
      cancelled: Effect.never,
      emit: (update) => Effect.sync(() => void updates.push(update)),
      changes: input.changes
    }).pipe(Effect.provide(fakeCapy(input.events, input.calls, input.sent, input.creates)))
    return { result, updates }
  })

describe("runTurn in linked mode", () => {
  it.effect("shows each tool call's file changes as diffs right after it completes", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      // Recorded run: tool 1 ran `pwd` and read README.md (no changes), tool 2 wrote both files.
      const { result, updates } = yield* run({
        events: recorded("opus", "s2-edit-linked"),
        changes: fakeTracker([[], [], [], [readme, spike]], calls),
        calls
      })
      expect(result).toMatchObject({ threadId: "jam_test", stopReason: "end_turn" })
      // Baseline before the thread exists; a look as each tool call starts and finishes, and a last one at the end.
      expect(calls).toEqual(["baseline", "create linked", "collect", "collect", "collect", "collect", "collect"])

      const tools = updates.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
      const diffs = tools.filter((u) => u.kind === "edit")
      expect(diffs).toHaveLength(1)
      const [edit] = diffs
      expect(edit).toMatchObject({
        sessionUpdate: "tool_call_update",
        title: "Edited README.md and docs/SPIKE.md",
        status: "completed",
        content: [
          { type: "diff", path: readme.path, oldText: readme.oldText, newText: readme.newText },
          { type: "diff", path: spike.path, newText: spike.newText }
        ]
      })
      // Credited to the second tool call, straight after its completion and before the final reply.
      const completedSecond = updates.findIndex(
        (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === edit!.toolCallId && u.kind === "other"
      )
      expect(updates[completedSecond + 1]).toBe(edit)
      expect(updates.slice(completedSecond + 2).some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true)
    }))

  it.effect("shows changes made while no Capy call ran on an item of their own, ahead of the next call", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      // The user edits README.md before Capy's first call starts; the second call writes docs/SPIKE.md.
      const { updates } = yield* run({ events: recorded("opus", "s2-edit-linked"), changes: fakeTracker([[readme], [], [], [spike]], calls), calls })
      const tools = updates.filter(isTool)
      expect(tools[0]).toMatchObject({ sessionUpdate: "tool_call", kind: "other", title: "Edited README.md outside a Capy tool call" })
      expect(tools[1]).toMatchObject({ sessionUpdate: "tool_call", status: "in_progress" })
      expect(tools.filter((u) => u.kind === "edit")).toMatchObject([{ title: "Created docs/SPIKE.md" }])
    }))

  it.effect("does not credit changes to a call that only reads", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const { updates } = yield* run({
        events: [
          { _tag: "Status", status: "working" },
          { _tag: "ToolCall", callId: "c1", name: "execute", text: "" },
          { _tag: "Transcript", cursor: "01M84K0HA45PN2H6STSA7EK03B", message: { id: "c1", source: "tool", tool: "execute", calls: [{ tool: "read", durationMs: 30 }] } },
          { _tag: "Status", status: "idle" }
        ],
        changes: fakeTracker([[], [readme]], calls),
        calls
      })
      const tools = updates.filter(isTool)
      expect(tools.filter((u) => u.toolCallId === "c1").map((u) => u.kind)).toEqual(["other", "read"])
      expect(tools.at(-1)).toMatchObject({ sessionUpdate: "tool_call", kind: "other", title: "Edited README.md outside a Capy tool call" })
    }))

  it.effect("shows edits when Capy ran no tool call as not Capy's", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      // Keep the replies, drop every tool frame.
      const events = recorded("opus", "s2-edit-linked").filter(
        (e) => e._tag !== "ToolCall" && !(e._tag === "Transcript" && e.message.source === "tool")
      )
      const { updates } = yield* run({ events, changes: fakeTracker([[spike]], calls), calls })
      expect(calls).toEqual(["baseline", "create linked", "collect"])
      expect(updates.filter((u) => u.sessionUpdate === "tool_call")).toMatchObject([
        { kind: "other", status: "completed", title: "Created docs/SPIKE.md outside a Capy tool call" }
      ])
    }))

  it.effect("keeps a tool call that a failed run closed as failed, while still showing its edits", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const { updates } = yield* run({
        events: [
          { _tag: "Status", status: "working" },
          { _tag: "ToolCall", callId: "c1", name: "execute", text: "" },
          { _tag: "Status", status: "failed" }
        ],
        changes: fakeTracker([[], [spike]], calls),
        calls
      })
      const forC1 = updates.filter(isTool).filter((u) => u.toolCallId === "c1")
      expect(forC1.map((u) => [u.sessionUpdate, u.status, u.kind])).toEqual([
        ["tool_call", "in_progress", "other"],
        ["tool_call_update", "failed", undefined],
        ["tool_call_update", "failed", "edit"]
      ])
    }))

  it.effect("runs without a tracker in worktree mode", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const { result, updates } = yield* run({ events: recorded("opus", "s2-edit"), calls })
      expect(result.stopReason).toBe("end_turn")
      expect(updates.some((u) => (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && u.kind === "edit")).toBe(false)
    }))
})

const png: FileUpload = { name: "image-1.png", mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) }
const temps: Array<string> = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("runTurn with attachments", () => {
  it.effect("starts a thread with the files saved on this machine and named in the first message", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "capy-acp-attach-"))
      temps.push(dir)
      const calls: Array<string> = []
      const creates: Array<CreateThread> = []
      const second = { ...png, name: "../../escape.png", bytes: new Uint8Array([1]) }
      const windowsy = { ...png, name: "..\\up\\shot:1?.png" }
      yield* run({ events: recorded("opus", "s1-write"), calls, creates, attachmentsDir: dir, text: "what is in this image?", files: [png, second, png, windowsy] })
      // No upload and no second message: nothing can race the agent's first step.
      expect(calls.filter((c) => c.startsWith("upload") || c.startsWith("message"))).toEqual([])
      const [, header, ...lines] = creates[0]!.message.split("\n")
      expect(creates[0]!.message.startsWith("what is in this image?\n\nAttached files, saved on this machine:\n")).toBe(true)
      expect(header).toBe("")
      const paths = lines.slice(1).map((line) => line.replace(/^- /, ""))
      expect(paths.map((p) => basename(p))).toEqual(["image-1.png", "escape.png", "2-image-1.png", "shot_1_.png"])
      for (const path of paths) expect(path.startsWith(dir)).toBe(true)
      expect([...readFileSync(paths[0]!)]).toEqual([...png.bytes])
      if (process.platform !== "win32") expect(statSync(paths[0]!).mode & 0o777).toBe(0o600)
      expect(creates[0]!.title).toBe("what is in this image?")
    }))

  it.effect("sends a follow-up's files with its text, and names them when there is no text", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const sent: Array<SendMessage> = []
      yield* run({ events: recorded("opus", "s3-followup"), calls, sent, threadId: "jam_test", text: "", files: [png] })
      expect(calls.slice(0, 2)).toEqual(["upload image-1.png", "message"])
      expect(sent[0]).toMatchObject({ text: "Attached: image-1.png", files: [{ fileId: "file_0", name: "image-1.png" }] })
      expect(sent[0]).not.toHaveProperty("delivery")
    }))

  it.effect("uploads nothing and sends no extra message for a text-only prompt", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      yield* run({ events: recorded("opus", "s1-write"), calls })
      expect(calls.filter((c) => c.startsWith("upload") || c.startsWith("message"))).toEqual([])
    }))

  it.effect("links files the agent delivered with a reply", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const events: Array<CapyEvent> = [
        { _tag: "Status", status: "working" },
        { _tag: "Transcript", cursor: "01USER", message: { id: "u1", source: "user", text: "chart please" } },
        { _tag: "Assistant", callId: "a1", text: "Here is the chart." },
        {
          _tag: "Transcript",
          cursor: "01CURSOR",
          message: {
            id: "m1",
            source: "assistant",
            callId: "a1",
            text: "Here is the chart.",
            attachments: [{ file: { fileId: "file_chart", name: "chart.png", mediaType: "image/png", sizeBytes: 2048, sourcePath: "/nonexistent/chart.png" }, title: "Sales chart" }]
          }
        },
        { _tag: "Status", status: "idle" }
      ]
      const cursors: Array<string> = []
      const { updates } = yield* run({ events, calls, cursors })
      expect(updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content)).toEqual([
        { type: "text", text: "Here is the chart." },
        {
          type: "resource_link",
          uri: "https://files.example/file_chart?sig=1",
          name: "chart.png",
          title: "Sales chart",
          mimeType: "image/png",
          size: 2048,
          description: "image/png, 2.0 KB"
        }
      ])
      expect(cursors).toEqual(["01USER", "01CURSOR"])
    }))
})

describe("runTurn on a Capy cloud machine", () => {
  const cloud: ThreadTarget = { projectId: "project_SPIKE", workspace: { kind: "cloud" } }

  it.effect("creates the thread with no device and streams the reply and tool items", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const creates: Array<CreateThread> = []
      const { result, updates } = yield* run({ events: recorded("opus", "s2-edit"), calls, creates, target: cloud })
      expect(result).toMatchObject({ threadId: "jam_test", stopReason: "end_turn" })
      expect(creates[0]).not.toHaveProperty("device")
      expect(creates[0]).toMatchObject({ projectId: "project_SPIKE", message: "edit two files" })
      expect(updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true)
      expect(updates.some((u) => u.sessionUpdate === "tool_call")).toBe(true)
      // No tracker: the files are on Capy's machine, so no diffs.
      expect(updates.filter(isTool).some((u) => u.kind === "edit")).toBe(false)
    }))

  it.effect("uploads a first prompt's files and sends them right after the create, since the machine cannot read this one", () =>
    Effect.gen(function*() {
      const calls: Array<string> = []
      const creates: Array<CreateThread> = []
      const sent: Array<SendMessage> = []
      yield* run({ events: recorded("opus", "s1-write"), calls, creates, sent, target: cloud, text: "what is in this image?", files: [png] })
      expect(calls.slice(0, 3)).toEqual(["upload image-1.png", "create undefined", "message steer"])
      expect(creates[0]!.message).toBe(
        "what is in this image?\n\nAttached files follow in the next message: image-1.png. Wait for them before you answer."
      )
      expect(sent[0]).toMatchObject({ text: "Attached: image-1.png", files: [{ fileId: "file_0", name: "image-1.png" }], delivery: "steer" })
    }))
})

describe("fileLink", () => {
  it.effect("links a file Capy made on this machine to its path, in the form Capy reports it", () =>
    Effect.gen(function*() {
      const dir = mkdtempSync(join(tmpdir(), "capy-acp-link-"))
      temps.push(dir)
      const path = join(dir, "hello.txt")
      writeFileSync(path, "hi\n")
      // On Windows Capy reports `C:/Users/…/hello.txt`: native drive, forward slashes (seen live).
      const sourcePath = path.replaceAll("\\", "/")
      const capy = yield* CapyClient.pipe(Effect.provide(fakeCapy([], [])))
      const link = yield* fileLink(capy, "jam_test", { fileId: "file_1", name: "hello.txt", mediaType: "text/plain", sizeBytes: 3, sourcePath, title: undefined })
      expect(link).toMatchObject({ type: "resource_link", uri: pathToFileURL(path).href, name: "hello.txt" })
    }))
})

describe("runTurn end of turn", () => {
  it.effect("reads to the end of the run when Capy goes idle before an unstreamed reply commits", () =>
    Effect.gen(function*() {
      // Seen live after a load: no reply fragments streamed, and the entries committed after idle.
      const connections: Array<Array<CapyEvent>> = [[
        { _tag: "Status", status: "idle" },
        { _tag: "Status", status: "working" },
        { _tag: "Status", status: "idle" },
        { _tag: "Transcript", cursor: "01U", message: { id: "u1", source: "user", text: "q" } },
        { _tag: "Transcript", cursor: "01A", message: { id: "a1", source: "assistant", callId: "c1", text: "The answer." } },
        { _tag: "Done" }
      ]]
      const cursors: Array<string | undefined> = []
      const layer = Layer.succeed(
        CapyClient,
        CapyClient.of({
          listModels: Effect.succeed([]),
          listProjects: Effect.succeed([]),
          createThread: () => Effect.succeed({ id: "jam_test", status: "working" as const }),
          sendMessage: () => Effect.succeed({ id: "msg" }),
          interrupt: () => Effect.void,
          getThread: () => Effect.succeed({ id: "jam_test", status: "idle" as const }),
          listThreads: () => Effect.succeed([]),
          uploadFiles: () => Effect.succeed([]),
          listMessages: () => Effect.succeed([]),
          attachmentUrl: () => Effect.succeed(""),
          stream: (_, { cursor }) => Stream.suspend(() => (cursors.push(cursor), Stream.fromIterable(connections.shift() ?? [])))
        })
      )
      const updates: Array<SessionUpdate> = []
      const result = yield* runTurn({
        threadId: "jam_test",
        cursor: "01PREV",
        text: "q",
        attachmentsDir: "/nonexistent",
        model: { modelId: "m" },
        target: { projectId: "p", deviceId: "d", workspace: { kind: "worktree" } },
        waitingLimitMs: 60_000,
        cancelled: Effect.never,
        emit: (update) => Effect.sync(() => void updates.push(update))
      }).pipe(Effect.provide(layer))
      expect(updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The answer." } }])
      expect(result).toMatchObject({ cursor: "01A", stopReason: "end_turn" })
      expect(cursors).toEqual(["01PREV"])
    }))
})
