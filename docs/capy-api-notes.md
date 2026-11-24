# Capy API notes

This file records what the work on capy-acp showed about the Capy public API, and the design decisions that followed. All
observations are from November 2026, against `https://api.capy.ai/api/v1`. The first device was the Capy desktop app 0.6.0 on
Linux x64, and the client was T3 Code nightly 0.1.12. Later checks used `capy dock` 0.7.2 on macOS and Windows. The recorded
streams are in `fixtures/<model>/<scenario>/`. `spike/scrub-fixtures.ts` removed private data from them.

## Answers

| Question | Answer | Evidence |
| --- | --- | --- |
| Do device threads work through the API? | Yes. `device: {deviceId, workspace: {kind: "worktree"}}` creates a detached git worktree at `origin/<base>`, under `~/.capy/worktrees/<threadId>/<repo>`. Capy makes it from the `.git` folder of the linked folder. | All `fixtures/*/s*` |
| Must a `linked` root be a linked folder of the device? | Yes. Capy rejects any other path with `400 capy/InvalidRequest "This device does not link a folder at <path>"`. | Recorded error |
| Does `linked` mode work? | Yes. If the folder is linked, `{kind: "linked", root}` runs in that folder (`pwd` is the root). Capy edits the files in place and creates no worktree. The stream has the same frames as in worktree mode. | `fixtures/anthropic_claude-opus-5-5/s2-edit-linked` |
| Can a client link a folder without the app UI? | Not through a public API. `~/.capy/device/workspaces.json` is a cache. The app writes it again from server state, so manual edits do not stay. Deep links (`capy://app/<route>`) only open screens in the app. You link folders in the Capy UI, or with `capy dock dirs add`. | Observed |
| Must the repository be in a Capy project? | Yes. Thread create requires `projectId`. A linked folder lists its `repos`. Capy makes the worktree from the base branch of the project repository. | Create schema |
| Does a thread commit or open a PR without a request? | No recording showed this. All 3 models obeyed "do not commit, push, or open a PR". Each worktree stayed at the base commit, with uncommitted changes. The docs say that Capy opens a PR only on request. No API flag controls this. | `git status` after each run |
| Does the stream show edits and shell commands? | It depends on the model (see below). No frame gives a path, a diff, a command or command output. | `s2-edit` |
| How does Capy report errors? | Before the stream starts, as tagged JSON bodies. After the stream starts, as `error` frames. See "Errors". | `fixtures/errors/` |
| What did the runs cost? | 0 Capy credits for all recorded runs (`usage.totalCredits = 0`). Device threads have no machine charge, and these models used connected subscriptions. | `thread.json` |

## Models and billing (`GET /models`)

Each model has a `route` and a `billing` label. A model on a `member_seat` or `member_credential` route uses the subscription of
the member. A model on the `capy` route uses Capy credits. capy-acp lists all models in the model picker of the session. It adds
"(Capy credits)" to the label of each `capy` route model.

| Model id | Reasoning level | `route` | Use in the recordings |
| --- | --- | --- | --- |
| `anthropic/claude-opus-5-5` | high | `member_seat` | Baseline for the translator |
| `openai/gpt-6.2-astra` | high | `member_seat` | Second provider |
| `anthropic/claude-haiku-5-5` | low | `member_seat` | Smoke test |

## Event stream

The scenarios are:

- `s1-write`: write one file, then run `git status`.
- `s2-edit`: read the README, edit two files, then run `git status` and `git diff --stat`.
- `s3-followup`: send a message, then resume the stream with `Last-Event-ID`.
- `s4-interrupt`: interrupt a reply.

### Provider differences

| | Haiku 5.5 | Opus 5.5 | GPT-6.2 Astra |
| --- | --- | --- | --- |
| Tool frames | `tool_call.name = "bash"`, with a one-line summary in `text` | `name = "execute"`, with `text: ""` | `name = "execute"`, with `text: ""` |
| Data in the transcript entry | `tool: "bash"`, and the same summary | `calls: [{tool: "bash"\|"write", durationMs}]` | `calls: [{tool: "bash"\|"apply_patch", durationMs}]` |
| Edit tool name | (edits with bash) | `write` | `apply_patch` |
| callId prefix | `toolu_` | `toolu_` | `call_` |
| Replies | One final reply | One final reply | A short "I'll check…" message before the tools, then the final reply. One run has more than one `assistant` transcript entry |
| Reasoning frames | none | none | none (the docs say that the stream never gives reasoning) |

