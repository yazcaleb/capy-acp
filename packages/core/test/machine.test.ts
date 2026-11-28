import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { readConfig } from "./config.js"
import {
  type Command,
  dockBinary,
  dockCommand,
  installCommand,
  launchAgent,
  type MachineIo,
  PAIRING_LIMIT_MS,
  scheduledTask,
  servicePlan,
  setupMachine,
  systemdUnit
} from "../src/machine.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("service definitions", () => {
  it("writes a systemd user unit with the person's PATH, and escapes what systemd would expand", () => {
    expect(systemdUnit({ binary: "/home/ada/.capy/bin/capy", path: "/home/ada/.local/bin:/usr/bin" })).toBe(
      [
        "[Unit]",
        "Description=Capy dock: runs Capy threads on this computer",
        "Documentation=https://docs.capy.ai/dock",
        "",
        "[Service]",
        'ExecStart="/home/ada/.capy/bin/capy" dock',
        "WorkingDirectory=%h",
        'Environment="PATH=/home/ada/.local/bin:/usr/bin"',
        "Restart=on-failure",
        "RestartSec=10",
        "",
        "[Install]",
        "WantedBy=default.target",
        ""
      ].join("\n")
    )
    const odd = systemdUnit({ binary: '/srv/my "dock" 100%/$HOME/capy', path: undefined })
    expect(odd).toContain('ExecStart="/srv/my \\"dock\\" 100%%/$$HOME/capy" dock')
    expect(odd).not.toContain("Environment=")
  })

  it("writes a launchd LaunchAgent with escaped paths and a log file", () => {
    const plist = launchAgent({ binary: "/Users/a&b/.capy/bin/capy", path: "/opt/homebrew/bin:/usr/bin", logFile: "/Users/a&b/Library/Logs/capy-dock.log" })
    expect(plist).toContain("<string>/Users/a&amp;b/.capy/bin/capy</string>\n    <string>dock</string>")
    expect(plist).toContain("<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin</string>")
    expect(plist).toContain("<key>Label</key>\n  <string>capy-acp.dock</string>")
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>")
    expect(plist).toContain("<key>StandardErrorPath</key>\n  <string>/Users/a&amp;b/Library/Logs/capy-dock.log</string>")
    expect(plist).not.toContain("a&b")
  })

  it("writes a Scheduled Task that runs at logon as the person, without admin rights", () => {
    const task = scheduledTask({ binary: "C:\\Users\\Ada\\.capy\\dock-install\\current\\bin\\capy.exe", userId: "PC\\Ada", workingDirectory: "C:\\Users\\Ada" })
    expect(task).toContain("<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>PC\\Ada</UserId>")
    expect(task).toContain("<LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>")
    expect(task).toContain("<Command>C:\\Users\\Ada\\.capy\\dock-install\\current\\bin\\capy.exe</Command>\n      <Arguments>dock</Arguments>")
    expect(task).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>")
  })

  it("plans the file and the start commands for each system", () => {
    const env = { PATH: "/usr/bin", USERNAME: "Ada", USERDOMAIN: "PC" }
    const linux = servicePlan({ os: "linux", home: "/home/ada", binary: "/home/ada/.capy/bin/capy", env, uid: 1000, configDir: "/home/ada/.config/capy-acp" })
    expect(linux.file).toBe("/home/ada/.config/systemd/user/capy-dock.service")
    expect(linux.commands.map((c) => c.display)).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now capy-dock.service"])
    expect(linux.notes.join(" ")).toContain("loginctl enable-linger")
    expect(servicePlan({ os: "linux", home: "/home/ada", binary: "/b", env: { XDG_CONFIG_HOME: "/cfg" }, uid: 1000, configDir: "/c" }).file).toBe(
      "/cfg/systemd/user/capy-dock.service"
    )

    const mac = servicePlan({ os: "darwin", home: "/Users/ada", binary: "/Users/ada/.capy/bin/capy", env, uid: 501, configDir: "/c" })
    expect(mac.file).toBe("/Users/ada/Library/LaunchAgents/capy-acp.dock.plist")
    expect(mac.commands.map((c) => [c.display, c.mayFail ?? false])).toEqual([
      ["launchctl bootout gui/501/capy-acp.dock", true],
      ["launchctl bootstrap gui/501 /Users/ada/Library/LaunchAgents/capy-acp.dock.plist", false]
    ])

    const windows = servicePlan({
      os: "win32",
      home: "C:\\Users\\Ada",
      binary: dockBinary("win32", "C:\\Users\\Ada\\.capy"),
      env,
      uid: undefined,
      configDir: "C:\\Users\\Ada\\.config\\capy-acp"
    })
    expect(windows.file).toBe("C:\\Users\\Ada\\.config\\capy-acp\\capy-dock-task.xml")
    expect(windows.content).toContain("<UserId>PC\\Ada</UserId>")
    expect(windows.commands).toHaveLength(1)
    expect(windows.commands[0]?.command).toBe("powershell.exe")
    expect(windows.commands[0]?.display).toBe(
      "Register-ScheduledTask -TaskName 'capy-acp dock' -Xml (Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\\Users\\Ada\\.config\\capy-acp\\capy-dock-task.xml') -Force | Out-Null; " +
        "Start-ScheduledTask -TaskName 'capy-acp dock'"
    )
  })

  it("uses Capy's official installers and install locations", () => {
    expect(installCommand("linux")).toEqual({ command: "sh", args: ["-c", "curl -fsSL https://downloads.capy.ai/stable/dock/install.sh | sh"], display: "curl -fsSL https://downloads.capy.ai/stable/dock/install.sh | sh" })
    expect(installCommand("darwin").display).toBe("curl -fsSL https://downloads.capy.ai/stable/dock/install.sh | sh")
    expect(installCommand("win32")).toEqual({
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", "irm https://downloads.capy.ai/stable/dock/install.ps1 | iex"],
      display: "irm https://downloads.capy.ai/stable/dock/install.ps1 | iex"
    })
    expect(dockBinary("linux", "/home/ada/.capy")).toBe("/home/ada/.capy/bin/capy")
    expect(dockBinary("win32", "C:\\Users\\Ada\\.capy")).toBe("C:\\Users\\Ada\\.capy\\dock-install\\current\\bin\\capy.exe")
  })
})

