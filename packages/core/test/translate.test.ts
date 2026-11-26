import { describe, expect, it } from "@effect/vitest"
import type { SessionUpdate } from "@agentclientprotocol/sdk"
import type { Message } from "../src/capy/events.js"
import type { FileChange } from "../src/translate.js"
import { changeTitle, closedTools, fileChangeUpdate, finishTools, history, initialTurn, replay, toolStatus, step as stepAll, toolKind, toolTitle } from "../src/translate.js"
import { loadEvents, loadJson, readText, scenarios } from "./fixtures.js"

const messageText = (updates: ReadonlyArray<SessionUpdate>) =>
  updates.flatMap((u) => (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" ? [u.content.text] : [])).join("")

const toolStatuses = (updates: ReadonlyArray<SessionUpdate>) => {
  const status = new Map<string, string>()
  for (const u of updates) {
    if (u.sessionUpdate === "tool_call") status.set(u.toolCallId, u.status ?? "pending")
    if (u.sessionUpdate === "tool_call_update" && u.status) status.set(u.toolCallId, u.status)
  }
  return status
}

describe("translator replays recorded Capy streams", () => {
  for (const { model, scenario, dir } of scenarios()) {
    it(`${model} ${scenario}`, () => {
      const { state, updates, signals } = replay(loadEvents(dir), readText(dir, "resume-cursor") || undefined)
      const transcript = loadJson<{ items: Array<Message> }>(dir, "messages.json")?.items ?? []
      const tags = signals.map((s) => s._tag)

      if (scenario === "s4-interrupt" && model.startsWith("openai")) {
        // Capy backgrounded `sleep 90`: the run ended with the thread waiting for the command.
        expect(tags).toContain("Waiting")
        expect(tags).not.toContain("Ended")
      } else if (scenario === "s4-interrupt") {
        // Interrupted mid-reply: covered by its own test below.
        expect(tags).not.toContain("Ended")
      } else {
        // Exactly one end-of-turn, even though every stream opens with a stale `idle` status.
        expect(tags.filter((t) => t === "Ended")).toHaveLength(1)
      }

      // Every committed reply of this turn reaches the client, in order, once.
      const replies = transcript
        .filter((m) => m.source === "assistant" && state.assistant.has(m.callId ?? m.id))
        .map((m) => m.text ?? "")
      if (scenario !== "s4-interrupt") {
        expect(replies.length).toBeGreaterThan(0)
        expect(messageText(updates)).toBe(replies.join("\n\n"))
      }

      // Every tool call shown is closed, except the one still backgrounded on a waiting thread.
      const statuses = toolStatuses(updates)
      const open = [...statuses.values()].filter((s) => s !== "completed")
      expect(open).toHaveLength(0)
      expect(state.cursor).toBeDefined()
    })
  }

  it("fixtures hold no home paths other than the scrubbed one, even across split fragments", () => {
    for (const { dir } of scenarios()) {
      const homes = messageText(replay(loadEvents(dir)).updates).match(/\/home\/[^/\s`]+/g) ?? []
      expect(homes.every((home) => home === "/home/dev")).toBe(true)
    }
  })

  it("upgrades empty `execute` frames with the inner tools from the transcript", () => {
    const { updates } = replay(loadEvents(scenarios().find((s) => s.model.includes("opus") && s.scenario === "s2-edit")!.dir))
    const tools = updates.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")
    expect(tools[0]).toMatchObject({ sessionUpdate: "tool_call", title: "Running tools", kind: "other", status: "in_progress" })
    expect(tools.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", kind: "other", status: "completed" })
    expect((tools.at(-1) as { title: string }).title).toMatch(/^write, bash \(/)
  })

  it("never claims `execute` or `edit` for Capy's own frames, which carry no command or path", () => {
    for (const { model, scenario, dir } of scenarios()) {
      const kinds = replay(loadEvents(dir)).updates.flatMap((u) =>
        u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update" ? [u.kind] : []
      )
      expect(kinds.filter((k) => k === "execute" || k === "edit"), `${model} ${scenario}`).toEqual([])
    }
  })

  it("reports a tool's completion once, even when a resumed stream repeats its entry", () => {
    const entry = { id: "c1", source: "tool" as const, text: "", tool: "execute", calls: [{ tool: "write", durationMs: 900 }] }
    const { updates } = replay([
      { _tag: "ToolCall", callId: "c1", name: "execute", text: "" },
      { _tag: "Transcript", cursor: "1", message: entry },
      { _tag: "Transcript", cursor: "1", message: entry }
    ])
    expect(updates.map((u) => u.sessionUpdate)).toEqual(["tool_call", "tool_call_update"])
    expect(closedTools(updates)).toEqual([{ toolCallId: "c1", status: "completed", kind: "other" }])
  })

  it("keeps a partial reply streamed before an interrupt, and leaves ending to the runner", () => {
    const { updates, signals, state } = replay(loadEvents(scenarios().find((s) => s.model.includes("opus") && s.scenario === "s4-interrupt")!.dir))
    expect(messageText(updates).length).toBeGreaterThan(50)
    // The interrupted reply never commits, so `idle` cannot prove the transcript is complete; the runner
    // ends the turn when the stream closes and `GET /threads/{id}` reads idle.
    expect(signals).toEqual([])
    expect(state.endPending).toBe(true)
  })

  it("ends only after the final reply commits, so the next turn's cursor is past it", () => {
    for (const { model, scenario, dir } of scenarios()) {
      if (scenario === "s4-interrupt") continue
      const events = loadEvents(dir)
      let state = replay([]).state
      let endedAt = -1
      events.forEach((event, i) => {
        const next = stepAll(state, event)
        state = next.state
        if (next.signal?._tag === "Ended" && endedAt === -1) endedAt = i
      })
      const lastCommit = events.findLastIndex((e) => e._tag === "Transcript" && e.message.source === "assistant")
      expect(endedAt, `${model} ${scenario}`).toBeGreaterThanOrEqual(lastCommit)
      expect(state.cursor).toBe((events[lastCommit] as { cursor: string }).cursor)
    }
  })

  it("separates an interim reply from the final one", () => {
    const { updates } = replay(loadEvents(scenarios().find((s) => s.model.includes("astra") && s.scenario === "s2-edit")!.dir))
    expect(messageText(updates)).toMatch(/^I’ll check the directory before editing either file\.\n\nCreated `docs\/SPIKE.md`/)
  })

  it("fails tool calls still open when a turn is cancelled", () => {
    const { state } = replay([{ _tag: "ToolCall", callId: "c1", name: "execute", text: "" }])
    expect(finishTools(state, "failed").updates).toEqual([{ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" }])
  })

  it("maps tool names to ACP kinds and titles", () => {
    expect(toolKind(["bash"])).toBe("other")
    expect(toolKind(["apply_patch", "bash"])).toBe("other")
    expect(toolKind(["read"])).toBe("read")
    expect(toolKind(["read", "grep"])).toBe("search")
    expect(toolKind(["read", "bash"])).toBe("other")
    expect(toolTitle({ id: "x", source: "tool", text: "", calls: [{ tool: "bash", durationMs: 1630 }] })).toBe("bash (1.6 s)")
    expect(toolTitle({ id: "x", source: "tool", text: "Checking current directory", tool: "bash" })).toBe("Checking current directory")
  })
})

describe("file change updates", () => {
  const change = (relativePath: string, operation: FileChange["operation"], extra: Partial<FileChange> = {}): FileChange => ({
    path: `/repo/${relativePath}`,
    relativePath,
    operation,
    previewable: true,
    ...extra
  })

  it("names the files in the title", () => {
    expect(changeTitle([change("README.md", "modify")])).toBe("Edited README.md")
    expect(changeTitle([change("README.md", "modify"), change("docs/SPIKE.md", "add")])).toBe("Edited README.md and docs/SPIKE.md")
    expect(changeTitle([change("a", "add"), change("b", "add"), change("c", "add")])).toBe("Created a, b and c")
    expect(changeTitle([change("a", "delete")])).toBe("Deleted a")
    expect(changeTitle(["a", "b", "c", "d", "e"].map((p) => change(p, "modify")))).toBe("Edited a, b and 3 more files")
  })

  it("sends ACP diffs with absolute paths, new files without oldText, and unpreviewable files as locations only", () => {
    const update = fileChangeUpdate("c1", [
      change("README.md", "modify", { oldText: "a\n", newText: "b\n" }),
      change("docs/NEW.md", "add", { newText: "new\n" }),
      change("gone.md", "delete", { oldText: "old\n" }),
      change("logo.png", "add", { previewable: false })
    ])
    expect(update).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      title: "Edited README.md, docs/NEW.md and 2 more files",
      kind: "edit",
      status: "completed",
      content: [
        { type: "diff", path: "/repo/README.md", oldText: "a\n", newText: "b\n" },
        { type: "diff", path: "/repo/docs/NEW.md", newText: "new\n" },
        { type: "diff", path: "/repo/gone.md", oldText: "old\n", newText: "" }
      ],
      locations: ["README.md", "docs/NEW.md", "gone.md", "logo.png"].map((p) => ({ path: `/repo/${p}` }))
    })
  })

  it("marks pure deletions", () => {
    const update = fileChangeUpdate("c1", [change("gone.md", "delete", { oldText: "old\n" })])
    expect(update).toMatchObject({ sessionUpdate: "tool_call_update", kind: "delete", status: "completed", title: "Deleted gone.md" })
  })

  it("opens an item of its own for changes no Capy tool call made, and says so in the title", () => {
    const update = fileChangeUpdate("x", [change("notes.md", "modify", { oldText: "a\n", newText: "b\n" })], { outside: true })
    expect(update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "x",
      kind: "other",
      status: "completed",
      title: "Edited notes.md outside a Capy tool call",
      content: [{ type: "diff", path: "/repo/notes.md", oldText: "a\n", newText: "b\n" }]
    })
  })
})

describe("tool outcomes", () => {
  const execute = (calls?: Array<{ tool: string; durationMs?: number }>) => ({
    id: "c1",
    source: "tool" as const,
    tool: "execute",
    text: "",
    ...(calls === undefined ? {} : { calls })
  })

  it("tells a call an interrupt stopped from one that finished: only a finished call lists its inner tools", () => {
    // As committed in every cancelled test turn on Linux, macOS and Windows (November 2026).
    expect(toolStatus(execute(), true)).toBe("failed")
    expect(toolStatus(execute([{ tool: "bash", durationMs: 1439 }]), true)).toBe("completed")
    expect(toolStatus(execute(), false)).toBe("failed")
  })

  it("shows a direct tool entry as failed after a cancel, because its outcome is unknown", () => {
    const bash = { id: "c1", source: "tool" as const, tool: "bash", text: "Ran ls" }
    expect(toolStatus(bash, false)).toBe("completed")
    expect(toolStatus(bash, true)).toBe("failed")
  })

  it("keeps a call that finished just before a cancel as completed", () => {
    const { updates } = replay([
      { _tag: "ToolCall", callId: "c1", name: "execute", text: "" },
      { _tag: "ToolCall", callId: "c2", name: "execute", text: "" },
      { _tag: "Transcript", cursor: "1", message: execute([{ tool: "bash", durationMs: 300 }]) },
      { _tag: "Transcript", cursor: "2", message: { ...execute(), id: "c2" } }
    ])
    expect(closedTools(updates)).toEqual([
      { toolCallId: "c1", status: "completed", kind: "other" },
      { toolCallId: "c2", status: "failed", kind: "other" }
    ])
  })
})

describe("subagents", () => {
  it("shows a subagent as one tool call that follows its lifecycle", () => {
    const { updates } = replay([
      { _tag: "Status", status: "working" },
      { _tag: "Subagent", id: "jam_sub", path: "review", status: "draft" },
      { _tag: "Subagent", id: "jam_sub", path: "review", status: "working" },
      { _tag: "Subagent", id: "jam_sub", path: "review", status: "done" },
      { _tag: "Subagent", id: "jam_sub", path: "review", status: "idle" }
    ])
    expect(updates).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "capy-subagent-jam_sub", title: "Subagent review", kind: "other", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "capy-subagent-jam_sub", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "capy-subagent-jam_sub", status: "completed" }
    ])
  })

  it("shows a new subagent as pending: Capy reports it idle before it starts", () => {
    // The live sequence for a subagent the agent creates and starts (capy dock 0.7.2, November 2026).
    const { updates } = replay([
      { _tag: "Subagent", id: "jam_sub", path: "1", status: "idle" },
      { _tag: "Subagent", id: "jam_sub", path: "1", status: "working" },
      { _tag: "Subagent", id: "jam_sub", path: "1", status: "waiting" },
      { _tag: "Subagent", id: "jam_sub", path: "1", status: "idle" }
    ])
    expect(updates).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "capy-subagent-jam_sub", title: "Subagent 1", kind: "other", status: "pending" },
      { sessionUpdate: "tool_call_update", toolCallId: "capy-subagent-jam_sub", status: "in_progress" },
      { sessionUpdate: "tool_call_update", toolCallId: "capy-subagent-jam_sub", status: "completed" }
    ])
  })

  it("marks a failed subagent failed", () => {
    const { updates } = replay([{ _tag: "Subagent", id: "s", path: undefined, status: "failed" }])
    expect(updates).toEqual([{ sessionUpdate: "tool_call", toolCallId: "capy-subagent-s", title: "Subagent s", kind: "other", status: "failed" }])
  })
})

describe("delivered files", () => {
  const entry: Message = {
    id: "m1",
    source: "assistant",
    callId: "a1",
    text: "Done.",
    attachments: [
      { file: { fileId: "file_1", name: "out.csv", mediaType: "text/csv", sizeBytes: 10 } },
      { file: { name: "missing id" } },
      "junk"
    ]
  }

  it("hands the runner the files of a committed reply, once, skipping malformed ones", () => {
    const first = stepAll(initialTurn(undefined), { _tag: "Transcript", cursor: "c1", message: entry })
    expect(first.files).toEqual([{ fileId: "file_1", name: "out.csv", mediaType: "text/csv", sizeBytes: 10, sourcePath: undefined, title: undefined }])
    const again = stepAll(first.state, { _tag: "Transcript", cursor: "c1", message: entry })
    expect(again.files).toBeUndefined()
  })
})

describe("history", () => {
  it("replays a transcript as user and agent messages with completed tool calls", () => {
    const messages: Array<Message> = [
      { id: "u1", source: "user", text: "Fix the test" },
      { id: "a1", source: "assistant", text: "Looking." },
      { id: "t1", source: "tool", text: "", calls: [{ tool: "read", durationMs: 40 }] },
      { id: "a2", source: "assistant", text: "Found it." },
      { id: "a3", source: "assistant", text: "Fixed." }
    ]
    expect(history(messages).map((h) => h.update)).toEqual([
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix the test" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking." } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "read (40 ms)", kind: "read", status: "completed" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Found it." } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nFixed." } }
    ])
  })
})

  it("replays a call an interrupt stopped as failed", () => {
    const stopped: Message = { id: "t1", source: "tool", tool: "execute", text: "" }
    expect(history([stopped]).map((h) => h.update)).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Stopped tool call", kind: "other", status: "failed" }
    ])
  })
