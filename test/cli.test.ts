// The CLI: argument parsing, what goes to stdout and stderr, NDJSON, exit codes and Ctrl+C.
// Capy is a fake layer and the io is captured, so nothing reaches the network or the terminal.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { CapyClient, CapyConfigError, type CreateThread, type Thread } from "../src/capy/client.js"
import type { CapyEvent, Message } from "../src/capy/events.js"
import { COMMAND_HELP, type CliIo, entryOf, HELP, parseCommand, runCli } from "../src/cli.js"
import { readConfig } from "../src/config.js"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A config that finds no Capy device and no key on this computer. */
const config = () => {
  const home = mkdtempSync(join(tmpdir(), "capy-cli-"))
  dirs.push(home)
  return readConfig({
    CAPY_HOME: join(home, "capy"),
    CAPY_DESKTOP_CONFIG_DIR: join(home, "desktop"),
    CAPY_API_KEY_FILE: join(home, "no-such-key"),
    CAPY_API_URL: "https://api.capy.ai/api/v1"
  })
}

const PROJECTS = [{ id: "project_APP", name: "App", repos: [{ repoFullName: "acme/app" }] }]
const USER: Message = { id: "01KA0000000000000000000001", source: "user", text: "Fix the flaky test" }
const REPLY: Message = { id: "01KA0000000000000000000002", source: "assistant", callId: "a1", text: "Fixed it. See https://github.com/acme/app/pull/7" }

const DONE: ReadonlyArray<CapyEvent> = [
  { _tag: "Status", status: "working" },
  { _tag: "ToolCall", callId: "call-1", name: "bash", text: "" },
  { _tag: "Transcript", cursor: "c1", message: { id: "call-1", source: "tool", calls: [{ tool: "bash", durationMs: 1200 }] } },
  { _tag: "Assistant", callId: "a1", text: "Fixed it." },
  { _tag: "Transcript", cursor: REPLY.id, message: REPLY },
  { _tag: "Status", status: "idle" }
]

interface Log {
  readonly creates: Array<CreateThread>
  readonly interrupts: Array<string>
  readonly sends: Array<string>
  opens: number
}

const fakeCapy = (
  log: Log,
  options: { thread?: Partial<Thread>; stream?: ReadonlyArray<CapyEvent> | "never"; failWith?: unknown; committed?: boolean; slowCreate?: boolean } = {}
) => {
  const listProjects = options.failWith === undefined ? Effect.succeed(PROJECTS) : Effect.fail(options.failWith as CapyConfigError)
  return Layer.succeed(
    CapyClient,
    CapyClient.of({
      listModels: Effect.succeed([{ id: "anthropic/claude-opus-5-5", name: "Opus", reasoningModes: ["low", "high"] }]),
      listProjects,
      createThread: (body) =>
        Effect.sync(() => (log.creates.push(body), { id: "jam_new", status: "working" as const, projectId: body.projectId })).pipe(
          Effect.delay(options.slowCreate === true ? "50 millis" : "0 millis")
        ),
      sendMessage: (_, body) => Effect.sync(() => (log.sends.push(body.text), { id: "msg" })),
      interrupt: (threadId) => Effect.sync(() => void log.interrupts.push(threadId)),
      getThread: (id) => Effect.succeed({ id, status: "idle" as const, title: "Fix the flaky test", ...options.thread }),
      listThreads: (projectId) =>
        Effect.succeed([{ id: "jam_old", status: "idle" as const, projectId, title: "Old work", lastActivityAt: "2026-11-25T09:30:00Z" }]),
      uploadFiles: () => Effect.succeed([]),
      // The reply commits during the run: before a stream opens, the transcript has no reply yet.
      listMessages: () => Effect.sync(() => (log.opens === 0 && options.committed !== true ? [] : [USER, REPLY])),
      attachmentUrl: () => Effect.succeed(""),
      stream: () =>
        Stream.suspend(() => {
          log.opens++
          return options.stream === "never" ? Stream.never : Stream.fromIterable(options.stream ?? DONE)
        })
    })
  )
}

