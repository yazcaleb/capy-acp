/**
 * Session mapper: the folder an ACP client opens, then its git remotes, then a Capy project, then a device workspace.
 *
 * The device id comes from the files Capy keeps on this machine (desktop app or `capy dock`), read only: the
 * API has no endpoint that lists devices. The list of linked folders comes from there too, but only as a
 * hint. Capy itself checks the folder when the thread starts, so a list that is old, moved or unreadable
 * costs at most one refused thread create, which the reply turns into the fix.
 */
import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { join, posix, relative, resolve, win32 } from "node:path"
import { promisify } from "node:util"
import type { AdapterConfig } from "./config.js"
import {
  type DeviceFile,
  type DeviceKind,
  manyOrganizations,
  noDevice,
  noGitHubRemote,
  notGit,
  notInProject,
  notLinked,
  type Problem,
  ProblemError,
  unreadableDeviceFile
} from "./problems.js"

const run = promisify(execFile)

export interface LinkedFolder {
  /** The root exactly as Capy stores it; thread creates must send this string. */
  readonly root: string
  readonly repos: ReadonlyArray<string>
  /** The root with symlinks resolved (macOS `/tmp` is `/private/tmp`), for matching only. */
  readonly realRoot?: string
}

/** Path equality across platforms: Windows and macOS file systems ignore case by default. */
export const samePath = (a: string, b: string, platform: NodeJS.Platform = process.platform): boolean => {
  const norm = (p: string) => {
    const resolved = (platform === "win32" ? win32 : posix).resolve(p)
    return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved
  }
  return norm(a) === norm(b)
}

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly repos: ReadonlyArray<{ readonly repoFullName: string }>
}

export type DeviceWorkspace =
  | { readonly kind: "linked"; readonly root: string }
  | { readonly kind: "worktree" }

/** A Capy cloud machine: no device, and nothing on this computer. */
export interface CloudWorkspace {
  readonly kind: "cloud"
}

export interface ResolvedWorkspace<W extends DeviceWorkspace | CloudWorkspace = DeviceWorkspace> {
  readonly projectId: string
  readonly projectName: string
  readonly repo: string
  readonly workspace: W
  /** Shown to the user once, in the first reply, when the thread will not edit the open folder. */
  readonly note: string | undefined
  /** What to show if Capy refuses the linked root: how to link the folder. */
  readonly notLinked: Problem
}

export type Resolution<W extends DeviceWorkspace | CloudWorkspace = DeviceWorkspace> =
  | { readonly _tag: "Resolved"; readonly value: ResolvedWorkspace<W> }
  | { readonly _tag: "Unresolved"; readonly problem: Problem }

/**
 * `owner/repo` from a remote URL, lowercased for matching. Any host name counts, because ssh configs often
 * give github.com another name (`git@github-work:acme/app.git`). Only repositories of the user's Capy
 * projects can match, and Capy works only with GitHub.com.
 */
export const parseRemote = (url: string): string | undefined => {
  const trimmed = url.trim()
  // `scheme://host/path`, or scp style `user@host:path`.
  const path = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.*)$/i.exec(trimmed)?.[1] ?? /^[^/:\s]+:(?!\/\/)(.*)$/.exec(trimmed)?.[1]
  const parts = path?.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter((part) => part !== "")
  return parts !== undefined && parts.length >= 2 ? parts.slice(-2).join("/").toLowerCase() : undefined
}

