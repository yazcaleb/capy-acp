/**
 * Settings, read from the environment that starts the tool: an ACP client, an MCP client or a shell.
 * T3 Code passes per-instance environment overrides, so every knob is an env var.
 */
import { homedir } from "node:os"
import { join, posix, win32 } from "node:path"

/**
 * The published package that runs this shared code: capy-acp, capy-mcp-server or capy-cli. The core is
 * bundled into each, so texts that name the tool or one of its commands take them from here.
 */
export interface Product {
  /** The npm package, such as `capy-cli`. */
  readonly name: string
  /**
   * Where its texts reach the person: an editor chat (`acp`), a calling agent (`mcp`), or a terminal or
   * CI log (`cli`). Only the chat gets steps such as "Send your message again."
   */
  readonly kind: "acp" | "mcp" | "cli"
  /** Where the person sets `CAPY_API_KEY` and the other env vars, such as "the shell or CI job that runs capy-cli". */
  readonly env: string
  readonly version: string
  /** Saves the shared Capy API key and sets up a Capy device, such as `npx -y capy-cli setup`. */
  readonly setup: string
  /** Checks the setup for a folder and prints this computer's Capy device id. */
  readonly doctor: string
  /** Lists recent threads. */
  readonly threads: string
  /** Runs the newest version, such as `npx -y capy-cli@latest`. */
  readonly latest: string
}

/** How texts name the key. All three packages read the same key file, so one setup serves them all. */
export const SHARED_KEY = "the Capy API key that capy-acp, capy-mcp-server and capy-cli share"

export interface AdapterConfig {
  readonly product: Product
  readonly apiUrl: string
  /** File holding the API key, used when `CAPY_API_KEY` is unset. Never logged. */
  readonly apiKeyFile: string
  /** The docs page with the model price table; empty turns prices off. */
  readonly pricingUrl: string
  /** The ACP adapter's model. The MCP server and the CLI leave the model out, so Capy's own default applies. */
  readonly defaultModel: string
  readonly defaultReasoning: string
  /**
   * `linked` edits the folder the client opened; `worktree` gives each session a fresh Capy worktree;
   * `cloud` runs each session's thread on a Capy cloud machine, with no device and no local folder.
   */
  readonly workspaceMode: "linked" | "worktree" | "cloud"
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
 * Where the Capy desktop app keeps its files: Electron's per-user app data folder plus "Capy", which
 * is what the packaged app sets. Only the Linux location has been checked on a machine;
 * `CAPY_DESKTOP_CONFIG_DIR` overrides it (a nightly build uses "Capy Nightly").
 */
export const desktopConfigDir = (env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): string => {
  const { join } = platform === "win32" ? win32 : posix
  if (platform === "darwin") return join(home, "Library", "Application Support", "Capy")
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Capy")
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "Capy")
}

export const readConfig = (env: NodeJS.ProcessEnv, product: Product): AdapterConfig => {
  const home = homedir()
  const waiting = Number(env.CAPY_ACP_WAITING_LIMIT_MS ?? 10 * 60_000)
  return {
    product,
    apiUrl: (env.CAPY_API_URL ?? "https://api.capy.ai/api/v1").replace(/\/+$/, ""),
    apiKeyFile: env.CAPY_API_KEY_FILE ?? join(home, ".config", "capy-acp", "api-key"),
    pricingUrl: env.CAPY_ACP_PRICING_URL ?? "https://docs.capy.ai/models-and-pricing.md",
    defaultModel: env.CAPY_ACP_MODEL ?? "anthropic/claude-opus-5-5",
    defaultReasoning: env.CAPY_ACP_REASONING ?? "high",
    workspaceMode: env.CAPY_ACP_WORKSPACE === "worktree" || env.CAPY_ACP_WORKSPACE === "cloud" ? env.CAPY_ACP_WORKSPACE : "linked",
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