const newLog = (): Log => ({ creates: [], interrupts: [], sends: [], opens: 0 })

const cli = (
  args: ReadonlyArray<string>,
  options: Parameters<typeof fakeCapy>[1] & { tty?: boolean; env?: Record<string, string>; stdin?: string; onInterrupt?: (press: () => void) => void } = {}
) => {
  const log = newLog()
  const stdout: Array<string> = []
  const stderr: Array<string> = []
  const exits: Array<number> = []
  const tty = options.tty ?? false
  const io: CliIo = {
    stdout: (text) => void stdout.push(text),
    stderr: (text) => void stderr.push(text),
    isTTY: { stdin: options.stdin === undefined, stdout: tty, stderr: tty },
    env: options.env ?? {},
    cwd: "/work",
    readStdin: async () => options.stdin ?? "",
    onInterrupt: (handler) => {
      options.onInterrupt?.(handler)
      return () => {}
    },
    exit: (code) => void exits.push(code)
  }
  const done = runCli(args, { config: config(), capy: fakeCapy(log, options), io })
  return done.then((code) => ({ code, log, exits, out: stdout.join(""), err: stderr.join("") }))
}

const lines = (out: string) => out.trim().split("\n").map((line) => JSON.parse(line) as { type: string } & Record<string, unknown>)

describe("bin entry", () => {
  it("starts the ACP agent with no arguments, the MCP server with bare mcp, and the CLI for commands", () => {
    expect(entryOf([])).toBe("acp")
    expect(entryOf(["mcp"])).toBe("mcp")
    expect(entryOf(["mcp", "--help"])).toBe("cli")
    expect(entryOf(["run", "do it"])).toBe("cli")
    expect(entryOf(["nonsense"])).toBe("cli")
    expect(entryOf(["--setup"])).toBe("flag")
  })
})

describe("parseCommand", () => {
  it("reads run options into a start input", () => {
    expect(
      parseCommand([
        "run", "--where", "cloud", "--machine-size", "large", "--project", "App", "--model", "openai/gpt-6.2-astra",
        "--reasoning", "medium", "--folder", "../app", "--timeout", "90", "--json", "Fix", "the", "test"
      ])
    ).toEqual({
      command: "run",
      task: "Fix the test",
      start: { where: "cloud", machineSize: "large", project: "App", model: "openai/gpt-6.2-astra", reasoning: "medium", folder: "../app" },
      detach: false,
      json: true,
      timeoutMs: 90_000
    })
    expect(parseCommand(["run", "--where=worktree", "--device", "device_R", "--repo", "acme/app", "--detach", "go"])).toMatchObject({
      start: { where: "worktree", device: "device_R", repo: "acme/app" },
      detach: true,
      timeoutMs: Number.POSITIVE_INFINITY
    })
  })

  it("leaves the task to stdin for - or no words", () => {
    expect(parseCommand(["run", "-"])).toMatchObject({ command: "run", task: undefined })
    expect(parseCommand(["send", "jam_1"])).toMatchObject({ command: "send", threadId: "jam_1", text: undefined })
    expect(parseCommand(["send", "jam_1", "--interrupt", "--follow", "look", "again"])).toMatchObject({ text: "look again", interrupt: true, follow: true })
  })

  it("turns bad input into usage errors that name the command", () => {
    const usage = (args: Array<string>) => parseCommand(args) as { command: string; message: string; topic: string | undefined }
    expect(usage(["run", "--where", "moon", "x"])).toMatchObject({ command: "usage", topic: "run", message: '--where takes auto, worktree, here, cloud, not "moon".' })
    expect(usage(["run", "--machine-size", "large", "x"]).message).toContain("--machine-size needs --where cloud")
    expect(usage(["run", "--machine-size", "huge", "--where", "cloud", "x"]).message).toContain("small, medium, large, ultra, hyper, bigguy")
    expect(usage(["run", "--timeout", "0", "x"]).message).toContain("--timeout takes a number of seconds")
    expect(usage(["run", "--bogus", "x"]).message).toContain("--bogus")
    expect(usage(["threads", "--limit", "500"]).message).toContain("1 to 100")
    expect(usage(["status"]).message).toContain("Give the thread id")
    expect(usage(["stop", "a", "b"]).message).toContain("one thread id")
    expect(usage(["launch"])).toMatchObject({ message: "Unknown command: launch", topic: undefined })
    // An unknown help topic shows the list of commands.
    expect(usage(["help", "launch"])).toMatchObject({ command: "usage", message: 'No command is called "launch".', topic: undefined })
  })

  it("routes help <command> and <command> --help to that command's help", () => {
    expect(parseCommand(["help", "run"])).toEqual({ command: "help", topic: "run" })
    expect(parseCommand(["follow", "--help"])).toEqual({ command: "help", topic: "follow" })
    expect(parseCommand(["mcp", "-h"])).toEqual({ command: "help", topic: "mcp" })
    expect(parseCommand(["help"])).toEqual({ command: "help", topic: undefined })
  })
})

