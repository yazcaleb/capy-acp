import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import { decodeEvent, decodeMessage } from "../src/capy/events.js"

describe("transcript entries", () => {
  // Shape of a `GET /threads/{id}/messages` item: absent fields come back as null.
  const listed = {
    id: "01M84PA0000000000000000000",
    source: "user",
    text: "hello",
    tool: null,
    callId: null,
    calls: null,
    model: null,
    clientKey: null,
    createdAt: "2026-11-23T17:00:00.000Z",
    attachments: null,
    authorName: "Someone"
  }

  it("reads list items whose absent fields are null", () => {
    expect(decodeMessage(listed)).toEqual(Option.some({ id: listed.id, source: "user", text: "hello", createdAt: listed.createdAt }))
  })

  it("keeps a tool entry whose duration is not a finite number", () => {
    const entry = { id: "t1", source: "tool", calls: [{ tool: "bash", durationMs: "Infinity" }, { tool: "read", durationMs: 12 }] }
    expect(decodeMessage(entry)).toEqual(Option.some({ id: "t1", source: "tool", calls: [{ tool: "bash" }, { tool: "read", durationMs: 12 }] }))
  })

  it("rejects entries without an id or with an unknown source", () => {
    expect(Option.isNone(decodeMessage({ source: "user" }))).toBe(true)
    expect(Option.isNone(decodeMessage({ id: "x", source: "system" }))).toBe(true)
  })

  it("decodes the same shape from the stream", () => {
    expect(decodeEvent({ event: "transcript", id: "01CURSOR", data: JSON.stringify(listed) })).toMatchObject({
      _tag: "Transcript",
      cursor: "01CURSOR",
      message: { id: listed.id, text: "hello" }
    })
  })

  it("decodes subagent lifecycle frames under both names", () => {
    expect(decodeEvent({ event: "task", data: JSON.stringify({ taskId: "s1", taskPath: "review", status: "working", archived: false }) })).toEqual({
      _tag: "Subagent",
      id: "s1",
      path: "review",
      status: "working"
    })
    expect(decodeEvent({ event: "subagent", data: JSON.stringify({ subagentId: "s1", subagentPath: null, status: "done", archived: false }) })).toEqual({
      _tag: "Subagent",
      id: "s1",
      path: undefined,
      status: "done"
    })
  })
})