These differences have the following results in capy-acp:

- Tool titles come from the `calls` list of the transcript, not from `tool_call.text`. Strong models leave `text` empty, so the
  live frame shows only "execute". capy-acp shows a pending call as "Working…". When the transcript entry arrives, it changes the
  title, for example to "bash, write (1.6 s)".
- Read-only tools, search tools and fetch tools get the kinds `read`, `search` and `fetch`. Shell tools and write tools get the
  kind `other`. Capy gives no command and no path for an `execute` or `edit` item. Real `edit` items come from the diffs (see
  "File diffs in linked mode").
- No paths, diffs or output come through the API. In linked mode, the device edits the folder that the client has open. So
  capy-acp compares that folder after each tool call.
- Each assistant `callId` is a separate message. The early Astra messages are real reply text, and capy-acp streams them as
  chunks.

### Frame order (all models)

- A new stream starts with `status`. Frequently, extra frames follow: `turn start`, `turn end (aborted)`, `run end`, `run
  start`. These run frames are not reliable. The Astra s1 and s2 streams have no `run start`. In the Opus interrupt stream,
  `run start` comes after the reply fragments. For this reason, capy-acp controls the ACP turn from `status` and `transcript`
  frames, not from `run` and `turn` frames.
- Capy commits the `transcript` entry for the user message after the first `tool_call` of the run.
- `assistant` fragments have 1 to 15 characters. For one `callId`, the committed `transcript` text is equal to the joined
  fragments.
- A stream opened with `until=run` closes with `done` after the run ends. It did not close on the extra early `run end`.

### Thread status

- `idle`, then `working`, then `idle`: a normal turn.
- `waiting`: Astra ran `sleep 90`. Capy put the command in the background, ended the run, and set the thread to `waiting`. When
  the command finished, the thread continued without a new message. capy-acp keeps the prompt open while the thread is
  `waiting`, for up to `CAPY_ACP_WAITING_LIMIT_MS` (10 minutes by default). Then it ends the turn with a note that Capy
  continues in the thread.
- `failed`: capy-acp ends the turn with a note. The thread keeps its transcript.

### Follow-ups and resume

`POST /threads/{id}/message` returns `{id, deduped}`. A `/stream` request with `Last-Event-ID: <last transcript id>` replays
no old events. It starts at the new user entry (`s3-followup`). capy-acp sends a new `clientKey` for each prompt, so a retry
of one prompt does not create a second message.

### Interrupt

`POST /threads/{id}/interrupt` returns `200 {"id": "<26-char id>", "deduped": false}`. The docs do not describe this receipt.
The recording `anthropic_claude-opus-5-5/s4-interrupt` shows an interrupt during a reply:

1. The fragments stop.
2. `turn end` arrives with `outcome: "settled"`, not `aborted`.
3. `run end` arrives.
4. `status: idle` arrives.

Capy commits no assistant transcript entry, so the partial reply exists only in the live frames. On a `waiting` thread, an
interrupt cancels the pending wake and sets `idle`. For ACP `session/cancel`, capy-acp sends an interrupt. When the thread
settles, the prompt ends with `stopReason: "cancelled"`.

## Errors (recorded)

| Case | Status | Body |
| --- | --- | --- |
| Unknown model | 400 | `{"_tag":"ModelSelection.Rejected","message":"Unknown model: nope/none","candidates":[]}` |
| Unknown project | 404 | `{"_tag":"capy/ProjectNotFound","projectId":…}` |
| Unknown device | 400 | `{"_tag":"capy/InvalidRequest","message":"Device not found"}` |
| Root that is not linked | 400 | `{"_tag":"capy/InvalidRequest","message":"This device does not link a folder at …"}` |
| Missing thread | 404 | `{"_tag":"capy/ThreadNotFound","threadId":…}` |
| Bad resume cursor | 400 | `{"_tag":"capy/InvalidRequest","message":"Invalid event cursor: …"}` |
| Bad key | 401 | `{"_tag":"capy/Unauthorized"}` |

No live test caused `429 capy/RateLimited` (with `retryAfterSeconds` and `retry-after`), `503 capy/StreamUnavailable`, or
`error` frames in the stream. The client follows the docs for these cases. Tests cover them with a fake transport.

