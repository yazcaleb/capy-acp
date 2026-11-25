# Capy API notes

Feedback on the Capy public API from building [capy-acp](../README.md), which runs Capy device threads from any Agent Client
Protocol (ACP) client. The goal is one client integration that puts Capy in T3 Code, Zed, JetBrains IDEs, Neovim, Emacs and
the other ACP editors. Device threads run on the user's own machine and subscriptions, so they use no Capy machine time.

capy-acp is a community project. Capy did not make it.

**The short version.** The API was enough to build a working adapter: streaming, resume, cancel, files, subagents and
diffs work on Linux, macOS and Windows. Seven changes would remove almost all of its workarounds. The first one matters most:
a public, read-only way to find the device on this machine and the folders it links. Today every integrator has to read
private Capy files to get them.

Each claim below cites a recording in `fixtures/`, a live API response, or a docs page. All were checked again on
2026-11-25. Thread ids and timestamps for any item are available on request, so you can match them to server logs.

## Contents

- [What works well](#what-works-well)
- [The asks, ranked](#the-asks-ranked)
- [Small fixes](#small-fixes)
- [What I take to be intended](#what-i-take-to-be-intended)
- [Questions](#questions)
- [Reference](#reference)
- [How this was tested](#how-this-was-tested)

## What works well

- **Device threads through the public API.** `POST /threads` with `device: {deviceId, workspace}` starts a thread on the
  user's machine. On a connected subscription the runs cost 0 credits.
- **Linked mode.** `{kind: "linked", root}` edits the open folder in place, which is what an editor user expects.
- **Resume.** `Last-Event-ID` resumes a stream exactly. No recording replayed an old event.
- **Idempotent sends.** `clientKey` makes a retried prompt safe.
- **Errors.** Errors before the stream are tagged JSON (`capy/ThreadNotFound`, `ModelSelection.Rejected`, ...), so a client
  can turn them into a fix for the user.
- **`until=run` with `done`.** This is the one reliable way to know that a run's entries are committed.
- **Docs for machines.** Each docs page has a `.md` twin, and `llms-full.txt` and `openapi.json` exist. The checks in this
  file used them.

## The asks, ranked

| # | Ask | What the user sees today | What capy-acp does instead |
| --- | --- | --- | --- |
| 1 | Find the device and its linked folders | Setup fails when Capy moves a local file. An unlinked folder is found only after the first prompt fails | Reads `device-ids.json`, `~/.capy/dock/status.json` and `~/.capy/device/workspaces.json`, then sends a root and matches the 400 message with a regex |
| 2 | A turn-commit and cursor contract | Without care: the last reply shows again on the next turn, or a reply is lost after a reload | Waits for `done` on an `until=run` stream, with a 10 s grace timer, then checks `GET /threads/{id}`. Saves the cursor after every frame |
| 3 | Tool call detail and status | "write, bash (1.6 s)" with no command, no output and no changed files. A stopped call can look finished | 288 lines of git diffing (`src/changes.ts`). Guesses the outcome of a stopped call |
| 4 | Where a thread runs | Diffs disappear if the thread moves to another machine | Finds the worktree in the private worktree list of `workspaces.json`, or at `~/.capy/worktrees/<threadId>/<repo>` |
| 5 | Files on thread create | "No image came through", then a second answer when the image arrives | Saves the files on the device and sends their paths in the text |
| 6 | Prices and input types on `GET /models` | A picker that cannot say which models are free, or which accept images | Parses the price table of the docs page. Offers images for every model |
| 7 | Token usage on `turn end` | No context or usage meter | Shows credits after a turn from `GET /threads/{id}`. Sends no ACP usage update |

### 1. Find the device and its linked folders

**Today.** No public endpoint lists devices (`GET /devices` answers `404 capy/RouteNotFound`). `GET /folders` exists, but
its folders are sidebar folders for threads, not device folders. A client finds the device id in one of two private files,
and a different one for each way to pair a machine:

- The desktop app writes `device-ids.json` in its Electron user data folder, one id for each organization. The folder name
  changes with the release channel (`Capy`, `Capy Nightly`, `Capy Dev`).
- `capy dock` writes `~/.capy/dock/status.json`.

The linked folders are in `~/.capy/device/workspaces.json`, which the app writes again from server state. The local copy
can be out of date, so capy-acp sends the root anyway and reads the answer:
`400 capy/InvalidRequest "This device does not link a folder at <path>"`.

**Cost.** `readDeviceId` and `readLinkedFolders` in `src/workspace.ts`, a `CAPY_DEVICE_ID` setting for users in more than
one organization, and a regex on an error message (`isNotLinked` in `src/agent.ts`). The next Capy release that moves a file
breaks every integration that does this.

**Proposal.** Linking a local path from a cloud API is a security decision, so linking should stay on the machine (app or
`capy dock dirs add`). Listing is the part that integrations need:

```http
GET /devices
→ { "items": [{ "id": "device_…", "name": "…", "platform": "linux" | "darwin" | "win32",
                "kind": "desktop" | "dock", "online": true, "lastSeenAt": "…" }] }

GET /devices/{id}/folders
→ { "items": [{ "root": "/home/me/app", "repos": ["acme/app"] }] }
```

A client also needs to know which device is the machine that it runs on. An API key cannot tell. A documented local command
would be enough, for example `capy device --json` → `{deviceId, orgId, folders, worktreeBase}`, with the same output from
the app and the dock.

### 2. A turn-commit and cursor contract

This combines three problems with the same root: a client cannot tell when a turn's entries are durable, or what its resume
cursor is.

**Commit timing.** Capy commits each transcript entry about one model step after its live frames. The final reply commits
after the closing `status: idle` in 4 of the 7 recorded runs that ended with a reply: Haiku `s1-write`, Opus `s2-edit`,
Astra `s1-write` and Astra `s2-edit`. A client that ends the turn on `idle` saves a cursor that is one entry short, and the next
turn shows the last reply again. capy-acp had exactly this bug.

**Position.** `GET /threads/{id}/messages` ends with `cursor: null`, and its tool entries carry the call id, not the event
id. In the fixture `fixtures/anthropic_claude-opus-5-5/s1-write/stream.sse`, a tool entry has `id: toolu_01Ds…` in its data
and `01M84218Z7…` as its SSE id. After a restart, a client cannot find out where to resume from the message list.

**Run and turn frames.** In 4 of 9 recorded streams there is no `run start` (all three Astra streams, and the Opus
follow-up). The four streams opened right after a thread was created on a Claude model start with `turn end` `aborted` and
`run end` before `run start`. A client cannot use these frames to mark a turn. This may be a replay of the previous run's
end, which would be fine if the docs said so.

**Cost.** A 10 s grace timer after `idle` (`END_GRACE_MS` in `src/turn.ts`), a `GET /threads/{id}` check when the stream
closes, a cursor write after every frame, and a load that moves the cursor to the newest replayed entry.

**Proposal.**

```text
turn end / run end      + "lastEventId": "<event id of the last entry committed so far>"
GET /threads/{id}       + "latestEventId": "…"
GET /threads/{id}/messages items  + "eventId": "…"   (the id to pass as Last-Event-ID)
docs                    which frames a new stream can repeat from an earlier run
```

### 3. Tool call detail and status

**Today.** Claude Opus 5.5 and GPT-6.2 Astra call tools through an `execute` wrapper. Its live frame is
`{"name": "execute", "text": ""}`, and its transcript entry has `calls: [{tool, durationMs}]`. Haiku 5.5 calls `bash`
directly and gets a one-line summary. No frame gives a command, a path, an exit code or output. A call that an interrupt
stopped is committed like a finished call. The only sign is a missing `calls` list on an `execute` entry, and Haiku entries
never have `calls`, so after a cancel their outcome is unknown.

**What the user sees.** A tool item titled "write, bash (1.6 s)". Without the adapter's own diffs, the changed files would
not show at all.

**Cost.** `src/changes.ts` records a git baseline before each prompt and compares the folder at each tool call boundary. It
handles CRLF, smudge filters and LFS, and still cannot tell a user's edit from Capy's while a writing call runs.

**Proposal.** Even `status` and `paths` alone would remove most of this.

```json
"calls": [{
  "tool": "bash",
  "status": "completed" | "failed" | "interrupted",
  "durationMs": 347,
  "summary": "git status --short",
  "exitCode": 0,
  "paths": [{ "path": "README.md", "change": "modified" }]
}]
```

The same `summary` on the live `tool_call` frame of an `execute` call would give the editor something to show while the
call runs.

### 4. Where a thread runs

**Today.** `GET /threads/{id}` returns 30 fields, and none of them says where the thread runs. capy-acp looks for the thread's
worktree at `~/.capy/worktrees/<threadId>/<repo>`. Two recent changes make that weaker:

- Since 0.9.2 a user can choose another worktree folder (Settings, then Devices, then Worktree folder). capy-acp now reads
  the private worktree list in `~/.capy/device/workspaces.json` to find it, which is one more private file to depend on. The
  docs for the desktop app and the dock still say `~/.capy/worktrees`.
- Since 0.9.0 a thread can move to another device or to the cloud ("Continue on"). The API does not report the move, so a
  client can keep watching a folder that the thread left.

**Proposal.**

```json
"placement": {
  "kind": "device",
  "deviceId": "device_…",
  "workspace": { "kind": "linked" | "worktree", "root": "/home/me/app", "path": "/home/me/app" }
}
```

A stream frame when the placement changes would let a client follow a move.

### 5. Files on thread create

**Today.** `CreateThreadRequest.message` is a string. Files attach only to `POST /threads/{id}/message`. If a client sends
the files right after creating the thread (`delivery: "steer"`), a fast model can answer first. In a live test, Opus
answered "No image came through", then answered again when the image arrived.

**Cost.** capy-acp saves the files of a first prompt on the device and puts their paths in the text, so the agent reads them
from disk. This works only for device threads.

**Proposal.** The same `files` field as `SendMessageRequest`, on create.

### 6. Prices and input types on `GET /models`

**Today.** A model has `id`, `name`, `billing`, `route`, `reasoningModes`, `fast`, `pro` and `ultrafast`. It has no price, no
input types and no context window. The prices exist on the docs page "Models & pricing".

**Cost.** capy-acp downloads `docs.capy.ai/models-and-pricing.md` and parses its table (`src/pricing.ts`), so the picker can
say "Particle-1 · free" or "Inkling 2 Small · $0.30/$1.00 per 1M". If the table changes, the label falls back to
"Capy credits". capy-acp offers image prompts for every model, because it cannot tell which accept them.

**Proposal.**

```json
"pricing": { "inputPerMTok": 0.30, "cachedInputPerMTok": 0.03, "outputPerMTok": 1.00, "currency": "USD" },
"inputModalities": ["text", "image"],
"contextWindow": 1048576
```

`pricing` would be `null` for models on a subscription or the user's key.

### 7. Token usage on `turn end`

**Today.** The stream gives no usage. `Thread.usage` gives credits for the whole thread (llm, image, vm, total).
`GET /usage/series` gives token totals in hourly buckets that can still change. ACP's `usage_update` needs the tokens in
context and the context size, so capy-acp sends none. After each turn it reads `Thread.usage` and shows the credits that the
turn added, if any.

**Proposal.** `turn end` + `usage: {inputTokens, outputTokens, cacheReadTokens, contextTokens, contextWindow, credits}`.

## Small fixes

- **`null` where the schema says optional.** The message list sends `clientKey`, `editOf`, `sender`, `modelDefault`,
  `attachments` and `references` as `null`. The published `Message` schema marks them optional and not nullable, and the
  stream leaves them out. A client that decodes with the published schema fails on a whole page. capy-acp's `session/load`
  did, until it switched to decoding one field at a time.
- **An untagged error.** `GET /threads/{id}/messages?after=<bad cursor>` answers `400` with an empty body. The stream answers
  the same mistake with `capy/InvalidRequest "Invalid event cursor"`.
- **Tags for device errors.** "Device not found" and "This device does not link a folder at …" are both
  `capy/InvalidRequest`. Tags such as `capy/DeviceNotFound` and `capy/FolderNotLinked {root}` would let a client react
  without parsing the message. `capy/DeviceAccessDenied` exists on `POST /threads/{id}/message`, but not on thread create.
- **The credit unit is not documented.** The Capy app shows `totalCredits / 1000` as dollars. The API reference does not say
  so.
- **Undocumented fields.** `DeviceTarget` accepts `roots`, `base`, `repos`, `startFromOrigin` and `root` (worktree), with no
  description.
- **The interrupt receipt.** The reference gives its shape (`AdmitReceipt {id, deduped}`) but not what `id` names, or when
  `deduped` is true without a `clientKey`.
- **Worktree folder in the docs.** The desktop and dock pages still say `~/.capy/worktrees` (see ask 4).

## What I take to be intended

- The stream never gives the model's reasoning. The docs say so.
- Capy opens a pull request only when asked. No recording showed a commit or a PR without a request.
- There is no per-tool approval, so ACP permission requests have nothing to map to. capy-acp never asks the client for
  permission, and its README says so.
- The free-with-ads models are only for the app. They are not in the API's model list.
- Live fragments are small (1 to 38 characters, median 3 for Astra and 13 for Opus). The `dropped` turn outcome covers slow
  readers.

## Questions

1. An interrupt during a reply ends the turn with `outcome: "settled"`, not `aborted` (`fixtures/anthropic_claude-opus-5-5/s4-interrupt`).
   Is `settled` the intended outcome for an interrupt?
2. Is the `turn end aborted`, `run end` pair at the start of a new thread's stream a replay of something? (Ask 2.)
3. Since 0.9.0 a thread started in the app can clone a missing repository on the device. Does an API thread in worktree mode
   do the same, or does it still need a linked folder of the repository?
4. `SendMessageRequest.delivery` defaults to `interrupt`. Which delivery should a client use for a follow-up while the thread
   is still `waiting` on a background command, so that the command is not cancelled? `queue`?

## Reference

### Answers

| Question | Answer | Evidence |
| --- | --- | --- |
| Do device threads work through the API? | Yes. `device: {deviceId, workspace: {kind: "worktree"}}` creates a detached git worktree of the base branch from the remote, by default under `~/.capy/worktrees/<threadId>/<repo>`. | `fixtures/*/s1-write`, `*/s2-edit`, and the `.capy-managed.json` marker (`forkedFrom: "remote"`) |
| Must a `linked` root be a linked folder of the device? | Yes. Capy rejects other paths with `400 capy/InvalidRequest "This device does not link a folder at <path>"`. | Live, 2026-11-23 (the body was not saved as a fixture) |
| Does `linked` mode work? | Yes. The thread runs in the root (`pwd` is the root) and edits it in place, with no worktree. The frames are the same as in worktree mode. | `fixtures/anthropic_claude-opus-5-5/s2-edit-linked` |
| Can a client link a folder? | Not through the API. Folders are linked in the app (Scan a folder, or Settings, then Project folders) or with `capy dock dirs add`. | `openapi.json` |
| Must the repository be in a Capy project? | Yes. Thread create requires `projectId`. | `openapi.json` |
| Does a thread commit or open a PR without a request? | Not in any recording. All 3 models obeyed "do not commit, push, or open a PR". | `git status` after each run |
| What did the runs cost? | 0 credits (`usage.totalCredits = 0`) on connected subscriptions. | `fixtures/*/*/thread.json` |

### Model routes

`route` is `capy` (Capy credits), `org_credential` (an organization key), `member_credential` (the member's own key) or
`member_seat` (a connected subscription). capy-acp adds a price to the name of `capy` models only.

| Model id | Reasoning | Route in the recordings | Tool frames |
| --- | --- | --- | --- |
| `anthropic/claude-opus-5-5` | high | `member_seat` | `execute`, empty `text`, `calls` with `bash` and `write` |
| `openai/gpt-6.2-astra` | high | `member_seat` | `execute`, empty `text`, `calls` with `bash` and `apply_patch`. Sends a short message before its tools |
| `anthropic/claude-haiku-5-5` | low | `member_seat` | `bash` with a one-line summary, no `calls` |

### Recorded errors

| Case | Status | Body |
| --- | --- | --- |
| Unknown model | 400 | `{"_tag":"ModelSelection.Rejected","message":"Unknown model: nope/none","candidates":[]}` |
| Unknown project | 404 | `{"_tag":"capy/ProjectNotFound","projectId":…}` |
| Unknown device | 400 | `{"_tag":"capy/InvalidRequest","message":"Device not found"}` |
| Missing thread | 404 | `{"_tag":"capy/ThreadNotFound","threadId":…}` |
| Bad stream cursor | 400 | `{"_tag":"capy/InvalidRequest","message":"Invalid event cursor: …"}` |
| Bad key | 401 | `{"_tag":"capy/Unauthorized"}` |

No test caused `429 capy/RateLimited`, `503 capy/StreamUnavailable` or an `error` frame. The client follows the docs for
these, and the tests cover them with a fake transport.

### Stream facts

- A follow-up with `Last-Event-ID: <last transcript id>` starts at the new user entry and replays nothing (`s3-followup`).
- An interrupt during a reply (`s4-interrupt`): the fragments stop, then `turn end` (`settled`), `run end`, `status: idle`.
  Capy commits no assistant entry, so the partial reply exists only in the live frames.
- A thread whose model put a command in the background (Astra, `sleep 90`) ends the run with `status: waiting`. The docs say
  that it continues when the command finishes. An interrupt on a waiting thread cancelled the wake: no later entry appeared.
- The user entry commits after the first model turn ends. When the model starts with a tool, this is after the first
  `tool_call`.

## How this was tested

- **Recordings:** `fixtures/<model>/<scenario>/` (Opus 5.5, GPT-6.2 Astra, Haiku 5.5), on the desktop app 0.6.0 on Linux x64,
  2026-11-23. `spike/scrub-fixtures.ts` removed private data.
- **Live checks:** `capy dock` 0.7.2 on macOS 26 arm64 and Windows Server 2022, 2026-11-24. The desktop app 0.6.0 on Linux
  and the dock on Windows, 2026-11-25.
- **Clients:** T3 Code 0.1.12 and an ACP test client.
- **Current releases:** desktop 0.10.0 (2026-11-24) and `capy dock` 0.9.2. They were not run. A static check of both builds
  shows that the device files above are unchanged.
- **Re-check, 2026-11-25:** every claim in this file, against `openapi.json`, the docs pages and read-only API calls.

How the adapter works around each gap (diffs, sessions, reconnects, cancel) is in [design.md](design.md). The test
suite replays the recordings through a fake Capy client. If a change ships behind a flag, I can run it against the
recordings and the three test machines within a day.
