/**
 * `capy-acp --doctor [folder]`: checks each part of the setup that a prompt needs, in the order a prompt
 * needs them, and prints the fix for each problem. Read only: it saves nothing and starts no thread.
 */
import { describeError, isCapyError } from "./capy/client.js"
import type { AdapterConfig } from "./config.js"
import { noApiKey, type Problem, problemOf, rejectedApiKey, toText, unreachable } from "./problems.js"
import { savedApiKey } from "./setup.js"
import { AGENT_VERSION } from "./version.js"
import { type ProjectSummary, readDeviceId, readGit, readLinkedFolders, resolveWorkspace, samePath } from "./workspace.js"

export interface DoctorIo {
  readonly write: (text: string) => void
  /** The projects that the API key can see. */
  readonly listProjects: () => Promise<ReadonlyArray<ProjectSummary>>
  readonly nodeVersion: string
}

const message = (error: unknown) =>
  isCapyError(error) ? describeError(error) : error instanceof Error ? error.message : String(error)

/** Returns the exit code: 0 when nothing needs a fix. */
export const runDoctor = async (config: AdapterConfig, folder: string, io: DoctorIo): Promise<number> => {
  let problems = 0
  const ok = (text: string) => io.write(`  ok    ${text}\n`)
  const note = (text: string) => io.write(`  note  ${text}\n`)
  const fail = (problem: Problem) => {
    problems++
    io.write(`  FAIL  ${toText(problem, "        ")}\n`)
  }
  io.write(`capy-acp ${AGENT_VERSION} doctor: ${folder}\n\n`)

  const major = Number(io.nodeVersion.replace(/^v/, "").split(".")[0])
  if (major >= 22) ok(`Node ${io.nodeVersion}`)
  else fail({ title: "Update Node", detail: `capy-acp needs Node 22 or later, and this is Node ${io.nodeVersion}.`, steps: ["Install Node 22 or later."] })

  let projects: ReadonlyArray<ProjectSummary> | undefined
  const key = await savedApiKey(config)
  const source = process.env.CAPY_API_KEY?.trim() ? "CAPY_API_KEY" : config.apiKeyFile
  if (key === undefined) {
    fail(noApiKey(config.apiKeyFile))
  } else {
    try {
      projects = await io.listProjects()
      ok(`API key from ${source}. Capy accepted it and shows ${projects.length} project${projects.length === 1 ? "" : "s"}.`)
    } catch (error) {
      const rejected = isCapyError(error) && error._tag === "CapyApiError" && (error.status === 401 || error.status === 403)
      fail(rejected ? rejectedApiKey(`${message(error)}, from ${source}`) : unreachable(config.apiUrl, message(error)))
    }
  }

  await readDeviceId(config).then(
    (deviceId) => ok(`Capy device ${deviceId}. Keep the Capy desktop app or \`capy dock\` running while you work.`),
    (error: unknown) => fail(problemOf(error) ?? { title: "Check the Capy device", detail: message(error), steps: [] })
  )

  const [git, linked] = await Promise.all([readGit(folder), readLinkedFolders(config)])
  if (projects === undefined) {
    note("The folder check needs an API key that Capy accepts.")
  } else {
    const resolution = resolveWorkspace({
      cwd: folder,
      ...git,
      linked,
      projects,
      mode: config.workspaceMode,
      allowWorktreeFallback: config.allowWorktreeFallback
    })
    if (resolution._tag === "Unresolved") {
      fail(resolution.problem)
    } else {
      const { repo, projectName, workspace, notLinked } = resolution.value
      ok(`${git.gitRoot}: ${repo}, in the Capy project "${projectName}".`)
      const gitRoot = git.gitRoot ?? folder
      const listed = linked.some((f) => samePath(f.realRoot ?? f.root, gitRoot) || samePath(f.root, gitRoot))
      if (workspace.kind === "worktree") ok(resolution.value.note ?? "Capy works in a new worktree for each session.")
      else if (listed) ok("The folder is linked to this device. Capy edits it in place.")
      else note(`The local list of linked folders does not show this folder. Capy checks it when the first thread starts. If Capy refuses it:\n${toText(notLinked, "        ")}`)
    }
  }

  io.write(
    problems === 0
      ? "\nReady. In your ACP client, add an agent with the command `npx` and the arguments `-y capy-acp`.\n" +
          "Steps for each client: https://github.com/yazcaleb/capy-acp#add-capy-to-your-editor\n"
      : `\n${problems === 1 ? "1 problem" : `${problems} problems`} to fix. Then run \`npx -y capy-acp --doctor\` again.\n`
  )
  return problems === 0 ? 0 : 1
}