## Linked and unlinked folders

When the client opens a folder (the ACP `cwd`), capy-acp does one of these things:

1. **The folder is linked.** Its git root is a root in `~/.capy/device/workspaces.json`. The desktop app and `capy dock` both
   keep this file, and capy-acp only reads it. capy-acp uses `{kind: "linked", root}`, so Capy edits the open folder in place,
   as a local agent does. With `CAPY_ACP_WORKSPACE=worktree`, capy-acp uses a new worktree.
2. **The folder is a clone of a project repository, but it is not linked.** Worktree mode also needs a linked folder of that
   repository on the device. With `CAPY_ACP_ALLOW_WORKTREE_FALLBACK=1`, capy-acp uses a worktree of that folder. The first reply
   says that the edits go to `~/.capy/worktrees/…`, not to the open folder.
3. **The device has no linked folder for the repository.** capy-acp opens the session, because T3 Code does not show
   `session/new` error messages. The first reply tells you how to fix the problem: link the folder in Capy, then send the
   message again. Each prompt checks the setup again, so a link during a session works without a new session. The local folder
   list can be older than the server state. If Capy then answers `400 "This device does not link a folder at …"`, the reply
   gives the same fix.

Users of an editor expect the agent to edit the folder that they opened. Edits in a hidden worktree look as if the agent did
nothing. capy-acp cannot link folders, because Capy has no public endpoint for it.

## Capy API gaps (feedback)

1. **No public endpoint lists devices or links a device folder.** Integrations must read local Capy files to find the device id
   and the linked folders. `GET /devices`, `GET /devices/{id}/folders` and an endpoint to link a folder would remove this
   dependency. The two ways to pair a machine also keep the device id in different files. The desktop app uses
   `device-ids.json` in its Electron config folder. `capy dock` uses `~/.capy/dock/status.json`.
2. **A thread does not show where it runs.** `GET /threads/{id}` gives no device, workspace kind or worktree path. Integrations
   must guess `~/.capy/worktrees/<threadId>`.
3. **Tool frames from strong models are empty.** An `execute` frame with `text: ""` does not have the one-line summary that
   `bash` frames have. The `calls` list could give a summary for each inner call.
4. **Tool frames have no paths, diffs or exit codes.** A `paths: []` field on each write or patch call would let editors show
   the changed files. In linked mode, capy-acp compares the folder after each call. This cannot work in worktree mode, and it
   cannot give exit codes or command output.
5. **Run and turn frames are not reliable at the start of a stream.** Examples are an extra `aborted` turn, a missing
   `run start`, and a `run start` after content.
6. **The docs do not describe the interrupt receipt** (`{id, deduped}`).
7. **"Device not found" has the tag `capy/InvalidRequest`.** A `capy/DeviceNotFound` or `DeviceOffline` tag would let clients
   react to it.
8. **Fragments are small.** Each `assistant` frame has 1 to 15 characters, so a reply needs many frames. If the server joined
   fragments, slow readers would have less work.
9. **Capy commits transcript entries in a batch at the end of the turn**, and this includes the user message. Usually the
   commit comes about 70 ms after `idle`. One follow-up committed its reply 9 s after the text stream finished. A client needs
   the commit to get the resume cursor (otherwise the next turn replays the reply). So the client must wait, and its spinner
   continues after the text is complete. When the live fragments of a turn are lost, `idle` arrives before any reply text, and
   the reply commits after `idle`. Only the `done` frame of an `until=run` stream tells that all entries of the run are
   committed.
10. **Thread create accepts no files.** `CreateThreadRequest.message` is a plain string without `files`, so a first message
    cannot include a screenshot. Files in a second message (`delivery: "steer"`) race the first step of the agent. In a live
    test, Opus answered "No image came through", then answered again when the files arrived. capy-acp saves the files of a first
    prompt on the device and gives their paths. The agent reads them with `read`. A `files` field on create would fix this.
11. **The message list does not tell a client its position.** The last page returns `cursor: null`. After a restart, a client
    has no event id to resume the stream from, and the ids of tool entries are not event ids. capy-acp saves the stream cursor
    each time that it moves. A `latestEventId` field on the page, or on `GET /threads/{id}`, would make this unnecessary.