interface Options {
  readonly platform?: NodeJS.Platform
  readonly interactive?: boolean
  readonly elevated?: boolean
  readonly installed?: boolean
  readonly paired?: boolean
  readonly desktopDir?: boolean
  readonly desktopDevice?: boolean
  readonly answers?: ReadonlyArray<boolean>
  /** What the dock does once started: the person approves after a few seconds, or it exits, or nothing happens. */
  readonly dock?: "approve" | "exit" | "hang"
  readonly linked?: boolean
  readonly failing?: ReadonlyArray<string>
  /** How the dock takes a stop: it exits when asked (default), only when killed, or never. */
  readonly stops?: "asked" | "killed" | "never"
}

/** A computer in a temp folder: Capy's files are real files there; programs and writes are recorded. */
const fakeMachine = (options: Options = {}) => {
  const root = mkdtempSync(join(tmpdir(), "capy-acp-machine-"))
  dirs.push(root)
  const capyHome = join(root, "capy")
  const desktop = join(root, "desktop")
  mkdirSync(join(capyHome, "dock"), { recursive: true })
  mkdirSync(join(capyHome, "device"), { recursive: true })
  if (options.desktopDir || options.desktopDevice) mkdirSync(desktop)
  if (options.desktopDevice) writeFileSync(join(desktop, "device-ids.json"), JSON.stringify({ orgs: { org_1: "device_DESKTOP" } }))
  const pair = () => writeFileSync(join(capyHome, "dock", "status.json"), JSON.stringify({ deviceId: "device_NEW" }))
  if (options.paired) pair()
  writeFileSync(join(capyHome, "device", "workspaces.json"), JSON.stringify({ folders: options.linked ? [{ root: "/home/ada/src/app", repos: ["acme/app"] }] : [] }))
  const config = readConfig({
    CAPY_HOME: capyHome,
    CAPY_DESKTOP_CONFIG_DIR: desktop,
    CAPY_API_KEY_FILE: "/home/ada/.config/capy-acp/api-key"
  })
  const platform = options.platform ?? "linux"
  const binary = dockBinary(platform === "win32" ? "win32" : "linux", capyHome)
  const present = new Set<string>(options.installed ? [binary] : [])
  if (options.desktopDir || options.desktopDevice) present.add(desktop)
  const answers = [...(options.answers ?? [])]
  const output: Array<string> = []
  const log: Array<string> = []
  const files = new Map<string, string>()
  let started = false
  let resolveExit: (code: number | undefined) => void = () => {}
  let sleeps = 0
  const io: MachineIo = {
    platform,
    home: platform === "win32" ? "C:\\Users\\Ada" : "/home/ada",
    env: platform === "win32" ? { PATH: "C:\\Windows", USERNAME: "Ada", USERDOMAIN: "PC" } : { PATH: "/home/ada/.local/bin:/usr/bin" },
    uid: platform === "win32" ? undefined : 1000,
    interactive: options.interactive ?? true,
    folder: "/home/ada/src/app/web",
    isElevated: async () => options.elevated ?? false,
    exists: async (path) => present.has(path),
    writeFile: async (path, content) => {
      log.push(`write ${path}`)
      files.set(path, content)
    },
    removeFile: async (path) => {
      log.push(`remove ${path}`)
      files.delete(path)
    },
    confirm: async (question) => {
      const answer = answers.shift() ?? false
      output.push(`${question} [y/N] ${answer ? "y" : "n"}\n`)
      return answer
    },
    run: async (step: Command, opts) => {
      log.push(`run${opts?.terminal ? " (terminal)" : ""} ${step.display}`)
      if (/install\.(sh|ps1)/.test(step.display)) present.add(binary)
      const fails = (options.failing ?? []).some((part) => step.display.includes(part))
      return { code: fails ? 1 : 0, output: fails ? "Failed to connect to bus: No medium found" : "" }
    },
    start: (step) => {
      log.push(`start ${step.display}`)
      started = true
      const exited = new Promise<number | undefined>((resolve) => (resolveExit = resolve))
      if (options.dock === "exit") resolveExit(1)
      const stops = options.stops ?? "asked"
      return {
        exited,
        stop: (force) => {
          log.push(force === true ? "kill dock" : "stop dock")
          if (stops === "asked" || (stops === "killed" && force === true)) resolveExit(0)
        }
      }
    },
    sleep: async (ms) => {
      if (ms !== 1_000) return
      sleeps += 1
      if (started && (options.dock ?? "approve") === "approve" && sleeps === 3) pair()
    },
    gitRoot: async () => "/home/ada/src/app"
  }
  return { config, io, output, log, files, binary, write: (text: string) => void output.push(text), sleeps: () => sleeps }
}

