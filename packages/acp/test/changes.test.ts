import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { type FileChange, makeChangeTracker, makeWorktreeTracker, MAX_PREVIEW_BYTES } from "../src/changes.js"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git = (root: string, ...args: Array<string>) =>
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    stdio: "pipe"
  })

/**
 * A repository with one commit holding README.md, src/app.ts and a .gitignore for `*.log`. Line endings
 * are left alone whatever the machine's git says (Git for Windows sets `core.autocrlf`); CRLF has its own test.
 */
const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "capy-acp-changes-"))
  roots.push(root)
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "core.autocrlf", "false")
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "README.md"), "# demo\n")
  writeFileSync(join(root, "src", "app.ts"), "export const a = 1\n")
  writeFileSync(join(root, ".gitignore"), "*.log\n")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "init")
  return root
}

const byPath = (changes: ReadonlyArray<FileChange>) => Object.fromEntries(changes.map((c) => [c.relativePath, c]))

describe("change tracker", () => {
  it.effect("diffs against the file as checked out, so CRLF line endings don't mark every line changed", () =>
    Effect.gen(function*() {
      // Git for Windows checks text out with CRLF (core.autocrlf); `eol=crlf` does the same on any platform.
      const root = repo()
      writeFileSync(join(root, ".gitattributes"), "*.md text eol=crlf\n")
      git(root, "add", ".gitattributes")
      git(root, "commit", "-q", "-m", "crlf")
      unlinkSync(join(root, "README.md"))
      git(root, "checkout", "--", "README.md")
      const tracker = makeChangeTracker(root)
      yield* tracker.baseline
      writeFileSync(join(root, "README.md"), "# demo\r\nmore\r\n")
      expect(byPath(yield* tracker.collect)["README.md"]).toMatchObject({ oldText: "# demo\r\n", newText: "# demo\r\nmore\r\n" })
      // An LF copy is clean to git too (an editor set to LF): its old text keeps LF.
      writeFileSync(join(root, ".gitattributes"), "*.md text eol=crlf\n*.ts text eol=crlf\n")
      git(root, "commit", "-q", "-m", "ts crlf too", "--", ".gitattributes")
      const lf = makeChangeTracker(root)
      yield* lf.baseline
      writeFileSync(join(root, "src", "app.ts"), "export const a = 2\n")
      expect(byPath(yield* lf.collect)["src/app.ts"]).toMatchObject({ oldText: "export const a = 1\n", newText: "export const a = 2\n" })
    }))

  it.effect("reports modified, added and deleted files with their texts, and skips ignored files", () =>
    Effect.gen(function*() {
      const root = repo()
      const tracker = makeChangeTracker(root)
      yield* tracker.baseline
      writeFileSync(join(root, "README.md"), "# demo\nmore\n")
      mkdirSync(join(root, "docs"))
      writeFileSync(join(root, "docs", "NEW.md"), "new\n")
      unlinkSync(join(root, "src", "app.ts"))
      writeFileSync(join(root, "debug.log"), "noise\n")

      const changes = byPath(yield* tracker.collect)
      expect(Object.keys(changes).sort()).toEqual(["README.md", "docs/NEW.md", "src/app.ts"])
      expect(changes["README.md"]).toEqual({
        path: join(root, "README.md"),
        relativePath: "README.md",
        operation: "modify",
        previewable: true,
        oldText: "# demo\n",
        newText: "# demo\nmore\n"
      })
      expect(changes["docs/NEW.md"]).toMatchObject({ operation: "add", newText: "new\n" })
      expect(changes["docs/NEW.md"]).not.toHaveProperty("oldText")
      expect(changes["src/app.ts"]).toMatchObject({ operation: "delete", oldText: "export const a = 1\n" })
      expect(changes["src/app.ts"]).not.toHaveProperty("newText")

      // Nothing new since the last look.
      expect(yield* tracker.collect).toEqual([])
    }))

  it.effect("does not credit edits that were already there, but diffs later edits from them", () =>
    Effect.gen(function*() {
      const root = repo()
      writeFileSync(join(root, "README.md"), "# demo\nuser edit\n")
      const tracker = makeChangeTracker(root)
      yield* tracker.baseline
      expect(yield* tracker.collect).toEqual([])

      writeFileSync(join(root, "README.md"), "# demo\nuser edit\nagent edit\n")
      const [change] = yield* tracker.collect
      expect(change).toMatchObject({ operation: "modify", oldText: "# demo\nuser edit\n", newText: "# demo\nuser edit\nagent edit\n" })
    }))

  it.effect("diffs tool calls one after another, each from where the last one left off", () =>
    Effect.gen(function*() {
      const root = repo()
      const tracker = makeChangeTracker(root)
      yield* tracker.baseline
      writeFileSync(join(root, "README.md"), "# demo\none\n")
      expect((yield* tracker.collect)[0]).toMatchObject({ oldText: "# demo\n", newText: "# demo\none\n" })
      writeFileSync(join(root, "README.md"), "# demo\none\ntwo\n")
      expect((yield* tracker.collect)[0]).toMatchObject({ oldText: "# demo\none\n", newText: "# demo\none\ntwo\n" })
      // Reverting to the committed text is a change too.
      writeFileSync(join(root, "README.md"), "# demo\n")
      expect((yield* tracker.collect)[0]).toMatchObject({ oldText: "# demo\none\ntwo\n", newText: "# demo\n" })
    }))

  it.effect("finds files the agent committed during the turn", () =>
    Effect.gen(function*() {
      const root = repo()
      const tracker = makeChangeTracker(root)
      yield* tracker.baseline
      writeFileSync(join(root, "CHANGELOG.md"), "v1\n")
      git(root, "add", "CHANGELOG.md")
      git(root, "commit", "-q", "-m", "changelog")
      expect(yield* tracker.collect).toMatchObject([{ relativePath: "CHANGELOG.md", operation: "add", newText: "v1\n" }])
    }))

  it.effect("reports binary and oversized files by path only", () =>
    Effect.gen(function*() {
      const root = repo()
      const tracker = makeChangeTracker(root)
      yield* tracker.baseline
      writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
      writeFileSync(join(root, "big.txt"), "x".repeat(MAX_PREVIEW_BYTES + 1))
      const changes = byPath(yield* tracker.collect)
      for (const name of ["logo.png", "big.txt"]) {
        expect(changes[name]).toEqual({ path: join(root, name), relativePath: name, operation: "add", previewable: false })
      }
    }))

  it.effect("turns itself off, without failing, outside a git repository", () =>
    Effect.gen(function*() {
      const root = mkdtempSync(join(tmpdir(), "capy-acp-nogit-"))
      roots.push(root)
      const errors: Array<string> = []
      const tracker = makeChangeTracker(root, (message) => errors.push(message))
      yield* tracker.baseline
      writeFileSync(join(root, "a.txt"), "a\n")
      expect(yield* tracker.collect).toEqual([])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatch(/^change tracking is off for this turn/)
    }))

  it.effect("shows a new symlink as its target path and never reads the file it points at", () =>
    Effect.gen(function*() {
      const root = repo()
      const outside = mkdtempSync(join(tmpdir(), "capy-acp-outside-"))
      roots.push(outside)
      writeFileSync(join(outside, "secret.txt"), "do not show\n")
      const tracker = makeChangeTracker(root)
      yield* tracker.baseline
      symlinkSync(join(outside, "secret.txt"), join(root, "link"))
      const changes = yield* tracker.collect
      expect(changes).toMatchObject([{ relativePath: "link", operation: "add", newText: join(outside, "secret.txt") }])
      expect(JSON.stringify(changes)).not.toContain("do not show")
    }))
})