describe("help and usage", () => {
  it("prints the help of one command on stdout", async () => {
    const run = await cli(["help", "run"])
    expect(run).toMatchObject({ code: 0, out: COMMAND_HELP.run, err: "" })
    expect(run.out).toContain("--machine-size <size>")
    expect((await cli(["help"])).out).toBe(HELP)
    expect(HELP).toContain("npx -y capy-acp --setup")
    expect(HELP).toContain("npx -y capy-acp run [options] <task...>")
  })

  it("exits 2 with usage on stderr, or as an NDJSON error with --json", async () => {
    const unknown = await cli(["launch", "it"])
    expect(unknown.code).toBe(2)
    expect(unknown.err).toBe(`Unknown command: launch\n\n${HELP}`)
    const topic = await cli(["help", "bogus"])
    expect(topic).toMatchObject({ code: 2, err: `No command is called "bogus".\n\n${HELP}` })
    const bad = await cli(["run", "--where", "moon", "x"])
    expect(bad).toMatchObject({ code: 2, out: "" })
    expect(bad.err).toContain("npx -y capy-acp help run")
    const json = await cli(["run", "--where", "moon", "--json", "x"])
    expect(json.code).toBe(2)
    expect(lines(json.out)).toEqual([
      expect.objectContaining({ type: "error", title: "Fix the command", nextAction: { kind: "run_command", command: "npx -y capy-acp help run" } })
    ])
  })

  it("exits 2 when there is no task in the arguments or on stdin", async () => {
    const result = await cli(["run"])
    expect(result.code).toBe(2)
    expect(result.log.creates).toEqual([])
  })
})

