<img src="https://raw.githubusercontent.com/yazcaleb/capy-acp/main/assets/icon.svg" width="64" height="64" alt="">

# capy-cli

[Capy](https://capy.ai) threads from a terminal, a script or a CI job. Start a thread, watch Capy work, answer its
questions, and get the pull request, without leaving the shell.

```console
$ npx -y capy-cli run "Read scripts/ and README.md, then reply in two sentences: what this repository is for, and one small improvement you would make. Do not change any files."
Started thread jam_01K9Z…. Capy works in its own git worktree on this computer (under ~/.capy/worktrees by default), not in your folder.
Open: https://capy.ai/thread/jam_01K9Z…
- Capy is working
- ran bash (1.8 s)
- ran bash (314 ms)
- Capy is done
This is a throwaway sandbox for testing capy-acp linked mode. Its only file is a one-line README.md, and there's no
`scripts/` directory on `main` (65fc349), so I had no scripts to read. The one improvement I'd make is to expand the
README with a few lines on what a linked-mode test run looks like and how to reset the sandbox afterward. I didn't
change any files.

Capy is done.
Device: device_01K8…
Cost so far: $0.00 in Capy credits.
Send:   npx -y capy-cli send jam_01K9Z… "<message>"
```

A real run, shortened. The reply is on stdout and the rest on stderr, so the two may interleave differently in your
terminal.

capy-cli is an independent project. Capy did not make it.

## Start

1. Get a Capy API key from [capy.ai/settings/api](https://capy.ai/settings/api), then save it:

   ```bash
   npx -y capy-cli setup
   ```

   On a computer without a Capy device, setup can also install and pair Capy's headless
   [`capy dock`](https://docs.capy.ai/dock). You approve the pairing on capy.ai once, then choose Yes in the terminal.

2. In a clone of a repository that is in a Capy project, run a task:

   ```bash
   npx -y capy-cli run "Add a --dry-run flag to the deploy script"
   ```

`npx -y capy-cli doctor` checks the key, the device and the folder, and says how to fix what is missing.

## Commands

| Command | What it does |
|---|---|
| `run [options] <task...>` | Starts a thread and streams the reply. `-` or a pipe reads the task from stdin |
| `threads` | Lists recent threads |
| `status <thread-id>` | Shows a thread: status, last reply, pull requests, questions, credits |
| `follow <thread-id>` | Streams a thread until its run ends |
| `send <thread-id> <text...>` | Sends a message. `--interrupt` stops the current run first, `--follow` streams the reply |
| `stop <thread-id>` | Stops the current run. The thread stays |
| `setup`, `doctor` | Save the key and set up a device, or check the setup |
| `help <command>` | The options of a command |

The reply goes to stdout, and what Capy does goes to stderr, so `capy-cli run "..." > reply.md` saves only the reply.
Ctrl+C once stops following and leaves the thread running. Ctrl+C twice exits at once.

## Where Capy works

`run --where` takes:

- `auto` (default): a new git worktree on a Capy device. Your folder does not change. No machine time.
- `here`: your folder, edited in place.
- `cloud`: a Capy cloud machine. `--machine-size small` to `bigguy`. Machine time costs Capy credits.

`--device <id>` and `--repo owner/name` run the worktree on another computer's Capy device, for example from a CI job
that has no device.

## Scripts and CI

`--json` prints one JSON object per line, and every line has a `type`. Errors have a `nextAction` that says what to do:
run a command, ask a person, retry after a delay, or use another option.

| Exit code | Meaning |
|---|---|
| 0 | Capy is done |
| 1 | The run failed, or an error |
| 2 | Wrong arguments |
| 3 | Capy waits on a person. Answer with `send` |
| 4 | Timed out, or Capy has not started yet. The thread keeps running |
| 130 | Stopped following with Ctrl+C |

A CI job has no Capy device, so point it at one that runs `capy dock`, for example a build server:

```yaml
- run: npx -y capy-cli run --device "$CAPY_DEVICE_ID" --timeout 1800 --json "Update the snapshot tests for the new date format and open a pull request." > capy.ndjson
  env:
    CAPY_API_KEY: ${{ secrets.CAPY_API_KEY }}
    CAPY_DEVICE_ID: ${{ vars.CAPY_DEVICE_ID }}
```

Use a key of a Capy [service user](https://docs.capy.ai/admin/members) in CI, not your personal key.

## Settings

| Variable | What it does |
|---|---|
| `CAPY_API_KEY` | The Capy API key. capy-acp, capy-mcp-server and capy-cli share the key that setup saves |
| `CAPY_DEVICE_ID` | The default Capy device for `--device` |
| `NO_COLOR` | No colors on stderr |

## Related

- [capy-mcp-server](../mcp#readme): the same threads as tools for Claude Code, Codex, Cursor, Grok and Conductor.
- [capy-acp](../acp#readme): Capy in editors that speak the Agent Client Protocol.

MIT license.