describe("worktree tracker", () => {
  /** A Capy home whose thread jam_T has a worktree of acme/app, next to another folder. */
  const capyHome = () => {
    const home = mkdtempSync(join(tmpdir(), "capy-acp-home-"))
    roots.push(home)
    const thread = join(home, "worktrees", "jam_T")
    mkdirSync(join(thread, "other"), { recursive: true })
    writeFileSync(join(thread, ".capy-managed.json"), "{}")
    const root = repo()
    const worktree = join(thread, "app")
    // Without CRLF conversion whatever the machine's git says, as in `repo()`.
    execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", root, worktree], { stdio: "pipe" })
    return { home, worktree }
  }

  it.effect("shows nothing until the thread exists, then credits all of a new worktree's edits", () =>
    Effect.gen(function*() {
      const { home, worktree } = capyHome()
      let threadId: string | undefined
      const tracker = makeWorktreeTracker(home, "acme/app", () => threadId)
      yield* tracker.baseline
      writeFileSync(join(worktree, "README.md"), "# demo\nedited\n")
      expect(yield* tracker.collect).toEqual([])
      threadId = "jam_T"
      expect(yield* tracker.collect).toMatchObject([
        { path: join(worktree, "README.md"), operation: "modify", oldText: "# demo\n", newText: "# demo\nedited\n" }
      ])
      expect(yield* tracker.collect).toEqual([])
    }))

  it.effect("takes a normal baseline when the worktree is there when the turn starts", () =>
    Effect.gen(function*() {
      const { home, worktree } = capyHome()
      writeFileSync(join(worktree, "README.md"), "# demo\nfrom the last turn\n")
      const tracker = makeWorktreeTracker(home, "acme/app", () => "jam_T")
      yield* tracker.baseline
      writeFileSync(join(worktree, "src", "app.ts"), "export const a = 2\n")
      expect((yield* tracker.collect).map((c) => c.relativePath)).toEqual(["src/app.ts"])
    }))

  it.effect("finds a worktree in a folder that the user chose, from Capy's worktree list", () =>
    Effect.gen(function*() {
      const { home, worktree } = capyHome()
      // Capy 0.9.2 and later: Settings, then Devices, then Worktree folder.
      const elsewhere = mkdtempSync(join(tmpdir(), "capy-acp-wt-"))
      roots.push(elsewhere)
      const thread = join(elsewhere, "jam_U")
      mkdirSync(thread)
      execFileSync("git", ["clone", "-q", "-c", "core.autocrlf=false", worktree, join(thread, "app")], { stdio: "pipe" })
      mkdirSync(join(home, "device"), { recursive: true })
      writeFileSync(
        join(home, "device", "workspaces.json"),
        JSON.stringify({ folders: [], worktrees: [{ root: thread, createdJamId: "jam_U", state: "ready" }] })
      )
      const tracker = makeWorktreeTracker(home, "acme/app", () => "jam_U")
      yield* tracker.baseline
      writeFileSync(join(thread, "app", "README.md"), "# demo\nmoved\n")
      expect(yield* tracker.collect).toMatchObject([{ path: join(thread, "app", "README.md"), operation: "modify" }])
    }))
})