12. **The message list and the stream encode missing fields differently.** The list sends `clientKey: null`, `callId: null`
    and others, where the stream leaves the fields out. Also, `calls[].durationMs` can be the string `"Infinity"`. A strict
    decoder that matches the stream frames rejects complete list pages.
13. **`GET /models` gives no modalities.** Clients cannot know which models accept images. So capy-acp announces image prompts
    for all models.
14. **The stream gives no reasoning, plan or usage.** The docs say so ("never the model's internal reasoning"). ACP
    `agent_thought_chunk`, `plan` and usage updates have no data. A token count for each turn on `turn end` would be sufficient
    for usage.
15. **The error for a root that is not linked does not list the linked folders.** A path that is almost correct, such as a
    sibling clone or a symlink, is then difficult to find.

## File diffs in linked mode

The Capy stream gives the names of the inner tools of a call (`write`, `edit`, `bash`), but no paths or contents. In linked
mode, Capy edits the folder that the client has open. So `src/changes.ts` finds the changes itself, and only reads.

- **Baseline.** When a prompt starts, before capy-acp sends the message, it records `HEAD` and the content of each changed or
  untracked file. It uses `git status --porcelain=v1 -z --untracked-files=all --no-renames`, without ignored files. Thus
  capy-acp never shows uncommitted user edits as Capy edits. If Capy later edits such a file, the diff starts from the user
  version.
- **Collection.** After each tool call completes, capy-acp examines files that are changed now, files that it saw before, and
  files in `HEAD..newHEAD` if Capy committed during the turn. It compares each file by SHA-256 with the last version that it
  saw, or with the blob at the last `HEAD`.
- **Old text.** For a clean file, the old text comes from `git cat-file --filters`, which applies the checkout conversions. Git
  for Windows checks text out with CRLF, and `.gitattributes` can set eol and smudge filters. Git also accepts an LF copy as
  clean under `core.autocrlf`. If only the line endings of the raw blob agree with the working file, capy-acp uses the raw blob.
  capy-acp sets `GIT_LFS_SKIP_SMUDGE=1`, so a diff never downloads LFS content.
- **Update.** capy-acp sends the changes as a `tool_call_update` on that call. The update has the kind `edit` (`delete` if all
  changes are deletions), a title with the file names, `content: [{type: "diff", path, oldText?, newText}]` and `locations`.
- **Limits.** Binary files and files over 256 KiB get a location, but no diff. capy-acp compares files over 16 MiB by size and
  modification time. Symlinks show as their target path, as git stores them. capy-acp tracks a maximum of 500 files in a turn.
- **Last check.** At the end of the turn, a last check finds edits from a call that did not report its end, for example after
  an interrupt. These edits join the diffs of the latest call, because ACP `content` replaces and does not append. If there was
  no call, they get their own tool call.
- **Attribution by time.** capy-acp gives each change to the call that ran at that time. This includes edits that the user
  makes in the same folder during a turn. If tracking fails (no git repository, a git timeout), capy-acp writes the error to
  stderr and shows no diffs for that turn. The prompt does not fail.
- A rename shows as a deletion and an addition. capy-acp does not show changes of the file mode only (`chmod +x`).

## Sessions, media and subagents

- **Sessions.** When a thread exists, capy-acp saves the session to `~/.local/state/capy-acp/sessions/<sessionId>.json` (mode
  0600, folder mode 0700). The record has the thread id, the stream cursor, the model, the reasoning level, the title and the
  folder. capy-acp saves the cursor each time that it moves, so a crash during a turn loses nothing. There is one file for each
  session, because T3 Code runs one adapter process for each thread. Each write goes to its own temporary file, and a rename
  puts the file in place. Saves of one session run one at a time, because Windows refuses a rename onto a file that another
  rename replaces. capy-acp uses a session id as a file name only if it has the form `[A-Za-z0-9_-]`.
- **`session/load`** replays `GET /threads/{id}/messages` as `user_message_chunk`, `agent_message_chunk` and completed
  `tool_call` updates, with files as links. Then it answers. **`session/resume`** restores the same state without a replay. A
  session id with no record (a session that sent no prompt) opens empty. A saved session keeps its own folder, also if the
  client opens it from a different folder, because the thread works where Capy created it.
- T3 Code 0.1.12 uses `session/load` if `loadSession` is true, and otherwise `session/resume`. Without
  `promptCapabilities.image`, T3 Code refuses all image attachments ("ACP driver did not negotiate image prompt support").