describe("run", () => {
  it("streams the reply to stdout and activity plus a summary to stderr, then exits 0", async () => {
    const result = await cli(["run", "--where", "cloud", "--project", "App", "Fix", "the", "flaky", "test"])
    expect(result.code).toBe(0)
    expect(result.log.creates[0]).toMatchObject({ projectId: "project_APP", message: "Fix the flaky test" })
    expect(result.log.creates[0]).not.toHaveProperty("device")
    expect(result.out).toBe("Fixed it. See https://github.com/acme/app/pull/7\n")
    expect(result.err).toContain("Started thread jam_new. Capy runs this thread on a cloud machine of the project's size. Machine time costs Capy credits")
    expect(result.err).toContain("- Capy is working\n- ran bash (1.2 s)\n")
    // The reply has no newline yet when Capy finishes: the activity line starts on a new line, so
    // output that merges both streams (2>&1) keeps the pull request link whole.
    expect(result.err).toContain("- ran bash (1.2 s)\n\n- Capy is done\n")
    expect(result.err).toContain("Capy is done.\nThread: jam_new (Fix the flaky test)\n")
    expect(result.err).toContain("Pull request: https://github.com/acme/app/pull/7\n")
    expect(result.err).toContain("Open: https://capy.ai/thread/jam_new\n")
    expect(result.err).toContain('Send:   npx -y capy-acp send jam_new "<message>"')
    expect(result.err).not.toContain("\x1b[")
  })

  it("reads the task from stdin", async () => {
    const result = await cli(["run", "--where", "cloud", "--project", "App", "-"], { stdin: "Task from a pipe\n" })
    expect(result.code).toBe(0)
    expect(result.log.creates[0]?.message).toBe("Task from a pipe")
  })

  it("dims activity on a terminal, unless NO_COLOR is set", async () => {
    const tty = await cli(["run", "--where", "cloud", "--project", "App", "go"], { tty: true })
    expect(tty.err).toContain("\x1b[2m- Capy is working\x1b[22m\n")
    const plain = await cli(["run", "--where", "cloud", "--project", "App", "go"], { tty: true, env: { NO_COLOR: "1" } })
    expect(plain.err).toContain("- Capy is working\n")
    expect(plain.err).not.toContain("\x1b[")
  })

  it("prints only the thread id on stdout with --detach, and does not follow", async () => {
    const result = await cli(["run", "--detach", "--where", "cloud", "--project", "App", "go"])
    expect(result).toMatchObject({ code: 0, out: "jam_new\n" })
    expect(result.log.opens).toBe(0)
    expect(result.err).toContain("Follow: npx -y capy-acp follow jam_new")
  })

  it("prints NDJSON with a type on every line and a final report", async () => {
    const result = await cli(["run", "--json", "--where", "cloud", "--project", "App", "go"])
    expect(result.code).toBe(0)
    expect(result.err).toBe("")
    const events = lines(result.out)
    expect(events.map((e) => e.type)).toEqual(["started", "activity", "activity", "reply", "reply", "activity", "report"])
    expect(events[0]).toMatchObject({ type: "started", id: "jam_new", where: "cloud", status: "working" })
    expect(events.at(-1)).toMatchObject({
      type: "report",
      id: "jam_new",
      status: "idle",
      timedOut: false,
      lastReply: REPLY.text,
      pullRequests: [{ url: "https://github.com/acme/app/pull/7", repo: "acme/app", number: 7 }],
      url: "https://capy.ai/thread/jam_new"
    })
  })

  it("exits 1 with the Problem and its next action when Capy has no key", async () => {
    const failWith = new CapyConfigError({ message: "No Capy API key." })
    const text = await cli(["run", "--where", "cloud", "--project", "App", "go"], { failWith })
    expect(text.code).toBe(1)
    expect(text.err).toContain("Add your Capy API key.")
    expect(text.err).toContain("Next: Ask the person to run `npx -y capy-acp --setup`")
    const json = await cli(["run", "--json", "--where", "cloud", "--project", "App", "go"], { failWith })
    expect(json.code).toBe(1)
    expect(lines(json.out)).toEqual([
      expect.objectContaining({ type: "error", title: "Add your Capy API key", nextAction: expect.objectContaining({ kind: "ask_human" }) })
    ])
  })

  it("exits 1 when no Capy device can run the thread, and never picks the cloud", async () => {
    const result = await cli(["run", "--json", "--folder", tmpdir(), "go"])
    expect(result.code).toBe(1)
    expect(result.log.creates).toEqual([])
    expect(lines(result.out)[0]).toMatchObject({ type: "error", title: "Choose where Capy runs this thread", nextAction: { kind: "ask_human" } })
  })
})

