/**
 * Observes what a Capy thread changes in a linked folder, so ACP clients can show real diffs.
 *
 * Capy's stream names the tools a call ran but never the files or their contents (docs/capy-api-notes.md, API
 * gap 4). In linked mode the thread edits the folder the client has open, so the adapter can see
 * the changes itself: it records the working tree when a turn starts, then diffs it after each
 * tool call. Strictly read only: `git status`, `git rev-parse`, `git diff --name-only`,
 * `git cat-file` and plain file reads. Git LFS smudging is skipped, so a diff never downloads.
 *
 * Attribution is by time: a change is credited to the tool call that just finished. Edits the
 * user makes in the same folder during a turn are credited the same way; that is the honest limit
 * of observing from outside.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readFile, readlink } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"

const exec = promisify(execFile)

export interface FileChange {
  /** Absolute path. */
  readonly path: string
  /** Path relative to the folder root, for titles. */
  readonly relativePath: string
  readonly operation: "add" | "modify" | "delete"
  /** Text before the change; absent for added files and for files that cannot be previewed. */
  readonly oldText?: string
  /** Text after the change; absent for deleted files and for files that cannot be previewed. */
  readonly newText?: string
  /** False for binary or very large files: clients get the path but no diff. */
  readonly previewable: boolean
}

export interface ChangeTracker {
  /** Records the folder's current state. Call when a turn starts. */
  readonly baseline: Effect.Effect<void>
  /** Changes since the baseline or the previous collect. Never fails: a broken read yields no changes. */
  readonly collect: Effect.Effect<ReadonlyArray<FileChange>>
}

/** Above this a file is reported by path only: diffs this large don't help anyone in a chat view. */
export const MAX_PREVIEW_BYTES = 256 * 1024
/** A turn that touches more files than this (a dependency install, a generator) reports the first ones. */
export const MAX_TRACKED_FILES = 500
const MAX_GIT_OUTPUT = 64 * 1024 * 1024

/** A file's content at one point in time; `undefined` means the file did not exist. */
interface Content {
  readonly hash: string
  readonly text: string | undefined
}

const utf8 = new TextDecoder("utf-8", { fatal: true })

const toContent = (bytes: Buffer): Content => {
  const hash = createHash("sha256").update(bytes).digest("hex")
  if (bytes.length > MAX_PREVIEW_BYTES || bytes.subarray(0, 8192).includes(0)) return { hash, text: undefined }
  try {
    return { hash, text: utf8.decode(bytes) }
  } catch {
    return { hash, text: undefined }
  }
}

/** Above this a file is compared by size and modification time instead of being read. */
const MAX_READ_BYTES = 16 * 1024 * 1024

/**
 * A working-tree entry as git would see it. A symlink is its target path (what git stores), never
 * the file it points at, which may be outside the folder. Special files and very large files are
 * compared by metadata only and never shown.
 */
const readEntry = async (path: string): Promise<Content | undefined> => {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return toContent(Buffer.from(await readlink(path)))
  if (info.isDirectory()) return undefined
  if (!info.isFile() || info.size > MAX_READ_BYTES) {
    return { hash: `stat:${info.mode}:${info.size}:${info.mtimeMs}`, text: undefined }
  }
  return toContent(await readFile(path))
}

/** Thrown inside the tracker for reads that failed for a reason other than "not there". */
class Unreadable {
  readonly _tag = "Unreadable"
  constructor(readonly path: string) {}
}

