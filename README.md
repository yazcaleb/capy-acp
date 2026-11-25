<img src="assets/icon.svg" width="64" height="64" alt="">

# capy-acp

capy-acp runs [Capy](https://capy.ai) coding-agent threads from an [Agent Client Protocol](https://agentclientprotocol.com)
(ACP) client, such as T3 Code. Each ACP session is a Capy thread on the Capy device of this machine. The agent works in the
folder that you open, with your tools. Device threads use no Capy machine time. The model runs on your connected subscription,
unless you select a model that Capy bills to credits.

capy-acp is an independent project. Capy did not make it. Read [Limitations](#limitations) and [Tests](#tests) before you use
it.

## What the client shows

- The reply from Capy, streamed as Capy writes it.
- One item for each Capy tool call. The title gives the tools and the time, for example `bash, write (1.2 s)`.
- A diff of each file that a tool call changed, for example `Edited README.md and scripts/greet.sh`. The Capy stream does not
  give paths or contents. The adapter reads the changes with git (read only), in your folder or in the Capy worktree of the
  thread. It looks when a tool call starts and when it ends. Edits that you made before the prompt do not count. A change that
  occurs while no Capy tool call can write, for example your own edit between two calls, gets its own item:
  `Edited notes.md outside a Capy tool call`.
- Images, audio and other files that you attach. They go to Capy with the message, and Capy models see attached images.
- Files that Capy attaches to a reply, as links. A file that Capy made on this machine links to its local path. Other files link
  to a Capy download URL, which expires.
- Capy subagents, as items that show their status: pending, running, completed or failed.
- The models of your Capy account. A model that Capy bills to credits shows its price, for example
  `Inkling 2 Small · $0.30/$1.00 per 1M`, or `Particle-1 · free`. After a turn that used Capy credits, a notice gives the
  amount.

The adapter also does these things:

- Cancel stops the Capy thread. The call that the cancel stopped shows as failed, and calls that finished before it show as
  completed. A follow-up message continues the same thread.
- Sessions stay available after a restart. `session/load` replays the thread transcript, and `session/resume` connects again
  without a replay. `session/list` lists the saved sessions. The next prompt continues the same Capy thread.
- If the connection drops, the adapter connects again and continues from the last event. It shows each event one time.
- If the setup has a problem, the reply tells you how to fix it. Examples are a key that Capy rejects, a folder that is not
  linked, or a repository that is not in a Capy project. (Without a key, the client shows the agent as signed out.) Fix the problem and send the message again. You do not need a new session or a
  restart.

## Permissions

Capy runs commands and edits files without approval, as it does in the Capy app. **capy-acp never asks your ACP client for
permission.** Approval prompts and read-only modes in the client have no effect. To control Capy, write instructions in the
message or in `AGENTS.md`, or change the Capy settings. The Capy docs say that Capy opens a pull request only when you ask.

## Requirements

- Node 22 or later.
- A Capy device on this machine. Sign in to the Capy desktop app, or run the headless `capy dock`.
- A clone of a GitHub repository that is in a Capy project. Any git remote of the clone can name the repository.
- The folder of that clone, linked to this device. Only the device can link a folder, so the Capy website cannot do it:
  - Desktop app: open the project in Settings, then Projects (`capy://app/settings/projects/<project id>` opens it), set it
    up on this computer, and choose the folder. Scan a folder also works.
  - `capy dock`: stop the dock, run `capy dock dirs add <path>`, and start the dock again. Stopping the dock stops the Capy
    threads that run on this computer.

  If Capy links another clone of the same repository on this computer, the first reply names that folder.
- A Capy API key. Create one in the Capy app under Settings, then API. To save it, run `npx -y capy-acp --setup`. The command
  checks the key with Capy and writes it to `~/.config/capy-acp/api-key` with mode 0600. It also reads the key from a pipe,
  for scripts: `capy-acp --setup < key-file`. You can also set `CAPY_API_KEY`.

## Setup

In **T3 Code**:

1. Open Settings, then Providers, then Add provider.
2. Select Show more, then **Local ACP command**.
3. Set the command to `npx` with the arguments `-y capy-acp`. To use a checkout, set the command to `node` with the path to
   `dist/bin.js`.
4. Open a linked folder as the project.
5. Select the Capy provider.

In **other ACP clients**, set the agent command to `npx -y capy-acp`. Set the working directory of the session to the linked
folder. The tests used only T3 Code as a client.

capy-acp announces `capy-acp --setup` as a terminal auth method. A client that supports terminal auth can run the setup for
you. Until a key is saved, `session/new` fails with `auth_required`, so T3 Code shows the agent as signed out and offers
the setup.

To give the key in T3 Code instead, add `CAPY_API_KEY` to the environment of the provider instance. In
`~/.t3/userdata/settings.json`, the instance takes `environment: [{ "name": "CAPY_API_KEY", "value": "…", "sensitive": true }]`.
The other [settings](#settings) go in the same list.

### Install without npx

`npx -y capy-acp` downloads the newest version when its cache is empty. To pin a version, install it in a folder of its own and
run that copy:

```sh
npm install --prefix ~/.local/opt/capy-acp capy-acp@0.2.0
```

Then set the command to `node` with the argument `~/.local/opt/capy-acp/node_modules/capy-acp/dist/bin.js`, as an absolute
path. Use the absolute path of `node` too if your editor does not start from a login shell. A version manager such as fnm can
give `which node` a path that changes in each shell, so use the path of the installed Node version instead.

On **Windows**, T3 Code starts the command without a shell and refuses `.cmd` files such as `npx.cmd`. Set the command to the
absolute path of `node.exe`, with the absolute path of `dist\bin.js` as the argument.

## Settings

| Variable | Default | Effect |
| --- | --- | --- |
| `CAPY_API_KEY` | (unset) | The Capy API key. The adapter reads it for each request, so a new key needs no restart |
| `CAPY_API_KEY_FILE` | `~/.config/capy-acp/api-key` | The file with the key, if `CAPY_API_KEY` is not set |
| `CAPY_ACP_PRICING_URL` | `https://docs.capy.ai/models-and-pricing.md` | The page with the model price table. An empty value turns the prices off |
| `CAPY_ACP_MODEL` | `anthropic/claude-opus-5-5` | The first model of a session. The model picker lists all models of your Capy account and labels the models that Capy bills to credits |
| `CAPY_ACP_REASONING` | `high` | The first reasoning level. If a model does not offer this level, the adapter uses the last level that the model lists |
| `CAPY_ACP_WORKSPACE` | `linked` | `linked`: Capy edits the folder that you opened. `worktree`: each session gets a new Capy worktree, in the worktree folder of Capy (`~/.capy/worktrees` by default). The diffs show the files there |
| `CAPY_ACP_ALLOW_WORKTREE_FALLBACK` | off | For a clone that is not linked, use a worktree of a linked folder of the same repository |
| `CAPY_ACP_WAITING_LIMIT_MS` | `600000` | The time that a prompt stays open while Capy waits for a background command |
| `CAPY_ACP_FORWARD_HOST_INSTRUCTIONS` | off | Send the host instructions from T3 Code to Capy. Without this setting, the adapter sends only the request of the user |
| `CAPY_DEVICE_ID` | from the desktop app or `capy dock` | The device to use, if the machine has a device in more than one organization |
| `CAPY_DESKTOP_CONFIG_DIR` | `~/.config/Capy` (Linux), `~/Library/Application Support/Capy` (macOS), `%APPDATA%\Capy` (Windows) | The folder of the desktop app file `device-ids.json` |
| `CAPY_HOME` | `~/.capy` | The folder of `worktrees`, `device/workspaces.json` (the linked folders) and, for `capy dock`, `dock/status.json` |
| `CAPY_ACP_STATE_DIR` | `~/.local/state/capy-acp/sessions` | The saved sessions: one small JSON file for each session, with ids, the stream cursor and the model. No credentials |
| `CAPY_ACP_ATTACHMENTS_DIR` | `~/.cache/capy-acp/attachments` | The folder for files from the *first* prompt of a thread (see below) |

### Attachments on a new thread

The Capy call that creates a thread accepts only text. A file in a second message can arrive after a fast model already
answered. For this reason, the adapter saves the files of the first prompt on this machine, readable only by you. The message
gives their paths, and the device agent reads them on this machine. Follow-up messages attach files with the Capy upload API.

## Limitations

The first four come from Capy. [docs/capy-api-notes.md](docs/capy-api-notes.md) lists the API changes that would remove the
first three.

- **Tool items show tool names and times, but no commands or output.** The Capy stream does not give them. The diffs show the
  file changes.
- **The client shows no reasoning, plan or token usage.** The Capy stream does not give them.
- **The adapter reads the device id from a local Capy file.** The Capy API cannot list devices. The file is `device-ids.json`
  of the desktop app, or `~/.capy/dock/status.json` of `capy dock`. The adapter never writes it. If a Capy update moves it,
  setup fails, and the reply names the file. Set `CAPY_DEVICE_ID` to continue.
- **Capy works only with repositories on GitHub.com.**
- **If you edit a file while a Capy tool call that can write runs, the diffs show your edit as part of that call.** The adapter
  sees only the files, not the process that changed them. To keep your edits out of Capy's diffs, set
  `CAPY_ACP_WORKSPACE=worktree`. Capy then works in its own git worktree, which you do not edit, and its changes stay out of
  your folder until you merge them. The full fix needs Capy to report the files that each call changed (ask 3 in
  [docs/capy-api-notes.md](docs/capy-api-notes.md)).

## Tests

| Platform | Capy | Client | Checks |
| --- | --- | --- | --- |
| Linux x64, Node 22 to 26 | Desktop app 0.6.0 | T3 Code 0.1.12, ACP test client | All the items in [What the client shows](#what-the-client-shows), and restarts |
| macOS 26 arm64, Node 26 | `capy dock` 0.7.2 | ACP test client | Prompts, cancel, a dropped stream, a delivered file, a subagent |
| Windows Server 2022 x64, Node 24 | `capy dock` 0.7.2 | ACP test client | The macOS checks, and diffs in linked mode and worktree mode |

CI runs the unit tests on Linux. The unit tests also pass on macOS and Windows. These cases had no test:

- T3 Code on macOS or Windows.
- The desktop app on macOS or Windows. The adapter finds its files in the folders that the code of the app sets.
- A subagent on a new cloud machine.

## Troubleshooting

Run `npx -y capy-acp --doctor` in the project folder. It checks Node, the API key, the device and the folder, and prints a
fix for each problem. It also says if npm has a newer capy-acp. The adapter writes its log to stderr. These are common first replies:

| Reply | Fix |
| --- | --- |
| T3 Code shows the agent as signed out | Run `npx -y capy-acp --setup`, or set `CAPY_API_KEY` |
| **Start Capy on this computer** | Sign in to the Capy desktop app, or run `capy dock`. The reply lists each file that capy-acp read. Or set `CAPY_DEVICE_ID`, and `CAPY_DESKTOP_CONFIG_DIR` or `CAPY_HOME` |
| **Open a repository to use Capy**, or **Add the GitHub remote** | Open the folder of a clone. One of its remotes must name the GitHub repository |
| **Add owner/repo to a Capy project** | Add the repository to a Capy project |
| **Link this folder to Capy** | Link the folder as the reply tells you. Then send the message again |
| **Use the folder that Capy links for owner/repo** | Open the folder that the reply names, link this folder instead, or set `CAPY_ACP_ALLOW_WORKTREE_FALLBACK=1` |
| `Capy has not started on this message yet` | Make sure that the Capy desktop app or `capy dock` runs and is signed in. The message stays in the thread queue |

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
node spike/acp-client.ts <folder> "<prompt>" ["<follow-up>"] [--cancel-after-ms N] [--between "<command>"] \
  [--image N:<file>] [--load <sessionId> | --resume <sessionId>]
```

The tests replay recorded Capy streams from `fixtures/`. They operate the agent over a real ACP connection with a fake Capy
client. [`docs/design.md`](docs/design.md) explains how the adapter works around the Capy API, and
[`docs/capy-api-notes.md`](docs/capy-api-notes.md) is the feedback for Capy: ranked asks, with evidence from the recordings.

## License

[MIT](LICENSE)