- **Prompt media.** ACP `image`, `audio` and binary `resource` blocks become files. The name comes from the URI of the block,
  or else it is `image-1.png` and similar. capy-acp skips empty blocks. It gives the names of files over the Capy limit of 250
  MB in the text. Saved names do not keep characters that Windows forbids, because a `:` would write an NTFS alternate data
  stream. Follow-ups upload files through `POST /files` and presigned PUT requests (without an auth header), and attach
  `files` to the message. For the first prompt of a new thread, capy-acp saves the files locally (gap 10).
- **Delivered files** (`attachments` on assistant entries) become `resource_link` chunks. The link is `file://` if
  `sourcePath` exists on this machine. Otherwise it is the presigned download URL from
  `GET /threads/{id}/attachments/{fileId}/download`. On Windows, `sourcePath` has the form `C:/Users/…`, with forward slashes.
- **Subagents.** The `task` frames of the stream (or `subagent` frames with `frames=subagent`) become one tool call for each
  subagent, with its path as the title. `draft` is pending. `working` and `waiting` are in progress. `done` is completed.
  `failed` is failed. `idle` means "at rest". A new subagent sends `idle` first, before it starts (seen live). So `idle` is
  pending until the subagent was seen running, and completed after that. A parent that waits for its subagent ends its run as
  `waiting`. The later subagent frames and the answer of the parent come in the next run, and capy-acp follows that run in the
  same prompt. After a run ends, the stream does not replay `task` frames.
- **Cancel.** After the interrupt, Capy commits the stopped call as a normal tool entry, without a status. capy-acp shows a
  call that closes after a cancel as failed.
- **Windows shell.** On Windows, Capy uses Git Bash. In one test, Capy wrote a file named `NUL` with a redirect in cmd style.
  The diffs showed it as an added file.

## Connection failures

- If a stream drops during a turn, capy-acp connects again with `Last-Event-ID` from the last committed entry. The delay starts
  at 0.5 s and doubles to a maximum of 30 s. After 12 failures in sequence, the turn ends with a note that the connection was
  lost. Capy keeps the message and continues to work. The next prompt streams from the point where the reply stopped.
- If a stream closes again and again with no new events while the thread is busy, capy-acp waits before it opens the stream
  again (up to 4 s). It never opens the stream in a tight loop.
- If Capy rejects a cursor, capy-acp drops the cursor and reads without it.
- If a failure occurs before Capy accepted the message, the reply says that nothing was sent. So it is safe to send again.

## T3 Code findings (feedback for T3, not Capy)

- **T3 adds host instructions to prompts.** They describe tools that only T3 has (`delegate_task`, `preview_*`, PR linking),
  which the Capy agent does not have. `src/prompt.ts` handles the three forms that the tests saw (`test/prompt.test.ts`):
  1. A message typed in T3: `<t3_code_instructions>…</t3_code_instructions><user_request>…</user_request>`, then
     `<runtime_info>` and `<pull_request_linking>` blocks.
  2. A message from another agent to a running session: `[T3 Code: the agent in T3 thread "…" sent this message, not the
     user.]`, an empty line, and the request. On the first prompt of a session, the same blocks follow, without a
     `<user_request>` wrapper.
  3. An agent that starts a thread: form 1, with the attribution line in `<user_request>`.

  capy-acp sends only the request. `CAPY_ACP_FORWARD_HOST_INSTRUCTIONS=1` sends all of the text.
- **`session/new` errors lose their message.** T3 shows only "Provider session failed to open". So capy-acp opens the session,
  and answers the first prompt with the setup problem and its fix.
- T3 shows ACP kinds strictly. `execute` becomes "Ran command", with `rawInput.command` or a title in backticks as the command
  line. `edit`, `delete` and `move` become "Changed files", with a patch from the `diff` content. All other kinds become one
  line with the title. Capy gives no command text. So capy-acp never sends `execute` (this prevents an empty `$ ` or an invented
  command), and it sends `edit` only with real diffs.
- The T3 checkpoint at the end of a turn was `[]` on the first run of a thread, and listed the files on the second run. The
  diffs from capy-acp were correct on both runs.
- The model picker shows `default` until a session reports `configOptions`. capy-acp sends the Capy model list with each
  `session/new`.

