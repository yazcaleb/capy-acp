/**
 * Setup problems that the user must fix, with the steps to fix them. The first reply of a session
 * shows them as Markdown; `--doctor` prints them as plain text. Each problem says what to do, not
 * only what went wrong. Texts that name the tool or its setup command take them from the Product.
 */
import type { Product } from "./config.js"

export interface Problem {
  /** What to do, as a short imperative: "Add your Capy API key". */
  readonly title: string
  /** Why, in one or two sentences. */
  readonly detail: string
  readonly steps: ReadonlyArray<string>
  /** The one next step for a calling agent, which reads it literally and cannot ask the person mid-call. */
  readonly nextAction?: NextAction
}

/**
 * What a calling agent does next: run an exact command, ask the person exactly this, try again after
 * a delay, or call again with another value for one option.
 */
export type NextAction =
  | { readonly kind: "run_command"; readonly command: string }
  | { readonly kind: "ask_human"; readonly say: string }
  | { readonly kind: "retry"; readonly afterMs: number }
  | { readonly kind: "use_option"; readonly option: string; readonly why: string }

/** An Error that carries a Problem, for code paths that throw. */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(`${problem.title}. ${problem.detail}`)
  }
}

export const problemOf = (error: unknown): Problem | undefined => (error instanceof ProblemError ? error.problem : undefined)