export const resolveWorkspace = (input: {
  readonly cwd: string
  readonly gitRoot: string | undefined
  /** The git root in the spelling of the opened folder, which git does not keep (see `readGit`). */
  readonly openedRoot?: string | undefined
  /** `owner/repo` of each git remote, `origin` first. */
  readonly repos: ReadonlyArray<string>
  readonly linked: ReadonlyArray<LinkedFolder>
  readonly projects: ReadonlyArray<ProjectSummary>
  readonly mode: Exclude<AdapterConfig["workspaceMode"], "cloud">
  readonly allowWorktreeFallback: boolean
  /** How this computer is paired, for the steps that link a folder. */
  readonly device?: DeviceKind | undefined
  readonly platform?: NodeJS.Platform
}): Resolution => {
  const unresolved = (problem: Problem): Resolution => ({ _tag: "Unresolved", problem })
  if (input.gitRoot === undefined) return unresolved(notGit(input.cwd))
  const gitRoot = input.gitRoot
  const here = input.linked.find((folder) => samePath(folder.realRoot ?? folder.root, gitRoot) || samePath(folder.root, gitRoot))
  // A linked folder lists its repositories, so a clone whose remotes name none of them still matches.
  const candidates = [...new Set([...input.repos, ...(here?.repos ?? []).map((r) => r.toLowerCase())])]
  const matches = (repo: string) => input.projects.find((p) => p.repos.some((r) => r.repoFullName.toLowerCase() === repo))
  const repo = candidates.find((candidate) => matches(candidate) !== undefined)
  const project = repo === undefined ? undefined : matches(repo)
  if (repo === undefined || project === undefined) {
    return unresolved(candidates.length === 0 ? noGitHubRemote(gitRoot) : notInProject(candidates))
  }
  const sameRepo = input.linked.find((folder) => folder !== here && folder.repos.some((r) => r.toLowerCase() === repo))
  const notLinkedHere = notLinked({
    root: gitRoot,
    repo,
    projectId: project.id,
    projectName: project.name,
    device: input.device,
    sameRepoRoot: sameRepo?.root
  })
  const base = { projectId: project.id, projectName: project.name, repo, notLinked: notLinkedHere }
  if (here !== undefined) {
    return input.mode === "linked"
      ? { _tag: "Resolved", value: { ...base, workspace: { kind: "linked", root: here.root }, note: undefined } }
      : {
          _tag: "Resolved",
          value: {
            ...base,
            workspace: { kind: "worktree" },
            note: "Capy is working in its own git worktree (in Capy's worktree folder, ~/.capy/worktrees by default), not in this folder (CAPY_ACP_WORKSPACE=worktree)."
          }
        }
  }
  if (sameRepo !== undefined && input.allowWorktreeFallback) {
    return {
      _tag: "Resolved",
      value: {
        ...base,
        workspace: { kind: "worktree" },
        note:
          `${input.gitRoot} is not linked to this Capy device, so Capy is working in a new worktree of ${sameRepo.root} ` +
          "in Capy's worktree folder (~/.capy/worktrees by default). Its edits will not appear in this folder."
      }
    }
  }
  if (input.mode === "worktree") {
    // A worktree is made from a linked folder of the repository, and none is known.
    return unresolved(notLinkedHere)
  }
  // Not in the local list, which can be older than Capy's own, or unreadable. Capy checks the root when
  // the thread starts and refuses one it does not link; the reply then gives `notLinked`. Git prints
  // Windows paths with forward slashes, so the root goes in the form Windows gives it.
  const opened = input.openedRoot ?? gitRoot
  const root = (input.platform ?? process.platform) === "win32" ? win32.normalize(opened) : opened
  return { _tag: "Resolved", value: { ...base, workspace: { kind: "linked", root }, note: undefined } }
}

/**
 * The project and repository of the folder's GitHub remote, for a thread on a Capy cloud machine. Linked
 * folders and devices play no part: the machine clones the repository from GitHub.
 */