describe("follow, status, send, stop and threads", () => {
  it("exits 3 when Capy waits on a person, with the ask in the summary", async () => {
    const result = await cli(["follow", "jam_1"], {
      stream: [{ _tag: "Status", status: "working" }, { _tag: "Status", status: "waiting" }],
      thread: { status: "waiting", ask: { kind: "environment", text: "Add STRIPE_KEY" }, needsYou: true }
    })
    expect(result.code).toBe(3)
    expect(result.err).toContain("Capy needs you.")
    expect(result.err).toContain("Capy asks (environment): Add STRIPE_KEY")
    // Following again would return at once: the answer is the next step.
    expect(result.err).toContain('Answer: npx -y capy-acp send jam_1 "<answer>"')
    expect(result.err).not.toContain("Follow:")
  })

  it("exits 4 on the timeout and leaves the thread running", async () => {
    const result = await cli(["follow", "jam_1", "--timeout", "0.05", "--json"], { stream: "never", thread: { status: "working" } })
    expect(result.code).toBe(4)
    expect(result.log.interrupts).toEqual([])
    expect(lines(result.out).at(-1)).toMatchObject({ type: "report", status: "working", timedOut: true })
  })

  it("exits 1 when the run failed", async () => {
    const result = await cli(["follow", "jam_1"], {
      stream: [{ _tag: "Status", status: "working" }, { _tag: "Status", status: "failed" }],
      thread: { status: "failed" }
    })
    expect(result.code).toBe(1)
    expect(result.err).toContain("The run failed.")
  })

  it("stops following on the first Ctrl+C without stopping the thread, and exits on the second", async () => {
    let press = () => {}
    const pending = cli(["follow", "jam_1"], { stream: "never", thread: { status: "working" }, onInterrupt: (p) => (press = p) })
    await new Promise((r) => setTimeout(r, 20))
    press()
    const result = await pending
    expect(result.code).toBe(130)
    expect(result.log.interrupts).toEqual([])
    expect(result.err).toContain("Stopped following. The thread keeps running on Capy.\nFollow: npx -y capy-acp follow jam_1\nStop:   npx -y capy-acp stop jam_1")
    press()
    expect(result.exits).toEqual([130])
  })

  it("lets a Ctrl+C during the start finish the create, then stops following", async () => {
    let press = () => {}
    const pending = cli(["run", "--where", "cloud", "--project", "App", "go"], { slowCreate: true, onInterrupt: (p) => (press = p) })
    await new Promise((r) => setTimeout(r, 10))
    press()
    const result = await pending
    expect(result.code).toBe(130)
    expect(result.log.creates).toHaveLength(1)
    expect(result.log.opens).toBe(0)
    expect(result.err).toContain("Started thread jam_new.")
    expect(result.err).toContain("Stop:   npx -y capy-acp stop jam_new")
  })

  it("prints status with the last reply on stdout", async () => {
    const result = await cli(["status", "jam_1"], { committed: true })
    expect(result.code).toBe(0)
    expect(result.out).toContain("Capy is done.\nThread: jam_1 (Fix the flaky test)")
    expect(result.out).toContain(`Last reply:\n${REPLY.text}\n`)
  })

  it("sends a message in line by default, or with --interrupt, and stops a run", async () => {
    const queued = await cli(["send", "jam_1", "Also", "fix", "lint", "--json"])
    expect(queued.code).toBe(0)
    expect(queued.log.sends).toEqual(["Also fix lint"])
    expect(lines(queued.out)[0]).toMatchObject({ type: "sent", id: "jam_1", nextAction: { kind: "run_command", command: "npx -y capy-acp follow jam_1 --json" } })
    // The thread's status is from before Capy read the message, so the summary does not say it is done.
    const text = await cli(["send", "jam_1", "more", "please"])
    expect(text.err).toContain("Capy has the message.\nThread: jam_1")
    expect(text.err).toContain("Follow: npx -y capy-acp follow jam_1")
    expect(text.err).not.toContain("Capy is done.")
    const stopped = await cli(["stop", "jam_1"])
    expect(stopped).toMatchObject({ code: 0 })
    expect(stopped.log.interrupts).toEqual(["jam_1"])
  })

  it("lists threads as a table, or one NDJSON line per thread and a count", async () => {
    const table = await cli(["threads"])
    expect(table.out).toBe("jam_old  done  App  2026-11-25 09:30  Old work\n")
    const json = await cli(["threads", "--json", "--project", "App"])
    expect(lines(json.out)).toEqual([
      expect.objectContaining({ type: "thread", id: "jam_old", status: "idle", projectName: "App" }),
      { type: "threads", count: 1 }
    ])
  })
})
