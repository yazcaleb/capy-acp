import { describe, expect, it } from "@effect/vitest"
import { makeSseParser, parseSse } from "../src/sse.js"

describe("sse", () => {
  it("parses event, data and id fields and ignores retry and comments", () => {
    const frames = parseSse(": hi\nevent: status\ndata: {\"a\":1}\n\nretry: 2000\n\nid: 01J\nevent: transcript\ndata: {}\n\n")
    expect(frames).toEqual([
      { event: "status", data: "{\"a\":1}" },
      { event: "transcript", data: "{}", id: "01J" }
    ])
  })

  it("reassembles frames split across arbitrary chunk boundaries, including CRLF", () => {
    const text = "event: assistant\r\ndata: {\"text\":\"he\"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n"
    for (let size = 1; size <= text.length; size++) {
      const parser = makeSseParser()
      const frames = []
      for (let i = 0; i < text.length; i += size) frames.push(...parser.push(text.slice(i, i + size)))
      frames.push(...parser.end())
      expect(frames.map((frame) => frame.event)).toEqual(["assistant", "done"])
    }
  })

  it("joins multi-line data and flushes a final frame without a blank line", () => {
    expect(parseSse("data: a\ndata: b")).toEqual([{ event: "message", data: "a\nb" }])
  })

  it("reads one very long line in time linear in its length", () => {
    const parser = makeSseParser()
    const chunk = "x".repeat(16 * 1024)
    const started = performance.now()
    parser.push("event: assistant\ndata: ")
    for (let i = 0; i < 512; i++) parser.push(chunk) // 8 MB on one line
    const frames = parser.push("\n\n")
    expect(frames[0]?.data.length).toBe(8 * 1024 * 1024)
    // Rescanning the whole buffer per chunk took seconds here; one pass takes milliseconds.
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})
