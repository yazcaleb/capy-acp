/**
 * `capy-acp --doctor [folder]`: checks each part of the setup that a prompt needs, in the order a prompt
 * needs them, and prints the fix for each problem. Read only: it saves nothing and starts no thread.
 */
import type { AdapterConfig } from "@capy-acp/core/config.js"
import { checkDeviceAndFolder, checkKey, checkOutput } from "@capy-acp/core/doctor.js"
import { type ProjectSummary, readGit, resolveCloud } from "@capy-acp/core/workspace.js"
import { AGENT_VERSION } from "./version.js"

export interface DoctorIo {
  readonly write: (text: string) => void
  /** The projects that the API key can see. */
  readonly listProjects: () => Promise<ReadonlyArray<ProjectSummary>>
  readonly nodeVersion: string
  /** The newest capy-acp on npm, or undefined when npm cannot be reached. */
  readonly latestVersion: () => Promise<string | undefined>
  /** How this process was started, for the agent command to give the client. */
  readonly launch: { readonly platform: NodeJS.Platform; readonly node: string; readonly bin: string }
}

/** The agent command for an ACP client. T3 Code on Windows starts commands without a shell and refuses `npx.cmd`. */
const agentCommand = (launch: DoctorIo["launch"]) => {
  if (launch.platform !== "win32") return "add an agent with the command `npx` and the arguments `-y capy-acp`."
  // A copy that npx runs lives in its cache, which npm can clear at any time.
  const bin = /[\\/]_npx[\\/]/.test(launch.bin)
    ? "the full path of `dist\\bin.js` in a pinned install (https://github.com/yazcaleb/capy-acp/tree/main/packages/acp#install-without-npx)"
    : `\`${launch.bin}\``
  return `add an agent with the command \`${launch.node}\` and the argument ${bin}. On Windows, T3 Code does not run \`npx\`.`
}

/** True when version `a` is older than `b`. Both are plain `major.minor.patch`. */
const older = (a: string, b: string) => {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

/** Returns the exit code: 0 when nothing needs a fix. */
export const runDoctor = async (config: AdapterConfig, folder: string, io: DoctorIo): Promise<number> => {
  const out = checkOutput(io.write, config.product)
  const { ok, note, fail } = out
  io.write(`capy-acp ${AGENT_VERSION} doctor: ${folder}\n\n`)

  const latest = await io.latestVersion().catch(() => undefined)
  if (latest === undefined) note(`capy-acp ${AGENT_VERSION}. npm could not be reached to check for a newer version.`)
  else if (older(AGENT_VERSION, latest)) note(`capy-acp ${AGENT_VERSION}, and npm has ${latest}. \`npx -y capy-acp@latest\` runs the newest version.`)
  else ok(latest === AGENT_VERSION ? `capy-acp ${AGENT_VERSION}, the newest version on npm.` : `capy-acp ${AGENT_VERSION} (npm has ${latest}).`)

  const major = Number(io.nodeVersion.replace(/^v/, "").split(".")[0])
  if (major >= 22) ok(`Node ${io.nodeVersion}`)
  else fail({ title: "Update Node", detail: `capy-acp needs Node 22 or later, and this is Node ${io.nodeVersion}.`, steps: ["Install Node 22 or later."] })

  const projects = await checkKey(config, io.listProjects, out)

  const mode = config.workspaceMode
  if (mode === "cloud") {
    note(
      "CAPY_ACP_WORKSPACE=cloud: threads run on Capy cloud machines, so this skips the device and linked folder checks. " +
        "Machine time costs Capy credits."
    )
    const git = await readGit(folder)
    if (projects === undefined) {
      note("The folder check needs an API key that Capy accepts.")
    } else {
      const resolution = resolveCloud({ cwd: folder, ...git, projects })
      if (resolution._tag === "Unresolved") fail(resolution.problem)
      else ok(`${git.gitRoot}: ${resolution.value.repo}, in the Capy project "${resolution.value.projectName}". A cloud machine clones it from GitHub.`)
    }
  } else {
    await checkDeviceAndFolder(config, folder, projects, out, { mode, linked: "The folder is linked to this device. Capy edits it in place." })
  }

  const problems = out.problems()
  io.write(
    problems === 0
      ? `\nReady. In your ACP client, ${agentCommand(io.launch)}\n` +
          "Steps for each client: https://github.com/yazcaleb/capy-acp/tree/main/packages/acp#setup\n"
      : `\n${problems === 1 ? "1 problem" : `${problems} problems`} to fix. Then run \`npx -y capy-acp --doctor\` again.\n`
  )
  return problems === 0 ? 0 : 1
}