describe("setupMachine", () => {
  it("installs the dock with consent, lets the person pair it, links the folder and installs a service", async () => {
    const m = fakeMachine({ answers: [true, true] })
    expect(await setupMachine(m.config, m.io, m.write)).toEqual({ status: "ready", deviceId: "device_NEW" })
    expect(m.log).toEqual([
      "run (terminal) curl -fsSL https://downloads.capy.ai/stable/dock/install.sh | sh",
      `start ${m.binary} dock`,
      "stop dock",
      `run ${m.binary} dock dirs add /home/ada/src/app`,
      "write /home/ada/.config/systemd/user/capy-dock.service",
      "run systemctl --user daemon-reload",
      "run systemctl --user enable --now capy-dock.service"
    ])
    expect(m.files.get("/home/ada/.config/systemd/user/capy-dock.service")).toBe(
      systemdUnit({ binary: m.binary, path: "/home/ada/.local/bin:/usr/bin" })
    )
    const text = m.output.join("")
    expect(text).toContain("curl -fsSL https://downloads.capy.ai/stable/dock/install.sh | sh\n")
    expect(text).toContain("Choose Yes. It defaults to No.")
    expect(text).toContain("Never approve a code that someone sent you.")
    expect(text).toContain("Paired. Capy device: device_NEW.")
    expect(text).toContain("revoke the device at https://capy.ai/settings/devices")
    expect(text).toContain("Done. Capy device device_NEW runs on this computer with capy dock, linked to /home/ada/src/app, and a service keeps it running.")
    // The transcript in the hand-off note.
    if (process.env.CAPY_ACP_PRINT_TRANSCRIPT) process.stderr.write(`\n----\n${text}----\n`)
  })

  it("recommends the desktop app and installs nothing when the app pairs this computer or is set up", async () => {
    const paired = fakeMachine({ desktopDevice: true, answers: [true, true] })
    expect(await setupMachine(paired.config, paired.io, paired.write)).toEqual({ status: "ready", deviceId: "device_DESKTOP" })
    expect(paired.output.join("")).toContain("device_DESKTOP, from the Capy desktop app")
    const signedOut = fakeMachine({ desktopDir: true, answers: [true, true] })
    expect(await setupMachine(signedOut.config, signedOut.io, signedOut.write)).toEqual({ status: "skipped" })
    expect(signedOut.output.join("")).toContain("Open the app and sign in. Capy runs one device per user, so capy-acp does not install capy dock as well.")
    expect([...paired.log, ...signedOut.log]).toEqual([])
  })

  it("installs nothing when the person declines, and prints the steps instead", async () => {
    const m = fakeMachine({ answers: [false] })
    expect(await setupMachine(m.config, m.io, m.write)).toEqual({ status: "skipped" })
    expect(m.log).toEqual([])
    const text = m.output.join("")
    expect(text).toContain("Run it now? [y/N] n")
    expect(text).toContain(`run \`${m.binary} dock dirs add /home/ada/src/app\``)
  })

  it("refuses to install as root or as an administrator", async () => {
    const root = fakeMachine({ elevated: true, answers: [true, true] })
    expect(await setupMachine(root.config, root.io, root.write)).toEqual({ status: "skipped" })
    expect(root.output.join("")).toContain("This runs as root.")
    const admin = fakeMachine({ platform: "win32", elevated: true, answers: [true, true] })
    expect(await setupMachine(admin.config, admin.io, admin.write)).toEqual({ status: "skipped" })
    expect(admin.output.join("")).toContain("This PowerShell runs as administrator.")
    expect([...root.log, ...admin.log]).toEqual([])
  })

  it("asks nothing and runs nothing without a terminal, because pairing needs a person", async () => {
    const m = fakeMachine({ interactive: false, answers: [true, true] })
    expect(await setupMachine(m.config, m.io, m.write)).toEqual({ status: "skipped" })
    expect(m.log).toEqual([])
    expect(m.output.join("")).not.toContain("[y/N]")
    expect(m.output.join("")).toContain("1. Install Capy's dock as the user that should run threads: curl -fsSL")
  })

  it("runs the Windows installer in PowerShell and registers a Scheduled Task", async () => {
    const m = fakeMachine({ platform: "win32", answers: [true, true] })
    expect(await setupMachine(m.config, m.io, m.write)).toEqual({ status: "ready", deviceId: "device_NEW" })
    expect(m.log[0]).toBe("run (terminal) irm https://downloads.capy.ai/stable/dock/install.ps1 | iex")
    expect(m.log.at(-1)).toContain("run Register-ScheduledTask -TaskName 'capy-acp dock'")
    expect(m.output.join("")).toContain("install Git for Windows too")
  })

  it("skips the installer when the dock is installed, and pairs it", async () => {
    const m = fakeMachine({ installed: true, answers: [false] })
    expect(await setupMachine(m.config, m.io, m.write)).toEqual({ status: "ready", deviceId: "device_NEW" })
    expect(m.log).toEqual([`start ${m.binary} dock`, "stop dock", `run ${m.binary} dock dirs add /home/ada/src/app`])
    const text = m.output.join("")
    expect(text).toContain("is installed at")
    expect(text).toContain("No service was installed. The dock is offline until you start it")
    expect(text).toContain("It is offline until you start `capy dock`.")
  })

  it("fails with the retry command when the dock stops before the pairing finishes, or the pairing takes too long", async () => {
    const exited = fakeMachine({ installed: true, dock: "exit" })
    expect(await setupMachine(exited.config, exited.io, exited.write)).toEqual({ status: "failed" })
    expect(exited.log).toEqual([`start ${exited.binary} dock`])
    expect(exited.output.join("")).toContain("capy dock stopped before the pairing finished.")
    const hung = fakeMachine({ installed: true, dock: "hang" })
    expect(await setupMachine(hung.config, hung.io, hung.write)).toEqual({ status: "failed" })
    expect(hung.log).toEqual([`start ${hung.binary} dock`, "stop dock"])
    expect(hung.sleeps()).toBe(PAIRING_LIMIT_MS / 1_000)
    expect(hung.output.join("")).toContain("did not finish within 15 minutes")
  })

  it("kills a dock that does not stop when asked, and links nothing while a dock still runs", async () => {
    const killed = fakeMachine({ installed: true, answers: [false], stops: "killed" })
    expect(await setupMachine(killed.config, killed.io, killed.write)).toEqual({ status: "ready", deviceId: "device_NEW" })
    expect(killed.log).toEqual([`start ${killed.binary} dock`, "stop dock", "kill dock", `run ${killed.binary} dock dirs add /home/ada/src/app`])

    const stuck = fakeMachine({ installed: true, answers: [true], stops: "never" })
    expect(await setupMachine(stuck.config, stuck.io, stuck.write)).toEqual({ status: "failed", deviceId: "device_NEW" })
    expect(stuck.log).toEqual([`start ${stuck.binary} dock`, "stop dock", "kill dock"])
    const text = stuck.output.join("")
    expect(text).toContain("capy dock did not stop when capy-acp asked it to, and still runs.")
    expect(text).toContain("capy-acp linked no folder and installed no service.")
    expect(text).not.toContain("capy-acp stopped capy dock to link folders")
  })

  it("removes a LaunchAgent that launchd did not load, so it does not start the dock at the next login", async () => {
    const m = fakeMachine({ platform: "darwin", installed: true, answers: [true], failing: ["bootstrap"] })
    expect(await setupMachine(m.config, m.io, m.write)).toEqual({ status: "failed", deviceId: "device_NEW" })
    const plist = "/home/ada/Library/LaunchAgents/capy-acp.dock.plist"
    expect(m.log.slice(-4)).toEqual([`write ${plist}`, "run launchctl bootout gui/1000/capy-acp.dock", `run launchctl bootstrap gui/1000 ${plist}`, `remove ${plist}`])
    expect(m.files.has(plist)).toBe(false)
    expect(m.output.join("")).toContain(`capy-acp removed ${plist} again, so the dock does not start at your next login.`)
  })

  it("shows Windows commands that PowerShell runs, also for a path with a space", () => {
    const binary = dockBinary("win32", "C:\\Users\\John Smith\\.capy")
    expect(dockCommand("win32", binary, ["dirs", "add", "C:\\src\\my app"]).display).toBe(
      "& 'C:\\Users\\John Smith\\.capy\\dock-install\\current\\bin\\capy.exe' dock dirs add 'C:\\src\\my app'"
    )
    expect(dockCommand("win32", dockBinary("win32", "C:\\Users\\Ada\\.capy"), []).display).toBe("C:\\Users\\Ada\\.capy\\dock-install\\current\\bin\\capy.exe dock")
    expect(dockCommand("linux", "/home/ada/.capy/bin/capy", ["dirs", "add", "/src/my app"]).display).toBe("/home/ada/.capy/bin/capy dock dirs add '/src/my app'")
  })

  it("reports a service that does not start, with its output", async () => {
    const m = fakeMachine({ installed: true, answers: [true], failing: ["enable --now"] })
    expect(await setupMachine(m.config, m.io, m.write)).toEqual({ status: "failed", deviceId: "device_NEW" })
    const text = m.output.join("")
    expect(text).toContain("`systemctl --user enable --now capy-dock.service` failed (exit code 1).\nFailed to connect to bus")
    expect(text).toContain("The service file is at /home/ada/.config/systemd/user/capy-dock.service.")
  })

  it("leaves a paired dock alone, and says how to link the folder when it is not linked", async () => {
    const unlinked = fakeMachine({ paired: true, installed: true })
    expect(await setupMachine(unlinked.config, unlinked.io, unlinked.write)).toEqual({ status: "ready", deviceId: "device_NEW" })
    expect(unlinked.log).toEqual([])
    expect(unlinked.output.join("")).toContain(`run \`${unlinked.binary} dock dirs add /home/ada/src/app\`, then start \`capy dock\` again.`)
    const linked = fakeMachine({ paired: true, installed: true, linked: true })
    await setupMachine(linked.config, linked.io, linked.write)
    expect(linked.output.join("")).not.toContain("dirs add")
  })
})
