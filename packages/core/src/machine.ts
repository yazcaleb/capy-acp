/**
 * The device step of setup (`capy-acp --setup`, `capy-mcp --setup` and `capy-cli setup`): a computer
 * without a Capy device gets one with Capy's own Dock CLI (https://docs.capy.ai/dock), and a user
 * service keeps it running.
 *
 * Pairing stays Capy's: `capy dock` shows its link, QR code and code in the person's terminal, and the
 * person approves it on capy.ai. The setup never sees the code, never calls a private endpoint and
 * never reads the device's credentials. It only watches `dock/status.json` for the device id, which
 * `readDevice` reads too. Everything that runs a program or writes a file goes through `MachineIo`.
 */
import { spawn } from "node:child_process"
import { access, mkdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, posix, win32 } from "node:path"
import { createInterface } from "node:readline/promises"
import type { AdapterConfig } from "./config.js"
import { NO_DEVICE_TITLE, problemOf, toText } from "./problems.js"
import { readDevice, readGit, readLinkedFolders, samePath } from "./workspace.js"

export type DockOs = "linux" | "darwin" | "win32"

export const dockOs = (platform: NodeJS.Platform): DockOs | undefined =>
  platform === "linux" || platform === "darwin" || platform === "win32" ? platform : undefined

const pathFor = (os: DockOs) => (os === "win32" ? win32 : posix)

/** Where Capy's installer puts the `capy` command. `capy` on PATH can be the desktop app instead. */
export const dockBinary = (os: DockOs, capyHome: string): string =>
  os === "win32"
    ? win32.join(capyHome, "dock-install", "current", "bin", "capy.exe")
    : posix.join(capyHome, "bin", "capy")

export interface Command {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** The command as a person would type it. */
  readonly display: string
  /** A failure is expected and harmless, such as removing a service that is not loaded. */
  readonly mayFail?: boolean
}

const INSTALL_SH = "curl -fsSL https://downloads.capy.ai/stable/dock/install.sh | sh"
const INSTALL_PS1 = "irm https://downloads.capy.ai/stable/dock/install.ps1 | iex"

/** Capy's official installer, exactly as docs.capy.ai/dock gives it. */
export const installCommand = (os: DockOs): Command =>
  os === "win32"
    ? { command: "powershell.exe", args: ["-NoProfile", "-Command", INSTALL_PS1], display: INSTALL_PS1 }
    : { command: "sh", args: ["-c", INSTALL_SH], display: INSTALL_SH }

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`

// Windows commands are shown for PowerShell, where Capy's installer runs: single quotes, and `&` to
// run a program whose path is quoted.
const quoteArg = (os: DockOs, arg: string) =>
  os === "win32"
    ? (/^[\w:./\\-]+$/.test(arg) ? arg : psQuote(arg))
    : (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`)

const command = (os: DockOs, program: string, args: ReadonlyArray<string>, mayFail = false): Command => {
  const shown = quoteArg(os, program)
  return {
    command: program,
    args,
    display: [os === "win32" && shown !== program ? `& ${shown}` : shown, ...args.map((arg) => quoteArg(os, arg))].join(" "),
    ...(mayFail ? { mayFail } : {})
  }
}

export const dockCommand = (os: DockOs, binary: string, args: ReadonlyArray<string>): Command =>
  command(os, binary, ["dock", ...args])

