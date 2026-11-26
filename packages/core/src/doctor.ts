/**
 * The setup checks that `capy-acp --doctor` and `capy-cli doctor` share: the API key, this computer's
 * Capy device, and the folder's project and link. Read only: they save nothing and start no thread.
 */
import { describeError, isCapyError } from "./capy/client.js"
import type { AdapterConfig, Product } from "./config.js"
import { noApiKey, outsideChat, type Problem, problemOf, rejectedApiKey, toText, unreachable } from "./problems.js"
import { savedApiKey } from "./setup.js"
import { type Device, type ProjectSummary, readDevice, readGit, readLinkedFolders, resolveWorkspace, samePath } from "./workspace.js"

/** Where a check writes its lines. `fail` counts a problem. */
export interface CheckOutput {
  readonly ok: (text: string) => void
  readonly note: (text: string) => void
  readonly fail: (problem: Problem) => void
}

/** The problem as `product` shows it: only capy-acp, whose problems also reach an editor chat, keeps the chat steps. */
const shownBy = (product: Product, problem: Problem) => (product.kind === "acp" ? problem : outsideChat(problem))

/** Lines in the doctor's format: `ok`, `note` and `FAIL` with the fix steps. Counts the problems. */
export const checkOutput = (write: (text: string) => void, product: Product) => {
  let problems = 0
  const out: CheckOutput = {
    ok: (text) => write(`  ok    ${text}\n`),
    note: (text) => write(`  note  ${text}\n`),
    fail: (problem) => {
      problems++
      write(`  FAIL  ${toText(shownBy(product, problem), "        ")}\n`)
    }
  }
  return { ...out, problems: () => problems }
}

export const errorMessage = (error: unknown) =>
  isCapyError(error) ? describeError(error) : error instanceof Error ? error.message : String(error)

/** Checks the API key against Capy. Returns the projects that it can see, or undefined when it failed. */
export const checkKey = async (
  config: AdapterConfig,
  listProjects: () => Promise<ReadonlyArray<ProjectSummary>>,
  out: CheckOutput
): Promise<ReadonlyArray<ProjectSummary> | undefined> => {
  const key = await savedApiKey(config)
  const source = process.env.CAPY_API_KEY?.trim() ? "CAPY_API_KEY" : config.apiKeyFile
  if (key === undefined) {
    out.fail(noApiKey(config.apiKeyFile, config.product))
    return undefined
  }
  try {
    const projects = await listProjects()
    out.ok(`API key from ${source}. Capy accepted it and shows ${projects.length} project${projects.length === 1 ? "" : "s"}.`)
    return projects
  } catch (error) {
    const rejected = isCapyError(error) && error._tag === "CapyApiError" && (error.status === 401 || error.status === 403)
    out.fail(rejected ? rejectedApiKey(`${errorMessage(error)}, from ${source}`, config.product) : unreachable(config.apiUrl, errorMessage(error)))
    return undefined
  }
}

/**
 * Checks this computer's Capy device, then the folder: its repository, Capy project and link to the
 * device. `linked` is the line for a folder that the device links.
 */
export const checkDeviceAndFolder = async (
  config: AdapterConfig,
  folder: string,
  projects: ReadonlyArray<ProjectSummary> | undefined,
  out: CheckOutput,
  options: { readonly mode: "linked" | "worktree"; readonly linked: string }
): Promise<void> => {
  const device: Device | undefined = await readDevice(config).then(
    (found) => {
      const runner = found.kind === "dock" ? "`capy dock`" : found.kind === "desktop" ? "the Capy desktop app" : "the Capy desktop app or `capy dock`"
      out.ok(`Capy device ${found.id}. Keep ${runner} running while you work.`)
      return found
    },
    (error: unknown) => {
      out.fail(problemOf(error) ?? { title: "Check the Capy device", detail: errorMessage(error), steps: [] })
      return undefined
    }
  )

  const [git, linked] = await Promise.all([readGit(folder), readLinkedFolders(config)])
  if (projects === undefined) {
    out.note("The folder check needs an API key that Capy accepts.")
    return
  }
  const resolution = resolveWorkspace({
    cwd: folder,
    ...git,
    linked,
    projects,
    mode: options.mode,
    allowWorktreeFallback: config.allowWorktreeFallback,
    device: device?.kind
  })
  if (resolution._tag === "Unresolved") {
    out.fail(resolution.problem)
    return
  }
  const { repo, projectName, workspace, notLinked } = resolution.value
  out.ok(`${git.gitRoot}: ${repo}, in the Capy project "${projectName}".`)
  const gitRoot = git.gitRoot ?? folder
  const listed = linked.some((f) => samePath(f.realRoot ?? f.root, gitRoot) || samePath(f.root, gitRoot))
  if (workspace.kind === "worktree") out.ok(resolution.value.note ?? "Capy works in a new worktree for each session.")
  else if (listed) out.ok(options.linked)
  else out.note(`The local list of linked folders does not show this folder. Capy checks it when the first thread starts. If Capy refuses it:\n        ${toText(shownBy(config.product, notLinked), "        ")}`)
}
