/**
 * Adapter settings, read from the environment the ACP client launches us with.
 * T3 Code passes per-instance environment overrides, so every knob is an env var.
 */
import { homedir } from "node:os"
import { join, posix, win32 } from "node:path"

export interface AdapterConfig {
  readonly apiUrl: string
  /** File holding the API key, used when `CAPY_API_KEY` is unset. Never logged. */
  readonly apiKeyFile: string
  readonly defaultModel: string
  readonly defaultReasoning: string
  /** `linked` edits the folder the client opened; `worktree` gives each session a fresh Capy worktree. */
  readonly workspaceMode: "linked" | "worktree"
  /** Run unlinked clones in a worktree cut from another linked folder of the same repo. */
  readonly allowWorktreeFallback: boolean
  /** How long a prompt stays open while the thread is `waiting` on a background command. */
  readonly waitingLimitMs: number
  readonly forwardHostInstructions: boolean
  readonly deviceIdOverride: string | undefined
  readonly capyDesktopConfigDir: string
  readonly capyHome: string
  /** Where session records live (session → Capy thread), for `session/load` and `session/resume`. */
  readonly stateDir: string
  /** Where files from a thread's first prompt are saved for the device agent to read. */
  readonly attachmentsDir: string
}

const flag = (value: string | undefined) => value === "1" || value === "true"

/**
 * Where the Capy desktop app keeps its files: Electron's per-user app data folder. Only the Linux
 * location has been seen in practice; `CAPY_DESKTOP_CONFIG_DIR` overrides it.
 */
export const desktopConfigDir = (env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string => {
  const { join } = platform === "win32" ? win32 : posix
  if (platform === "darwin") return join(home, "Library", "Application Support", "Capy")
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Capy")
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Capy")
}

export const readConfig = (env: NodeJS.ProcessEnv = process.env): AdapterConfig => {
  const home = homedir()
  const waiting = Number(env.CAPY_ACP_WAITING_LIMIT_MS ?? 10 * 60_000)
  return {
    apiUrl: (env.CAPY_API_URL ?? "https://api.capy.ai/api/v1").replace(/\/+$/, ""),
    apiKeyFile: env.CAPY_API_KEY_FILE ?? join(home, ".config", "capy-acp", "api-key"),
    defaultModel: env.CAPY_ACP_MODEL ?? "anthropic/claude-opus-5-5",
    defaultReasoning: env.CAPY_ACP_REASONING ?? "high",
    workspaceMode: env.CAPY_ACP_WORKSPACE === "worktree" ? "worktree" : "linked",
    allowWorktreeFallback: flag(env.CAPY_ACP_ALLOW_WORKTREE_FALLBACK),
    waitingLimitMs: Number.isFinite(waiting) && waiting >= 0 ? waiting : 10 * 60_000,
    forwardHostInstructions: flag(env.CAPY_ACP_FORWARD_HOST_INSTRUCTIONS),
    deviceIdOverride: env.CAPY_DEVICE_ID,
    capyDesktopConfigDir: env.CAPY_DESKTOP_CONFIG_DIR ?? desktopConfigDir(env, home),
    capyHome: env.CAPY_HOME ?? join(home, ".capy"),
    stateDir: env.CAPY_ACP_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "capy-acp", "sessions"),
    attachmentsDir: env.CAPY_ACP_ATTACHMENTS_DIR ?? join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "capy-acp", "attachments")
  }
}