export const toMarkdown = (problem: Problem): string =>
  [`**${problem.title}**`, problem.detail, problem.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")]
    .filter((part) => part !== "")
    .join("\n\n")

export const toText = (problem: Problem, indent = ""): string =>
  [`${problem.title}. ${problem.detail}`, ...problem.steps.map((step, i) => `${indent}${i + 1}. ${step}`)].join("\n")

const RETRY = "Send your message again."
const NEW_SESSION = "Start a new chat in that folder. A session keeps the folder that it opened with."

// Steps written for an editor chat, which make no sense in a terminal or to a calling agent.
const CHAT_ONLY = new Set([RETRY, NEW_SESSION])

/** The problem without its editor-chat steps, for capy-mcp-server and capy-cli. */
export const outsideChat = (problem: Problem): Problem => ({
  ...problem,
  steps: problem.steps.filter((s) => !CHAT_ONLY.has(s)).map((s) => s.replace(/ Then send your message again\.$/, ""))
})

export const noApiKey = (keyFile: string, product: Product): Problem => ({
  title: "Add your Capy API key",
  detail: `${product.name} needs a Capy API key to start Capy threads.`,
  steps: [
    "Create a key in the Capy app under Settings, then API.",
    `Run \`${product.setup}\` in a terminal and paste the key (it goes to ${keyFile}).${product.kind === "acp" ? " If your editor offers Sign in for this agent, that runs the same command." : ""} You can also set \`CAPY_API_KEY\` in ${product.env}.`,
    RETRY
  ]
})

export const rejectedApiKey = (detail: string, product: Product): Problem => ({
  title: "Replace your Capy API key",
  detail: `Capy did not accept the API key (${detail}).`,
  steps: ["Create a new key in the Capy app under Settings, then API.", `Run \`${product.setup}\` and paste it.`, RETRY]
})

export const unreachable = (apiUrl: string, detail: string): Problem => ({
  title: "Capy could not be reached",
  detail: `${detail}.`,
  steps: [`Check the network connection to ${apiUrl}.`, RETRY]
})

/** A file that can name this computer's Capy device, and what was found in it. */
export interface DeviceFile {
  readonly path: string
  readonly found: "missing" | "no device"
}

export const NO_DEVICE_TITLE = "Start Capy on this computer"

export const noDevice = (files: ReadonlyArray<DeviceFile>, product: Product): Problem => ({
  title: NO_DEVICE_TITLE,
  detail: `Capy threads run on this computer, and ${product.name} found no Capy device here.`,
  steps: [
    `Run \`${product.setup}\` in a terminal in this folder: it sets this computer up as a Capy device with \`capy dock\` and links the folder. Or open the Capy desktop app and sign in.`,
    RETRY,
    `${product.name} looked in ${files.map((file) => `${file.path} (${file.found === "missing" ? "missing" : "no device in it"})`).join(" and ")}. Capy desktop 0.10.0 writes device-ids.json when it starts, and older versions may not, so update the desktop app if you use it. Or set \`CAPY_DEVICE_ID\` to this computer's device id.`
  ]
})

export const unreadableDeviceFile = (file: string, detail: string, product: Product): Problem => ({
  title: "Check the Capy desktop app",
  detail: `${product.name} could not read the device file ${file} (${detail}).`,
  steps: ["Restart the Capy desktop app, or set `CAPY_DEVICE_ID` to the id of this computer's Capy device.", RETRY]
})

export const manyOrganizations = (count: number, product: Product): Problem => ({
  title: "Choose a Capy organization",
  detail: `This computer is paired with ${count} Capy organizations, so ${product.name} cannot tell which device to use.`,
  steps: [`Set \`CAPY_DEVICE_ID\` in ${product.env} to the device id of the organization that you want.`, RETRY]
})

const isT3Scratch = (folder: string) => {
  const parts = folder.split(/[\\/]+/)
  return parts.some((part, i) => part === ".t3" && parts[i + 1] === "scratch")
}

export const notGit = (folder: string): Problem =>
  isT3Scratch(folder)
    ? {
        title: "Open a project to use Capy",
        detail: "T3 Code started this chat without a project. Capy threads run on a GitHub repository from one of your Capy projects.",
        steps: ["In T3 Code, add a project for a clone of that repository.", "Start a new chat in that project."]
      }
    : {
        title: "Open a repository to use Capy",
        detail: `${folder} is not in a git repository. Capy threads run on a GitHub repository from one of your Capy projects.`,
        steps: ["Open a clone of that repository in your editor.", NEW_SESSION]
      }

export const noGitHubRemote = (gitRoot: string): Problem => ({
  title: "Add the GitHub remote",
  detail: `${gitRoot} has no git remote that names a GitHub repository, so its Capy project cannot be found.`,
  steps: ["Add the remote, for example `git remote add origin git@github.com:owner/repo.git`.", RETRY]
})

export const notInProject = (repos: ReadonlyArray<string>): Problem => ({
  title: `Add ${repos[0]} to a Capy project`,
  detail: `No Capy project includes ${repos.join(" or ")}.`,
  steps: ["Open https://capy.ai/settings/projects and add the repository to a project.", RETRY]
})

/** How this computer is paired with Capy, which decides how a folder gets linked. */
export type DeviceKind = "desktop" | "dock"

const linkSteps = (input: { readonly root: string; readonly projectId: string; readonly projectName: string; readonly device: DeviceKind | undefined }) => {
  // Only the device itself can link a local folder: the desktop app, or `capy dock dirs add`. The
  // web app cannot. `capy://app/<path>` opens that page of the desktop app (checked in 0.10.0).
  const desktop = `Open \`capy://app/settings/projects/${input.projectId}\` to show "${input.projectName}" in the Capy desktop app. Set it up on this computer and choose ${input.root}.`
  const dock = [
    "Stop `capy dock`. Caution: this also stops the Capy threads that run on this computer.",
    `Run \`capy dock dirs add ${input.root}\`, then start \`capy dock\` again.`
  ]
  if (input.device === "desktop") return [desktop]
  if (input.device === "dock") return dock
  return [`With the desktop app: ${desktop}`, `With \`capy dock\`: ${dock.join(" ")}`]
}

/** `notLinked` for a calling agent or a terminal: options of the tool or command instead of an editor chat. */
const sameRepoForTools = (product: Product, root: string, repo: string, sameRepoRoot: string, link: ReadonlyArray<string>): Problem => {
  const mcp = product.kind === "mcp"
  return {
    title: `Use the folder that Capy links for ${repo}`,
    detail: `On this computer, Capy links ${repo} at ${sameRepoRoot}, not at ${root}.`,
    steps: [
      mcp ? `Call again with folder "${sameRepoRoot}".` : `Run the command again with \`--folder ${sameRepoRoot}\`.`,
      `Or link ${root} instead. ${link.join(" ")}`,
      `Or use ${mcp ? 'where "worktree"' : "`--where worktree`"}. Capy then works in a new worktree of ${sameRepoRoot}, and ${root} does not change.`
    ]
  }
}

export const notLinked = (input: {
  readonly root: string
  readonly repo: string
  readonly projectId: string
  readonly projectName: string
  readonly device: DeviceKind | undefined
  /** Another folder on this computer that Capy links for the same repository. */
  readonly sameRepoRoot?: string | undefined
  /** The package that shows the problem; capy-mcp-server and capy-cli name their own options. Default: capy-acp. */
  readonly product?: Product | undefined
}): Problem =>
  input.sameRepoRoot !== undefined && input.product !== undefined && input.product.kind !== "acp"
    ? sameRepoForTools(input.product, input.root, input.repo, input.sameRepoRoot, linkSteps(input))
    : input.sameRepoRoot === undefined
    ? {
        title: "Link this folder to Capy",
        detail: `Capy runs threads only in folders that are linked to this computer, and ${input.root} is not linked.`,
        steps: [...linkSteps(input), RETRY]
      }
    : {
        title: `Use the folder that Capy links for ${input.repo}`,
        detail: `On this computer, Capy links ${input.repo} at ${input.sameRepoRoot}, not at ${input.root}.`,
        steps: [
          `Open ${input.sameRepoRoot} in your editor, and start a new chat there.`,
          `Or link ${input.root} instead. ${linkSteps(input).join(" ")} Then send your message again.`,
          `Or set \`CAPY_ACP_ALLOW_WORKTREE_FALLBACK=1\` in the agent's environment. Capy then works in a new worktree of ${input.sameRepoRoot}, and its edits do not appear in ${input.root}.`
        ]
      }