// systemd expands `%` specifiers everywhere and `$` variables in ExecStart; both are doubled to stay literal.
const systemdEscape = (value: string) => value.replace(/%/g, "%%")
const systemdQuote = (value: string) => `"${systemdEscape(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** A systemd user unit that runs `capy dock` and starts it again when it fails. */
export const systemdUnit = (input: { readonly binary: string; readonly path: string | undefined }): string =>
  [
    "[Unit]",
    "Description=Capy dock: runs Capy threads on this computer",
    "Documentation=https://docs.capy.ai/dock",
    "",
    "[Service]",
    `ExecStart=${systemdQuote(input.binary).replace(/\$/g, "$$$$")} dock`,
    "WorkingDirectory=%h",
    // A user service starts with a short PATH; threads need the git, gh and tools that the person uses.
    ...(input.path ? [`Environment=${systemdQuote(`PATH=${input.path}`)}`] : []),
    "Restart=on-failure",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n")

const xml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")

export const LAUNCHD_LABEL = "capy-acp.dock"

/** A launchd LaunchAgent that runs `capy dock` at login and starts it again when it fails. */
export const launchAgent = (input: { readonly binary: string; readonly path: string | undefined; readonly logFile: string }): string =>
  [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${xml(input.binary)}</string>`,
    `    <string>dock</string>`,
    `  </array>`,
    // launchd starts agents with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which misses Homebrew's git and gh.
    ...(input.path
      ? [`  <key>EnvironmentVariables</key>`, `  <dict>`, `    <key>PATH</key>`, `    <string>${xml(input.path)}</string>`, `  </dict>`]
      : []),
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <dict>`,
    `    <key>SuccessfulExit</key>`,
    `    <false/>`,
    `  </dict>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>10</integer>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(input.logFile)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(input.logFile)}</string>`,
    `</dict>`,
    `</plist>`,
    ``
  ].join("\n")

export const TASK_NAME = "capy-acp dock"

/**
 * A Scheduled Task that runs `capy dock` when the person logs on, as that person and without admin
 * rights, and starts it again when it fails.
 */
export const scheduledTask = (input: { readonly binary: string; readonly userId: string; readonly workingDirectory: string }): string =>
  [
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>Runs capy dock, which runs Capy threads on this computer. https://docs.capy.ai/dock</Description>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger>`,
    `      <Enabled>true</Enabled>`,
    `      <UserId>${xml(input.userId)}</UserId>`,
    `    </LogonTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${xml(input.userId)}</UserId>`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <RestartOnFailure>`,
    `      <Interval>PT1M</Interval>`,
    `      <Count>999</Count>`,
    `    </RestartOnFailure>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>${xml(input.binary)}</Command>`,
    `      <Arguments>dock</Arguments>`,
    `      <WorkingDirectory>${xml(input.workingDirectory)}</WorkingDirectory>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``
  ].join("\n")

export interface ServicePlan {
  /** What keeps the dock running, for messages: "a systemd user service". */
  readonly name: string
  readonly file: string
  readonly content: string
  /** Run in order after the file is written; they register the service and start it. */
  readonly commands: ReadonlyArray<Command>
  readonly notes: ReadonlyArray<string>
}

