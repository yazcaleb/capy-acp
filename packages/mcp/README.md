<img src="https://raw.githubusercontent.com/yazcaleb/capy-acp/main/assets/icon.svg" width="64" height="64" alt="">

# capy-mcp-server

An MCP server that lets your coding agent hand work to [Capy](https://capy.ai). Claude Code, Codex, Cursor, Grok Build,
Grok Bot and Conductor's agents can start a Capy thread, wait for it with live progress, answer its questions, and come
back for the reply and the pull request.

Your agent keeps working in your folder while Capy works in its own git worktree. Use it for the work that is
independent, long, parallel, or that should end in a pull request.

capy-mcp-server is an independent project. Capy did not make it.

## Add it to your agent

You need a Capy API key from [capy.ai/settings/api](https://capy.ai/settings/api). Save it once on this computer:

```bash
npx -y capy-mcp-server --setup
```

Then add the server. The command that the agent runs is `npx -y capy-mcp-server`.

| Agent | How to add it |
|---|---|
| Claude Code | `claude mcp add capy -s user -- npx -y capy-mcp-server` |
| Codex | `codex mcp add capy -- npx -y capy-mcp-server` |
| Cursor | Add the JSON below to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a repository |
| Grok Build | `grok mcp add capy -- npx -y capy-mcp-server` (Grok Build also reads Claude Code's MCP settings) |
| Conductor | Add it for Claude Code or Codex as above. Conductor's agents load those settings |
| Grok Bot | See [Agents in the cloud](#agents-in-the-cloud) |

```json
{
  "mcpServers": {
    "capy": { "command": "npx", "args": ["-y", "capy-mcp-server"] }
  }
}
```

Then ask your agent, for example: "Have Capy add retry with backoff to the webhook sender and open a pull request.
Keep working on the parser meanwhile."

## Tools

| Tool | What it does |
|---|---|
| `start_thread` | Starts a Capy thread for a task. Returns at once with the thread id. |
| `wait_for_thread` | Follows the thread until the run ends, Capy needs a person, or the timeout (up to 10 minutes) passes. Sends progress while it waits. A timeout never stops the thread. |
| `get_thread` | The thread now: status, last reply, pull requests, questions, credits. |
| `send_message` | An answer to Capy's question, or more work. It waits for the current run unless `interrupt` is true. |
| `stop_thread` | Stops the current run. The thread stays, and a new message continues it. |
| `list_threads` | Recent threads, newest first. |
| `list_models` | The models of your Capy account, with how each one is billed. |

Each result has text for the model and the same data as `structuredContent`. Each error also has a `nextAction`, so the
agent knows what to do next without guessing:

| `nextAction.kind` | The agent should |
|---|---|
| `run_command` | Run the exact `command` |
| `ask_human` | Ask the person the exact question in `say` |
| `retry` | Wait `afterMs` milliseconds, then call again |
| `use_option` | Call again with another value for `option` |

## Where Capy works

| `where` | Where | Your files | Cost |
|---|---|---|---|
| `auto` (default), `worktree` | A new git worktree on a Capy device: this computer's, or the one in `device` / `CAPY_DEVICE_ID` | Not changed | No machine time |
| `here` | Your folder, edited in place. Only when the person asks | Changed | No machine time |
| `cloud` | A Capy cloud machine, with `machineSize` from small to bigguy | Not changed | Machine time costs Capy credits |

A Capy device is a computer that runs the [Capy desktop app](https://docs.capy.ai/desktop) or the headless
[`capy dock`](https://docs.capy.ai/dock). On a computer without one, `npx -y capy-mcp-server --setup` can install and
pair `capy dock` for you. You approve the pairing on capy.ai once, as Capy designed it.

The server never starts a cloud machine unless the call asks for `where: "cloud"`. Models run on your connected
subscription or your Capy credits, as your Capy settings say. Without a `model`, Capy uses your account's default model.

## Agents in the cloud

Grok Bot and other hosted agents run the server on their own computer, which has no Capy device and no clone of your
repository. Point the server at a device that you already have, such as a server that runs `capy dock`:

1. On the computer with the device, run `npx -y capy-mcp-server --setup`. It prints the device id:
   `Capy device on this computer: device_…`. (`npx -y capy-cli doctor` prints it too.)
2. Add the server to the hosted agent with these environment variables:
   - `CAPY_API_KEY`: a key for a Capy [service user](https://docs.capy.ai/admin/members), not your personal key
   - `CAPY_DEVICE_ID`: the device id from step 1
3. Pass `project` (and `repo`, if the project has more than one) to `start_thread`.

Capy then makes a worktree from GitHub on that device, and the thread costs no machine time. In Grok Bot, ask in chat:
"Add a custom MCP server called capy that runs `npx -y capy-mcp-server`", then give it the two variables.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `CAPY_API_KEY` | the key saved by `--setup` | The Capy API key. capy-acp, capy-mcp-server and capy-cli share the saved key |
| `CAPY_DEVICE_ID` | this computer's device | The Capy device to run on |
| `CAPY_API_URL` | `https://api.capy.ai/api/v1` | The Capy API |

## Limits

- Capy's stream does not give commands or file paths, so progress says `ran bash (1.2 s)`, not the command.
- The server cannot link a folder to Capy or pair a device by itself. Capy's API has no endpoint for either. The
  error then tells the agent what to ask the person.
- There is no hosted (HTTP) version, so Grok on grok.com cannot use it.

## Related

- [capy-acp](../acp#readme): Capy in editors that speak the Agent Client Protocol (T3 Code, Zed, JetBrains).
- [capy-cli](../cli#readme): Capy threads from a terminal or a CI job.

MIT license.
