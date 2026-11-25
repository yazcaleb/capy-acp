/**
 * Setup problems that the user must fix, with the steps to fix them. The first reply of a session
 * shows them as Markdown; `--doctor` prints them as plain text. Each problem says what to do, not
 * only what went wrong.
 */
export interface Problem {
  /** What to do, as a short imperative: "Add your Capy API key". */
  readonly title: string
  /** Why, in one or two sentences. */
  readonly detail: string
  readonly steps: ReadonlyArray<string>
}

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

export const noApiKey = (keyFile: string): Problem => ({
  title: "Add your Capy API key",
  detail: "capy-acp needs a Capy API key to start Capy threads.",
  steps: [
    "Create a key in the Capy app under Settings, then API.",
    `Run \`npx -y capy-acp --setup\` in a terminal and paste the key (it goes to ${keyFile}). If your editor offers Sign in for this agent, that runs the same command. You can also set \`CAPY_API_KEY\` in the agent's environment.`,
    RETRY
  ]
})

export const rejectedApiKey = (detail: string): Problem => ({
  title: "Replace your Capy API key",
  detail: `Capy did not accept the API key (${detail}).`,
  steps: ["Create a new key in the Capy app under Settings, then API.", "Run `npx -y capy-acp --setup` and paste it.", RETRY]
})

export const unreachable = (apiUrl: string, detail: string): Problem => ({
  title: "Capy could not be reached",
  detail: `${detail}.`,
  steps: [`Check the network connection to ${apiUrl}.`, RETRY]
})

export const noDevice = (files: ReadonlyArray<string>): Problem => ({
  title: "Start Capy on this computer",
  detail: "Capy threads run on this computer, and it is not paired with Capy.",
  steps: [
    "Open the Capy desktop app and sign in, or run `capy dock` on a computer without a screen.",
    RETRY,
    `capy-acp looks for the device in ${files.join(" and ")}. If Capy keeps its files elsewhere, set \`CAPY_DEVICE_ID\`.`
  ]
})

export const unreadableDeviceFile = (file: string, detail: string): Problem => ({
  title: "Check the Capy desktop app",
  detail: `capy-acp could not read the device file ${file} (${detail}).`,
  steps: ["Restart the Capy desktop app, or set `CAPY_DEVICE_ID` to the id of this computer's Capy device.", RETRY]
})

export const manyOrganizations = (count: number): Problem => ({
  title: "Choose a Capy organization",
  detail: `This computer is paired with ${count} Capy organizations, so capy-acp cannot tell which device to use.`,
  steps: ["Set `CAPY_DEVICE_ID` in the agent's environment to the device id of the organization that you want.", RETRY]
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
  detail: `${gitRoot} has no git remote that names a GitHub repository, so capy-acp cannot find its Capy project.`,
  steps: ["Add the remote, for example `git remote add origin git@github.com:owner/repo.git`.", RETRY]
})

export const notInProject = (repos: ReadonlyArray<string>): Problem => ({
  title: `Add ${repos[0]} to a Capy project`,
  detail: `No Capy project includes ${repos.join(" or ")}.`,
  steps: ["Open https://capy.ai/settings/projects and add the repository to a project.", RETRY]
})

export const notLinked = (input: {
  readonly root: string
  readonly projectName: string
  /** Another linked clone of the repository, for the worktree option. */
  readonly sameRepoRoot?: string | undefined
}): Problem => ({
  title: "Link this folder to Capy",
  detail: `Capy runs threads only in folders that are linked to this computer, and ${input.root} is not linked.`,
  steps: [
    `Open https://capy.ai/settings/projects, choose "${input.projectName}", and add the folder under Project folders. In the Capy desktop app you can also use Scan a folder. With \`capy dock\`, stop it and run \`capy dock dirs add ${input.root}\`.`,
    RETRY,
    ...(input.sameRepoRoot === undefined
      ? []
      : [`Or set \`CAPY_ACP_ALLOW_WORKTREE_FALLBACK=1\` to work in a new worktree of ${input.sameRepoRoot} instead.`])
  ]
})