/** The user service for this computer: its file, its content and the commands that start it. */
export const servicePlan = (input: {
  readonly os: DockOs
  readonly home: string
  readonly binary: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly uid: number | undefined
  /** capy-acp's own folder, for the Scheduled Task definition. */
  readonly configDir: string
}): ServicePlan => {
  const { join } = pathFor(input.os)
  const path = input.env.PATH
  if (input.os === "linux") {
    const file = join(input.env.XDG_CONFIG_HOME ?? join(input.home, ".config"), "systemd", "user", "capy-dock.service")
    return {
      name: "a systemd user service",
      file,
      content: systemdUnit({ binary: input.binary, path }),
      commands: [
        command("linux", "systemctl", ["--user", "daemon-reload"]),
        command("linux", "systemctl", ["--user", "enable", "--now", "capy-dock.service"])
      ],
      notes: [
        "On a server, also run `loginctl enable-linger` (it may need sudo), so the dock keeps running after you log out.",
        "Logs: `journalctl --user -u capy-dock`."
      ]
    }
  }
  if (input.os === "darwin") {
    const file = join(input.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`)
    const logFile = join(input.home, "Library", "Logs", "capy-dock.log")
    const domain = `gui/${input.uid ?? 501}`
    return {
      name: "a launchd LaunchAgent",
      file,
      content: launchAgent({ binary: input.binary, path, logFile }),
      commands: [
        command("darwin", "launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], true),
        command("darwin", "launchctl", ["bootstrap", domain, file])
      ],
      notes: [`Logs: ${logFile}.`]
    }
  }
  const file = win32.join(input.configDir, "capy-dock-task.xml")
  const user = input.env.USERNAME ?? "user"
  const userId = input.env.USERDOMAIN ? `${input.env.USERDOMAIN}\\${user}` : user
  const script =
    `Register-ScheduledTask -TaskName ${psQuote(TASK_NAME)} -Xml (Get-Content -Raw -Encoding UTF8 -LiteralPath ${psQuote(file)}) -Force | Out-Null; ` +
    `Start-ScheduledTask -TaskName ${psQuote(TASK_NAME)}`
  return {
    name: "a Scheduled Task that starts when you log on",
    file,
    content: scheduledTask({ binary: input.binary, userId, workingDirectory: input.home }),
    commands: [{ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script], display: script }],
    notes: ["The dock runs in a console window. Closing that window stops the dock until you log on again."]
  }
}

export interface RunResult {
  /** Undefined when the program could not start. */
  readonly code: number | undefined
  /** Captured output; empty for a program that used this terminal. */
  readonly output: string
}

export interface Running {
  readonly exited: Promise<number | undefined>
  /** Asks the program to stop; `force` kills it. */
  readonly stop: (force?: boolean) => void
}

export interface MachineIo {
  readonly platform: NodeJS.Platform
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly uid: number | undefined
  /** A person at a terminal can answer prompts and see a pairing code. */
  readonly interactive: boolean
  /** The folder to link: the one setup runs in. */
  readonly folder: string
  /** Root on macOS and Linux, an elevated (Run as administrator) shell on Windows. */
  readonly isElevated: () => Promise<boolean>
  readonly exists: (path: string) => Promise<boolean>
  readonly writeFile: (path: string, content: string) => Promise<void>
  readonly removeFile: (path: string) => Promise<void>
  /** Asks a yes/no question; anything but yes is no. */
  readonly confirm: (question: string) => Promise<boolean>
  /** Runs a program to the end. `terminal` gives it this terminal; otherwise its output is captured. */
  readonly run: (command: Command, options?: { readonly terminal?: boolean }) => Promise<RunResult>
  /** Starts a program in this terminal and returns at once. */
  readonly start: (command: Command) => Running
  readonly sleep: (ms: number) => Promise<void>
  /** The git root as the folder spells it, or undefined outside a repository. */
  readonly gitRoot: (folder: string) => Promise<string | undefined>
}

export interface MachineResult {
  readonly status: "ready" | "skipped" | "failed"
  readonly deviceId?: string
}

const DOCS = "https://docs.capy.ai/dock"
const DEVICES = "https://capy.ai/settings/devices"
export const PAIRING_LIMIT_MS = 15 * 60_000
const POLL_MS = 1_000

type Found =
  | { readonly kind: "device"; readonly id: string; readonly from: "desktop" | "dock" | "setting" }
  | { readonly kind: "desktop"; readonly text: string }
  | { readonly kind: "none" }

const findDevice = async (config: AdapterConfig): Promise<Found> => {
  try {
    const device = await readDevice(config)
    return { kind: "device", id: device.id, from: device.kind ?? "setting" }
  } catch (error) {
    const problem = problemOf(error)
    // Every other problem comes from the desktop app's file: several organizations, or a file it cannot read.
    if (problem !== undefined && problem.title !== NO_DEVICE_TITLE) return { kind: "desktop", text: toText(problem, "  ") }
    if (problem === undefined) throw error
    return { kind: "none" }
  }
}

const pairedDock = async (config: AdapterConfig): Promise<string | undefined> => {
  const found = await findDevice(config).catch(() => ({ kind: "none" }) as const)
  return found.kind === "device" ? found.id : undefined
}

const manualSteps = (os: DockOs, binary: string, root: string | undefined) =>
  [
    `To set it up yourself (${DOCS}):`,
    `  1. Install Capy's dock as the user that should run threads: ${installCommand(os).display}`,
    `  2. Run \`${dockCommand(os, binary, []).display}\` in a terminal, approve the pairing on capy.ai, then choose Yes when capy dock asks to pair.`,
    root === undefined
      ? `  3. Stop it, and link your clones with \`${dockCommand(os, binary, ["dirs", "add", "<folder>"]).display}\`.`
      : `  3. Stop it, run \`${dockCommand(os, binary, ["dirs", "add", root]).display}\`, then start \`capy dock\` again and keep it running.`
  ].join("\n") + "\n"

/** Stops the foreground dock: asks first, then kills it. True once it has exited. */
const stopDock = async (io: MachineIo, dock: Running): Promise<boolean> => {
  const exits = (ms: number) => Promise.race([dock.exited.then(() => true), io.sleep(ms).then(() => false)])
  dock.stop()
  if (await exits(10_000)) return true
  dock.stop(true)
  return exits(5_000)
}

/** Watches for the pairing to finish: the dock writes the device id when the person approves it. */
const waitForPairing = async (config: AdapterConfig, io: MachineIo, dock: Running) => {
  let exited = false
  void dock.exited.then(() => (exited = true))
  for (let waited = 0; waited < PAIRING_LIMIT_MS; waited += POLL_MS) {
    const id = await pairedDock(config)
    if (id !== undefined) return { kind: "paired", id } as const
    if (exited) return { kind: "exited" } as const
    await io.sleep(POLL_MS)
  }
  return { kind: "timeout" } as const
}

const runAll = async (io: MachineIo, commands: ReadonlyArray<Command>, write: (text: string) => void) => {
  for (const step of commands) {
    const result = await io.run(step)
    if (result.code === 0 || step.mayFail) continue
    write(`\`${step.display}\` failed${result.code === undefined ? "" : ` (exit code ${result.code})`}.\n${result.output.trim()}\n`)
    return false
  }
  return true
}

/** Shows the service file, asks, then writes it and starts the service. */
const offerService = async (
  config: AdapterConfig,
  io: MachineIo,
  write: (text: string) => void,
  os: DockOs,
  binary: string
): Promise<"installed" | "declined" | "failed"> => {
  const plan = servicePlan({ os, home: io.home, binary, env: io.env, uid: io.uid, configDir: dirname(config.apiKeyFile) })
  write(
    `\nThe dock must keep running for Capy threads to run here. ${config.product.name} can keep it running with ${plan.name}.\n` +
      `It writes ${plan.file}:\n\n${plan.content}\nThen it runs:\n${plan.commands.map((step) => `  ${step.display}`).join("\n")}\n`
  )
  if (!(await io.confirm(`Install and start ${plan.name}?`))) {
    write(
      `No service was installed. The dock is offline until you start it: run \`${dockCommand(os, binary, []).display}\` ` +
        "and keep it running, for example in tmux or with a service manager.\n"
    )
    return "declined"
  }
  try {
    await io.writeFile(plan.file, plan.content)
  } catch (error) {
    write(`${config.product.name} could not write ${plan.file} (${error instanceof Error ? error.message : String(error)}).\n`)
    return "failed"
  }
  if (!(await runAll(io, plan.commands, write))) {
    // launchd loads every file in LaunchAgents at the next login, so a service that failed to start
    // would start the dock later without a word. The other systems run only what was registered.
    if (os === "darwin") {
      const removed = await io.removeFile(plan.file).then(() => true, () => false)
      write(
        removed
          ? `${config.product.name} removed ${plan.file} again, so the dock does not start at your next login. Fix the error above and run \`${config.product.setup}\` again, or run \`${dockCommand(os, binary, []).display}\` yourself.\n`
          : `${plan.file} stays, and launchd starts the dock from it at your next login. Delete it if you do not want that: \`rm ${quoteArg(os, plan.file)}\`.\n`
      )
      return "failed"
    }
    write(`The service file is at ${plan.file}. Fix the error above and run the commands again, or run \`${dockCommand(os, binary, []).display}\` yourself.\n`)
    return "failed"
  }
  write(`Started ${plan.name}.\n${plan.notes.join("\n")}\n`)
  return "installed"
}

/** Links the folder's git root while the dock is stopped, so no thread is interrupted. */
const linkFolder = async (name: string, io: MachineIo, write: (text: string) => void, os: DockOs, binary: string, root: string | undefined) => {
  if (root === undefined) {
    write(`${io.folder} is not in a git repository, so ${name} linked no folder. Later, stop the dock and run \`${dockCommand(os, binary, ["dirs", "add", "<folder>"]).display}\` for each clone.\n`)
    return false
  }
  const step = dockCommand(os, binary, ["dirs", "add", root])
  write(`Linking ${root}, so Capy threads can work on this repository: ${step.display}\n`)
  const result = await io.run(step)
  if (result.code === 0) return true
  write(`\`${step.display}\` failed${result.code === undefined ? "" : ` (exit code ${result.code})`}.\n${result.output.trim()}\nRun it again while the dock is stopped.\n`)
  return false
}

/**
 * Gives this computer a Capy device when it has none: detects the desktop app or the dock, installs the
 * dock with consent, lets the person pair it, links the folder and offers a service that keeps it running.
 */
export const setupMachine = async (config: AdapterConfig, io: MachineIo, write: (text: string) => void): Promise<MachineResult> => {
  const { name, setup } = config.product
  const found = await findDevice(config)
  if (found.kind === "device" && found.from !== "dock") {
    write(
      found.from === "desktop"
        ? `Capy device on this computer: ${found.id}, from the Capy desktop app. Keep the app running while Capy threads run here.\n`
        : `CAPY_DEVICE_ID names the Capy device ${found.id}, so ${name} sets up no device on this computer.\n`
    )
    return { status: "ready", deviceId: found.id }
  }
  if (found.kind === "desktop") {
    write(`The Capy desktop app pairs this computer, but ${name} cannot tell which device to use:\n${found.text}\n`)
    return { status: "skipped" }
  }
  const os = dockOs(io.platform)
  if (os === undefined) {
    write(`This computer has no Capy device, and Capy's dock does not run on ${io.platform}. See ${DOCS}.\n`)
    return { status: "skipped" }
  }
  const binary = dockBinary(os, config.capyHome)
  const root = await io.gitRoot(io.folder)

  if (found.kind === "device") {
    write(`Capy device on this computer: ${found.id}, from capy dock. Keep \`capy dock\` running while Capy threads run here.\n`)
    const linked = await readLinkedFolders(config)
    if (root !== undefined && !linked.some((folder) => samePath(folder.realRoot ?? folder.root, root) || samePath(folder.root, root))) {
      write(
        `${root} may not be linked to this device. To link it, stop \`capy dock\` (this also stops the Capy threads that run here), ` +
          `run \`${dockCommand(os, binary, ["dirs", "add", root]).display}\`, then start \`capy dock\` again.\n`
      )
    }
    return { status: "ready", deviceId: found.id }
  }

  // The app keeps its folder once it has run for this user, even before it pairs.
  if (await io.exists(config.capyDesktopConfigDir)) {
    write(
      `The Capy desktop app is set up for this user (${config.capyDesktopConfigDir}), but it has no device yet. ` +
        `Open the app and sign in. Capy runs one device per user, so ${name} does not install capy dock as well.\n`
    )
    return { status: "skipped" }
  }

  write("\nThis computer has no Capy device yet. Capy threads that run here need one: Capy's dock (`capy dock`) makes this computer one.\n")
  if (!io.interactive) {
    write(`Pairing needs a person at a terminal, so ${name} set up no device. ${manualSteps(os, binary, root)}`)
    return { status: "skipped" }
  }
  if (await io.isElevated()) {
    write(
      (os === "win32"
        ? "This PowerShell runs as administrator. Capy's installer refuses that, and threads would run with admin rights. "
        : "This runs as root. Capy's installer refuses that, and threads would run with root's permissions. ") +
        `Run \`${setup}\` again as the user that should run Capy threads.\n`
    )
    return { status: "skipped" }
  }

  if (!(await io.exists(binary))) {
    const install = installCommand(os)
    write(
      `${name} can run Capy's official installer${os === "win32" ? " in PowerShell" : ""}:\n  ${install.display}\n` +
        `It installs capy in ${pathFor(os).dirname(binary)} for this user only.` +
        (os === "win32" ? " Threads run commands in Git Bash, so install Git for Windows too." : "") +
        "\n"
    )
    if (!(await io.confirm("Run it now?"))) {
      write(`Nothing was installed. ${manualSteps(os, binary, root)}`)
      return { status: "skipped" }
    }
    const result = await io.run(install, { terminal: true })
    if (!(await io.exists(binary))) {
      write(`The installer did not install ${binary}${result.code ? ` (exit code ${result.code})` : ""}. Check its output above, and see ${DOCS}.\n`)
      return { status: "failed" }
    }
  } else {
    write(`Capy's dock is installed at ${binary}, but it is not paired yet.\n`)
  }

  write(
    "\nNext, pair this computer with your Capy organization. capy dock shows a link, a QR code and a pairing code here.\n" +
      "  1. Open the link or scan the code, and sign in to Capy.\n" +
      "  2. Check the hostname and system, pick the organization, name the device, and approve it.\n" +
      "  3. Back here, capy dock asks whether to pair with that organization. Choose Yes. It defaults to No.\n" +
      "Never approve a code that someone sent you. Press Ctrl+C to stop.\n\n"
  )
  const dock = io.start(dockCommand(os, binary, []))
  const pairing = await waitForPairing(config, io, dock)
  let stopped = true
  if (pairing.kind !== "exited") {
    // A moment for the dock to print the organization and device name, which the person checks.
    if (pairing.kind === "paired") await io.sleep(2_000)
    stopped = await stopDock(io, dock)
  }
  const stillRuns = `capy dock did not stop when ${name} asked it to, and still runs. Stop it yourself (Ctrl+C in its window, or end the process).`
  if (pairing.kind !== "paired") {
    write(
      (pairing.kind === "timeout"
        ? `The pairing did not finish within ${PAIRING_LIMIT_MS / 60_000} minutes, so ${name} stopped capy dock.`
        : "capy dock stopped before the pairing finished.") +
        (stopped ? "" : ` ${stillRuns}`) +
        ` Run \`${dockCommand(os, binary, []).display}\` to try again, then run \`${setup}\` again.\n`
    )
    return { status: "failed" }
  }
  if (!stopped) {
    // Linking a folder or starting a service now would run a second dock for the same device.
    write(
      `\nPaired. Capy device: ${pairing.id}. ${stillRuns} ${name} linked no folder and installed no service.\n` +
        `Check that the organization and device name that capy dock showed are yours. If not, revoke the device at ${DEVICES}.\n` +
        (root === undefined ? "" : `Once it has stopped, run \`${dockCommand(os, binary, ["dirs", "add", root]).display}\`. `) +
        `Then start \`${dockCommand(os, binary, []).display}\` again and keep it running.\n`
    )
    return { status: "failed", deviceId: pairing.id }
  }
  write(
    `\nPaired. Capy device: ${pairing.id}. ${name} stopped capy dock to link folders.\n` +
      `Check that the organization and device name that capy dock showed are yours. If not, revoke the device at ${DEVICES}.\n`
  )

  const linked = await linkFolder(name, io, write, os, binary, root)
  const service = await offerService(config, io, write, os, binary)
  write(
    `\nDone. Capy device ${pairing.id} runs on this computer with capy dock` +
      (linked ? `, linked to ${root}` : "") +
      (service === "installed" ? ", and a service keeps it running.\n" : ". It is offline until you start `capy dock`.\n")
  )
  return { status: service === "failed" ? "failed" : "ready", deviceId: pairing.id }
}

/** The real computer. */
export const nodeMachineIo = (folder: string = process.cwd()): MachineIo => {
  const platform = process.platform
  const spawnArgs = (step: Command) => [step.command, [...step.args]] as const
  const run: MachineIo["run"] = (step, options) =>
    new Promise((resolve) => {
      let output = ""
      const child = spawn(...spawnArgs(step), { stdio: options?.terminal ? "inherit" : ["ignore", "pipe", "pipe"] })
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()))
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()))
      child.on("error", (error) => resolve({ code: undefined, output: error.message }))
      child.on("close", (code) => resolve({ code: code ?? undefined, output }))
    })
  return {
    platform,
    home: homedir(),
    env: process.env,
    uid: process.getuid?.(),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    folder,
    isElevated: async () => {
      if (platform !== "win32") return process.getuid?.() === 0
      const check = await run({
        command: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
        ],
        display: ""
      })
      return check.output.trim() === "True"
    },
    exists: (path) => access(path).then(() => true, () => false),
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content)
    },
    removeFile: (path) => rm(path, { force: true }),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      // Without a listener, readline only pauses on Ctrl+C and the question never ends. Ctrl+C means no.
      const cancel = new AbortController()
      rl.on("SIGINT", () => (process.stdout.write("\n"), cancel.abort()))
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `, { signal: cancel.signal })).trim())
      } catch {
        return false
      } finally {
        rl.close()
      }
    },
    run,
    start: (step) => {
      const child = spawn(...spawnArgs(step), { stdio: "inherit" })
      const exited = new Promise<number | undefined>((resolve) => {
        child.on("error", () => resolve(undefined))
        child.on("exit", (code) => resolve(code ?? undefined))
      })
      return { exited, stop: (force) => void child.kill(force === true ? "SIGKILL" : "SIGTERM") }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    gitRoot: (dir) => readGit(dir).then((git) => git.openedRoot ?? git.gitRoot)
  }
}
