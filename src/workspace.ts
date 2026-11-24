/**
 * Session mapper: the folder an ACP client opens → git remote → Capy project → device workspace.
 *
 * The device id and linked folders are read from the files Capy keeps on this machine (desktop app or
 * `capy dock`), read only. Capy owns those files (it rewrites them from server state), and the API has no
 * endpoint to list devices or link folders, so reading them is the only way to target this machine.
 */
import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { join, posix, win32 } from "node:path"
import { promisify } from "node:util"
import type { AdapterConfig } from "./config.js"

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

export interface ResolvedWorkspace {
  readonly projectId: string
  readonly projectName: string
  readonly repo: string
  readonly workspace: DeviceWorkspace
  /** Shown to the user once, in the first reply, when the thread will not edit the open folder. */
  readonly note: string | undefined
}

export type Resolution =
  | { readonly _tag: "Resolved"; readonly value: ResolvedWorkspace }
  | { readonly _tag: "Unresolved"; readonly message: string }

/** `owner/repo` from an https or ssh GitHub remote, lowercased for matching. */
export const parseRemote = (url: string): string | undefined => {
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined
}

export const resolveWorkspace = (input: {
  readonly cwd: string
  readonly gitRoot: string | undefined
  readonly repo: string | undefined
  readonly linked: ReadonlyArray<LinkedFolder>
  readonly projects: ReadonlyArray<ProjectSummary>
  readonly mode: AdapterConfig["workspaceMode"]
  readonly allowWorktreeFallback: boolean
}): Resolution => {
  const unresolved = (message: string): Resolution => ({ _tag: "Unresolved", message })
  if (input.gitRoot === undefined || input.repo === undefined) {
    return unresolved(
      `${input.cwd} is not a clone of a GitHub repository (no "origin" remote). ` +
        "capy-acp runs Capy threads on a repository that belongs to a Capy project."
    )
  }
  const repo = input.repo
  const project = input.projects.find((p) => p.repos.some((r) => r.repoFullName.toLowerCase() === repo))
  if (project === undefined) {
    return unresolved(`No Capy project includes ${repo}. Add the repository to a project at https://capy.ai, then retry.`)
  }
  const base = { projectId: project.id, projectName: project.name, repo }
  const gitRoot = input.gitRoot
  const here = input.linked.find((folder) => samePath(folder.realRoot ?? folder.root, gitRoot) || samePath(folder.root, gitRoot))
  if (here !== undefined) {
    return input.mode === "linked"
      ? { _tag: "Resolved", value: { ...base, workspace: { kind: "linked", root: here.root }, note: undefined } }
      : {
          _tag: "Resolved",
          value: {
            ...base,
            workspace: { kind: "worktree" },
            note: "Capy is working in its own git worktree under ~/.capy/worktrees, not in this folder (CAPY_ACP_WORKSPACE=worktree)."
          }
        }
  }
  const sameRepo = input.linked.find((folder) => folder.repos.some((r) => r.toLowerCase() === repo))
  if (sameRepo !== undefined && input.allowWorktreeFallback) {
    return {
      _tag: "Resolved",
      value: {
        ...base,
        workspace: { kind: "worktree" },
        note:
          `${input.gitRoot} is not linked to this Capy device, so Capy is working in a new worktree of ${sameRepo.root} ` +
          "under ~/.capy/worktrees. Its edits will not appear in this folder."
      }
    }
  }
  const fix =
    `Link ${input.gitRoot} to this device in Capy: open https://capy.ai/settings/projects, choose "${project.name}", ` +
    "and add the folder under Project folders (or use Scan a folder in the Capy desktop app, or run `capy dock dirs add` " +
    "on a machine paired with capy dock). Then send your message again."
  const fallback =
    sameRepo === undefined
      ? ""
      : ` Or set CAPY_ACP_ALLOW_WORKTREE_FALLBACK=1 to work in a worktree of ${sameRepo.root} instead.`
  return unresolved(`${input.gitRoot} is not a linked folder on this Capy device. ${fix}${fallback}`)
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"))

/**
 * The paired device's id. With several organizations, `CAPY_DEVICE_ID` picks one explicitly.
 *
 * A machine is paired either by the desktop app (`device-ids.json`, one id per organization) or by the headless
 * `capy dock` daemon, which records its one device in `~/.capy/dock/status.json`. Both share `~/.capy/device`.
 */
export const readDeviceId = async (config: AdapterConfig): Promise<string> => {
  if (config.deviceIdOverride) return config.deviceIdOverride
  const desktop = join(config.capyDesktopConfigDir, "device-ids.json")
  let ids: Array<string> = []
  try {
    const data = (await readJson(desktop)) as { orgs?: Record<string, unknown> }
    ids = Object.values(data.orgs ?? {}).filter((id): id is string => typeof id === "string" && id !== "")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not read the Capy desktop app's device file ${desktop}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (ids.length === 1 && ids[0]) return ids[0]
  if (ids.length > 1) throw new Error(`This machine is paired with ${ids.length} Capy organizations; set CAPY_DEVICE_ID to choose one.`)
  const dock = join(config.capyHome, "dock", "status.json")
  const docked = await readJson(dock).then(
    (data) => (data as { deviceId?: unknown }).deviceId,
    () => undefined
  )
  if (typeof docked === "string" && docked !== "") return docked
  throw new Error(
    `No paired Capy device found: neither ${desktop} nor ${dock} names one. Sign in to the Capy desktop app on this machine, ` +
      "or pair it with `capy dock`, or set CAPY_DEVICE_ID (and CAPY_DESKTOP_CONFIG_DIR or CAPY_HOME if Capy keeps its files elsewhere)."
  )
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

export const readGit = async (cwd: string): Promise<{ gitRoot: string | undefined; repo: string | undefined }> => {
  const git = async (...args: Array<string>) => {
    try {
      return (await run("git", ["-C", cwd, ...args], { timeout: 5_000 })).stdout.trim()
    } catch {
      return undefined
    }
  }
  const gitRoot = await git("rev-parse", "--show-toplevel")
  const remote = gitRoot === undefined ? undefined : await git("remote", "get-url", "origin")
  return { gitRoot, repo: remote === undefined ? undefined : parseRemote(remote) }
}
