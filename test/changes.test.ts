import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { type FileChange, makeChangeTracker, MAX_PREVIEW_BYTES, mergeChanges } from "../src/changes.js"

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

describe("mergeChanges", () => {
  const change = (operation: FileChange["operation"], oldText?: string, newText?: string): FileChange => ({
    path: "/r/a.md",
    relativePath: "a.md",
    operation,
    previewable: true,
    ...(oldText === undefined ? {} : { oldText }),
    ...(newText === undefined ? {} : { newText })
  })

  it("keeps the first before and the last after", () => {
    expect(mergeChanges([change("modify", "1", "2")], [change("modify", "2", "3")])).toEqual([change("modify", "1", "3")])
    expect(mergeChanges([change("add", undefined, "1")], [change("modify", "1", "2")])).toEqual([change("add", undefined, "2")])
    expect(mergeChanges([change("modify", "1", "2")], [change("delete", "2")])).toEqual([change("delete", "1")])
  })

  it("drops a file created and deleted within the turn", () => {
    expect(mergeChanges([change("add", undefined, "1")], [change("delete", "1")])).toEqual([])
  })

  it("adds files it has not seen", () => {
    const other = { ...change("add", undefined, "x"), path: "/r/b.md", relativePath: "b.md" }
    expect(mergeChanges([change("modify", "1", "2")], [other])).toEqual([change("modify", "1", "2"), other])
  })
})
