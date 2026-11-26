/**
 * Observes what a Capy thread changes on disk, so ACP clients can show real diffs.
 *
 * Capy's stream names the tools a call ran but never the files or their contents (docs/capy-api-notes.md, ask
 * 3). The thread works on this machine, in the folder the client has open (linked mode) or in its
 * own git worktree, so the adapter can see the changes itself: it records the working tree when a turn
 * starts, then diffs it as tool calls start and finish. Strictly read only: `git status`, `git rev-parse`,
 * `git diff --name-only`, `git cat-file`, directory listings and plain file reads. Git LFS smudging is
 * skipped, so a diff never downloads.
 *
 * Attribution is by time (see turn.ts): a change is credited to the tool call that ran when it happened.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, readdir, readFile, readlink } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { FileChange } from "@capy-acp/core/translate.js"
import { Effect } from "effect"

const exec = promisify(execFile)

export type { FileChange }

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

export const makeChangeTracker = (root: string, onError: (message: string) => void = () => {}): ChangeTracker =>
  trackFolder(root, onError)

/** A folder tracker, plus `fromHead`: a baseline for a folder known to have been clean at its HEAD. */
const trackFolder = (root: string, onError: (message: string) => void): ChangeTracker & { readonly fromHead: Effect.Effect<void> } => {
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

  const fromHead = Effect.gen(function*() {
    disabled = false
    head = yield* readHead
    known = new Map()
  })

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

  return { baseline, collect, fromHead }
}

/**
 * Tracks the git worktree that Capy makes for a thread in worktree mode: `<worktree folder>/<threadId>/<folder>`,
 * where the folder is the repository name (seen with the desktop app and `capy dock`). The API does not say
 * where a thread works (docs/capy-api-notes.md, ask 4). Since Capy 0.9.2 a user can choose the worktree
 * folder, so the thread's folder comes from the worktree list in `device/workspaces.json` (`createdJamId`),
 * and else from the default `<capyHome>/worktrees/<threadId>`. Capy makes the worktree clean at the base commit
 * for the thread's first message, so a worktree found during a turn starts from its HEAD. If the folder is not
 * there, the turn shows no diffs.
 */
export const makeWorktreeTracker = (
  capyHome: string,
  repo: string,
  threadId: () => string | undefined,
  onError: (message: string) => void = () => {}
): ChangeTracker => {
  let folder: ReturnType<typeof trackFolder> | undefined

  const find = Effect.promise(async () => {
    const id = threadId()
    if (id === undefined) return undefined
    const listed = await readFile(join(capyHome, "device", "workspaces.json"), "utf8").then(
      (text) => (JSON.parse(text) as { worktrees?: ReadonlyArray<{ root?: unknown; createdJamId?: unknown }> }).worktrees,
      () => undefined
    )
    const entry = listed?.find((w) => w.createdJamId === id && typeof w.root === "string")
    const dir = typeof entry?.root === "string" ? entry.root : join(capyHome, "worktrees", id)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const names = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name)
    const name = repo.split("/").at(-1)?.toLowerCase()
    const match = names.find((n) => n.toLowerCase() === name) ?? (names.length === 1 ? names[0] : undefined)
    return match === undefined ? undefined : join(dir, match)
  })

  return {
    baseline: Effect.gen(function*() {
      if (folder !== undefined) return yield* folder.baseline
      const root = yield* find
      if (root === undefined) return
      folder = trackFolder(root, onError)
      yield* folder.baseline
    }),
    collect: Effect.gen(function*() {
      if (folder === undefined) {
        const root = yield* find
        if (root === undefined) return []
        folder = trackFolder(root, onError)
        yield* folder.fromHead
      }
      return yield* folder.collect
    })
  }
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
