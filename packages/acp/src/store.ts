/**
 * Remembers which Capy thread each ACP session drives, so `session/load` and `session/resume`
 * work after the client or the adapter restarts.
 *
 * One small JSON file per session under the state directory: T3 Code runs one adapter process
 * per thread, and separate files need no locking between them. Writes go to a temp file first
 * and are renamed into place, so a crash never leaves a half-written record. Records hold ids and
 * settings only, never credentials.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Schema } from "effect"

export const SessionRecord = Schema.Struct({
  sessionId: Schema.String,
  cwd: Schema.String,
  threadId: Schema.String,
  /** Last transcript event id the client has seen; the next stream resumes after it. */
  cursor: Schema.optionalKey(Schema.String),
  model: Schema.String,
  reasoning: Schema.String,
  title: Schema.optionalKey(Schema.String),
  updatedAt: Schema.String
})
export type SessionRecord = typeof SessionRecord.Type

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(SessionRecord))

/** Session ids come from clients; only plain ids may become file names. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface SessionStore {
  readonly get: (sessionId: string) => Promise<SessionRecord | undefined>
  readonly save: (record: SessionRecord) => Promise<void>
  /** Newest first. */
  readonly list: () => Promise<ReadonlyArray<SessionRecord>>
}

export const makeSessionStore = (dir: string): SessionStore => {
  const file = (sessionId: string) => join(dir, `${sessionId}.json`)
  // Saves of one session run one at a time, in call order: Windows refuses a rename onto a file that
  // another rename is replacing (EPERM, seen on Windows Server 2022), and the last save must win.
  const queues = new Map<string, Promise<void>>()
  const write = async (record: SessionRecord) => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // Unique per write, so a crashed or failed write never collides with the next one.
    const temp = `${file(record.sessionId)}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, file(record.sessionId))
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
  const read = async (path: string): Promise<SessionRecord | undefined> => {
    try {
      const record = decode(await readFile(path, "utf8"))
      return record._tag === "Some" ? record.value : undefined
    } catch {
      return undefined
    }
  }
  return {
    get: async (sessionId) => (SAFE_ID.test(sessionId) ? read(file(sessionId)) : undefined),
    save: (record) => {
      if (!SAFE_ID.test(record.sessionId)) return Promise.resolve()
      const id = record.sessionId
      const next = (queues.get(id) ?? Promise.resolve()).then(() => write(record), () => write(record))
      queues.set(id, next)
      const settle = () => {
        if (queues.get(id) === next) queues.delete(id)
      }
      next.then(settle, settle)
      return next
    },
    list: async () => {
      let names: Array<string>
      try {
        names = await readdir(dir)
      } catch {
        return []
      }
      const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => read(join(dir, name))))
      return records
        .filter((record): record is SessionRecord => record !== undefined)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }
  }
}