export const resolveCloud = (input: {
  readonly cwd: string
  readonly gitRoot: string | undefined
  readonly repos: ReadonlyArray<string>
  readonly projects: ReadonlyArray<ProjectSummary>
}): Resolution<CloudWorkspace> => {
  const resolution = resolveWorkspace({ ...input, linked: [], mode: "linked", allowWorktreeFallback: false })
  if (resolution._tag === "Unresolved") return resolution
  return {
    _tag: "Resolved",
    value: {
      ...resolution.value,
      workspace: { kind: "cloud" },
      note:
        `Capy works on ${resolution.value.repo} on a Capy cloud machine (CAPY_ACP_WORKSPACE=cloud), not in this folder, so its edits ` +
        "do not show here as diffs. Ask Capy to push a branch or open a pull request to get them. Machine time costs Capy credits."
    }
  }
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"))

export interface Device {
  readonly id: string
  /** Undefined when `CAPY_DEVICE_ID` names the device. */
  readonly kind: DeviceKind | undefined
}

/**
 * The paired device. With several organizations, `CAPY_DEVICE_ID` picks one explicitly.
 *
 * A machine is paired either by the desktop app (`device-ids.json`, one id per organization) or by the headless
 * `capy dock` daemon, which records its one device in `~/.capy/dock/status.json`. Both share `~/.capy/device`.
 */
export const readDevice = async (config: AdapterConfig): Promise<Device> => {
  if (config.deviceIdOverride) return { id: config.deviceIdOverride, kind: undefined }
  const desktop = join(config.capyDesktopConfigDir, "device-ids.json")
  const checked: Array<DeviceFile> = []
  let ids: Array<string> = []
  try {
    const data = (await readJson(desktop)) as { orgs?: Record<string, unknown> }
    ids = Object.values(data.orgs ?? {}).filter((id): id is string => typeof id === "string" && id !== "")
    checked.push({ path: desktop, found: "no device" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProblemError(unreadableDeviceFile(desktop, error instanceof Error ? error.message : String(error)))
    }
    checked.push({ path: desktop, found: "missing" })
  }
  if (ids.length === 1 && ids[0]) return { id: ids[0], kind: "desktop" }
  if (ids.length > 1) throw new ProblemError(manyOrganizations(ids.length))
  const dock = join(config.capyHome, "dock", "status.json")
  const docked = await readJson(dock).then(
    (data) => ({ found: "no device" as const, id: (data as { deviceId?: unknown }).deviceId }),
    () => ({ found: "missing" as const, id: undefined })
  )
  if (typeof docked.id === "string" && docked.id !== "") return { id: docked.id, kind: "dock" }
  checked.push({ path: dock, found: docked.found })
  throw new ProblemError(noDevice(checked))
}

export const readLinkedFolders = async (config: AdapterConfig): Promise<ReadonlyArray<LinkedFolder>> => {
  try {
    const data = (await readJson(join(config.capyHome, "device", "workspaces.json"))) as {
      folders?: ReadonlyArray<{ root?: unknown; repos?: unknown }>
    }
    const folders = (data.folders ?? []).flatMap((folder) =>
      typeof folder.root === "string"
        ? [{ root: folder.root, repos: Array.isArray(folder.repos) ? folder.repos.filter((r) => typeof r === "string") : [] }]
        : []
    )
    return Promise.all(
      folders.map(async (folder) => ({ ...folder, realRoot: await realpath(folder.root).catch(() => folder.root) }))
    )
  } catch {
    return []
  }
}

export const readGit = async (
  cwd: string
): Promise<{ gitRoot: string | undefined; openedRoot: string | undefined; repos: ReadonlyArray<string> }> => {
  const git = async (...args: Array<string>) => {
    try {
      return (await run("git", ["-C", cwd, ...args], { timeout: 5_000 })).stdout.trim()
    } catch {
      return undefined
    }
  }
  const gitRoot = await git("rev-parse", "--show-toplevel")
  // `git remote -v` prints URLs after `insteadOf` rewrites: "<name>\t<url> (fetch)".
  const remotes = gitRoot === undefined ? [] : ((await git("remote", "-v")) ?? "").split("\n").flatMap((line) => {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    return match ? [{ name: match[1]!, url: match[2]! }] : []
  })
  const ordered = [...remotes.filter((r) => r.name === "origin"), ...remotes.filter((r) => r.name !== "origin")]
  const repos = [...new Set(ordered.flatMap((remote) => parseRemote(remote.url) ?? []))]
  // Git resolves symlinks (macOS `/tmp` is `/private/tmp`), and Capy keeps the spelling the user linked,
  // which is most likely the one the client opened.
  const openedRoot = gitRoot === undefined
    ? undefined
    : await realpath(cwd).then((real) => resolve(cwd, relative(real, gitRoot)), () => gitRoot)
  return { gitRoot, openedRoot, repos }
}