export const makeChangeTracker = (root: string, onError: (message: string) => void = () => {}): ChangeTracker => {
  let head: string | undefined
  let known = new Map<string, Content | undefined>()
  /** Set when a baseline could not be taken; the turn then reports no changes rather than wrong ones. */
  let disabled = false

  const git = (args: ReadonlyArray<string>) =>
    Effect.tryPromise({
      try: () =>
        exec("git", ["-C", root, ...args], {
          encoding: "buffer",
          maxBuffer: MAX_GIT_OUTPUT,
          timeout: 15_000,
          env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }
        }),
      catch: (error) => error
    }).pipe(Effect.map(({ stdout }) => stdout))

  const readHead = git(["rev-parse", "--verify", "--quiet", "HEAD"]).pipe(
    Effect.map((out) => out.toString("utf8").trim() || undefined),
    // A repository with no commits yet has no HEAD.
    Effect.orElseSucceed(() => undefined)
  )

  /** Paths git reports as changed or untracked (ignored files excluded), relative to the root. */
  const dirtyPaths = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]).pipe(
    Effect.map((out) =>
      out
        .toString("utf8")
        .split("\0")
        .filter((entry) => entry.length > 3)
        .map((entry) => entry.slice(3))
    )
  )

  const committedPaths = (from: string, to: string) =>
    git(["diff", "--name-only", "-z", "--no-renames", from, to]).pipe(
      Effect.map((out) => out.toString("utf8").split("\0").filter((path) => path.length > 0))
    )

  const catFile = (mode: "--filters" | "blob", commit: string, path: string): Effect.Effect<Content | undefined> =>
    git(["cat-file", mode, `${commit}:${path}`]).pipe(
      Effect.map(toContent),
      Effect.orElseSucceed(() => undefined)
    )

  /**
   * The file as committed at `commit` and as it most likely sat on disk, or undefined when it isn't in
   * that commit. `--filters` applies the checkout conversions (Git for Windows' CRLF line endings,
   * `.gitattributes` eol and smudge filters). Git also counts an LF copy as clean under `core.autocrlf`,
   * so when only the raw blob's line endings match the working file's, the raw blob it is.
   */
  const readCommitted = (commit: string | undefined, path: string, working: Content | undefined) =>
    Effect.gen(function*() {
      if (commit === undefined) return undefined
      const checkedOut = yield* catFile("--filters", commit, path)
      const crlf = (content: Content | undefined) => content?.text?.includes("\r\n")
      if (working?.text === undefined || checkedOut?.text === undefined || crlf(checkedOut) === crlf(working)) return checkedOut
      const raw = yield* catFile("blob", commit, path)
      return crlf(raw) === crlf(working) ? raw : checkedOut
    })

  const readWorking = (path: string): Effect.Effect<Content | undefined, Unreadable> =>
    Effect.tryPromise({
      try: () => readEntry(join(root, path)),
      catch: (error) => error
    }).pipe(
      Effect.catch((error) => {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        // Gone, or a directory (a submodule or nested repository): nothing to diff.
        return code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" ? Effect.succeed(undefined) : Effect.fail(new Unreadable(path))
      })
    )

  const baseline = Effect.gen(function*() {
    disabled = false
    head = yield* readHead
    const dirty = (yield* dirtyPaths).slice(0, MAX_TRACKED_FILES)
    const contents = yield* Effect.forEach(dirty, (path) => readWorking(path).pipe(Effect.map((content) => [path, content] as const)), {
      concurrency: 8
    })
    known = new Map(contents)
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        // Without a baseline, every pre-existing edit would later look like the agent's.
        head = undefined
        known = new Map()
        onError(`change tracking is off for this turn: ${describe(error)}`)
        disabled = true
      })
    )
  )

  const collect = Effect.gen(function*() {
    if (disabled) return []
    const nextHead = yield* readHead
    const candidates = new Set([...known.keys(), ...(yield* dirtyPaths)])
    // A commit inside the turn makes its files clean again; find them through the commit range.
    if (head !== undefined && nextHead !== undefined && nextHead !== head) {
      for (const path of yield* committedPaths(head, nextHead)) candidates.add(path)
    }
    const paths = [...candidates].sort().slice(0, MAX_TRACKED_FILES)
    const changes = yield* Effect.forEach(
      paths,
      (path) =>
        Effect.gen(function*() {
          const after = yield* readWorking(path)
          const before = known.has(path) ? known.get(path) : yield* readCommitted(head, path, after)
          known.set(path, after)
          return before?.hash === after?.hash ? [] : [toChange(root, path, before, after)]
        }).pipe(Effect.catch(() => Effect.succeed([] as Array<FileChange>))),
      { concurrency: 8 }
    )
    head = nextHead
    return changes.flat()
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        onError(`could not read changes in ${root}: ${describe(error)}`)
        return [] as Array<FileChange>
      })
    )
  )

  return { baseline, collect }
}

const describe = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0] : String(error))

const toChange = (root: string, relativePath: string, before: Content | undefined, after: Content | undefined): FileChange => {
  const operation = before === undefined ? "add" : after === undefined ? "delete" : "modify"
  const previewable = (before === undefined || before.text !== undefined) && (after === undefined || after.text !== undefined)
  return {
    path: join(root, relativePath),
    relativePath,
    operation,
    previewable,
    ...(previewable && before?.text !== undefined ? { oldText: before.text } : {}),
    ...(previewable && after?.text !== undefined ? { newText: after.text } : {})
  }
}

/**
 * Folds later changes into earlier ones per path: the first `before` and the last `after` win.
 * Used when changes found at the end of a turn join a tool call that already reported some,
 * because an ACP `content` update replaces the previous content rather than appending to it.
 */
export const mergeChanges = (earlier: ReadonlyArray<FileChange>, later: ReadonlyArray<FileChange>): ReadonlyArray<FileChange> => {
  const byPath = new Map(earlier.map((change) => [change.path, change]))
  for (const change of later) {
    const first = byPath.get(change.path)
    if (first === undefined) {
      byPath.set(change.path, change)
      continue
    }
    const existedBefore = first.operation !== "add"
    const existsAfter = change.operation !== "delete"
    if (!existedBefore && !existsAfter) {
      // Created and deleted within the same turn: nothing left to show.
      byPath.delete(change.path)
      continue
    }
    const previewable = first.previewable && change.previewable
    byPath.set(change.path, {
      path: change.path,
      relativePath: change.relativePath,
      operation: !existedBefore ? "add" : !existsAfter ? "delete" : "modify",
      previewable,
      ...(previewable && first.oldText !== undefined ? { oldText: first.oldText } : {}),
      ...(previewable && change.newText !== undefined ? { newText: change.newText } : {})
    })
  }
  return [...byPath.values()]
}
