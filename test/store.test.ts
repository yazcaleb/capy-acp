import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { makeSessionStore, type SessionRecord } from "../src/store.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "capy-acp-store-"))
  dirs.push(dir)
  return join(dir, "sessions")
}

const record = (sessionId: string, updatedAt: string): SessionRecord => ({
  sessionId,
  cwd: "/home/dev/repo",
  threadId: `jam_${sessionId}`,
  cursor: "01CURSOR",
  model: "anthropic/claude-opus-5-5",
  reasoning: "high",
  title: "Fix the test",
  updatedAt
})

describe("session store", () => {
  it("saves, reads back and lists records newest first, private to the user", async () => {
    const dir = tempDir()
    const store = makeSessionStore(dir)
    await store.save(record("a", "2026-11-23T10:00:00.000Z"))
    await store.save(record("b", "2026-11-23T11:00:00.000Z"))
    await store.save({ ...record("a", "2026-11-23T12:00:00.000Z"), cursor: "01LATER" })
    expect(await store.get("a")).toEqual({ ...record("a", "2026-11-23T12:00:00.000Z"), cursor: "01LATER" })
    expect((await store.list()).map((r) => r.sessionId)).toEqual(["a", "b"])
    // Windows has no POSIX modes; the file inherits the user profile's ACL.
    if (process.platform !== "win32") expect(statSync(join(dir, "a.json")).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir).sort()).toEqual(["a.json", "b.json"])
  })

  it("answers nothing for unknown, unsafe or corrupt sessions, and an empty list before the first save", async () => {
    const dir = tempDir()
    const store = makeSessionStore(dir)
    expect(await store.list()).toEqual([])
    expect(await store.get("missing")).toBeUndefined()
    await store.save(record("../escape", "2026-11-23T10:00:00.000Z"))
    expect(await store.get("../escape")).toBeUndefined()
    await store.save(record("ok", "2026-11-23T10:00:00.000Z"))
    writeFileSync(join(dir, "bad.json"), "{not json")
    writeFileSync(join(dir, "partial.json"), JSON.stringify({ sessionId: "partial" }))
    expect(await store.get("bad")).toBeUndefined()
    expect((await store.list()).map((r) => r.sessionId)).toEqual(["ok"])
    expect(readdirSync(join(dir, ".."))).toEqual(["sessions"])
  })

  it("survives many saves of one session at once", async () => {
    const dir = tempDir()
    const store = makeSessionStore(dir)
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.save(record("same", `2026-11-24T00:00:${String(i % 60).padStart(2, "0")}Z`))))
    expect((await store.get("same"))?.threadId).toBe("jam_same")
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })
})