## End-to-end checks

On Linux, 2026-11-23:

| Check | Result |
| --- | --- |
| ACP test client (`spike/acp-client.ts`), Opus 5.5: prompt with tool use, then a follow-up | The reply streamed. The `tool_call` went from in progress to completed ("bash (2.5 s)"). The follow-up used the same thread. Both prompts ended with `end_turn` |
| Same client, GPT-6.2 Astra, `session/cancel` after 15 s | capy-acp sent a Capy interrupt. `stopReason: cancelled` came about 2 s later |
| Test client, Opus 5.5, linked folder | Capy wrote a file in the open folder. The follow-up ended with `end_turn`, without a replay. No commit |
| Test client: folder not linked at session start, linked between prompts, then an edit of two files, then a delete | Prompt 1 got the fix as its answer. Prompt 2 found the setup on the retry, and showed an `edit` item "Edited README.md and docs/USAGE.md" with both diffs. Prompt 3: an `rm` in bash showed as the kind `delete` |
| T3 Code thread, linked sandbox, Opus 5.5 | Turn 1: `bash (2.6 s)`, then **Changed files** with unified diffs. Turn 2 (`git mv` rename): README modified, greet.sh added, hello.sh deleted |
| T3 interrupt during a `sleep` loop | The tool item showed `interrupted` 4 s after the request, and the run showed `interrupted` 2 s later. The Capy thread was idle |
| Test client: an image on the first prompt and another image on the follow-up | Prompt 1: `read (749 ms)` of the saved copy, "It's a blue square on a white background." Prompt 2 (upload through the API): "Red, yellow, purple." |
| Test client: a new process resumes the session, and another process loads it | Resume: no replay, and the follow-up continued the same thread. Load: a replay of both prompts, the read tool, the uploaded image (as a link) and all replies, then two follow-ups on the same thread |
| T3 thread with an image, adapter process stopped, then a follow-up | T3 started a new adapter process and restored the session. The follow-up answered on the same Capy thread, with no duplicate items |

On macOS 26 arm64 and Windows Server 2022 x64 with `capy dock` 0.7.2 and an ACP test client, 2026-11-24:

| Check | macOS | Windows |
| --- | --- | --- |
| Prompt with a tool, then a follow-up | `Darwin arm64`, same thread | `win32x64`, same thread |
| Cancel during a long command | `cancelled`, stopped call shown as failed | `cancelled`, stopped call shown as failed |
| A proxy cut the stream during a tool call | Connected again, tool completed one time, reply shown one time | Same as macOS |
| Capy delivered a file | `file:///tmp/…/hello.txt` | `file:///C:/Users/…/hello.txt` |
| One subagent on the same machine | Pending, in progress, completed | Same as macOS |
| Edit in linked mode | Not run | Diffs with Windows paths, CRLF line endings kept |

These live checks found bugs. Each fix has a regression test:

- **The follow-up replayed the previous reply.** Capy commits the final assistant entry after `status: idle`. The turn ended on
  `idle`, so the resume cursor was one entry short. Now the turn ends when all streamed replies are committed, or when the
  stream closes and `GET /threads/{id}` shows idle (for an interrupted reply that Capy never commits).
- **A reply without streamed fragments was lost.** After a `session/load`, the reply committed after `idle`, and the turn had
  already ended on `idle`. Now capy-acp reads an `until=run` connection until the server closes it (`done` follows the last
  entries). A grace time of 10 s, checked on each frame, limits the wait (heartbeats come every 15 s).
- **`session/load` failed on `null` fields in the message list** (gap 12). Now capy-acp decodes transcript entries one field at
  a time. Only `id` and `source` are strict, and capy-acp skips an entry that it cannot read, so the page does not fail.
- **The first turn after a load showed a reply again that the load had replayed.** Now the load moves the saved cursor to the
  newest replayed user or assistant entry, because the id of that entry is its event id.
- **capy-acp found no device on a machine paired with `capy dock`.** It now reads `~/.capy/dock/status.json` when the desktop
  app file is missing.
- **A new subagent showed as completed first**, and **a cancelled call showed as completed**. See "Subagents" and "Cancel".
- **Windows:** parallel session saves failed with `EPERM`, delivered files got the download URL instead of the local path, and
  diffs marked all lines as changed because of CRLF line endings.
