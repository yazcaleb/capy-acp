# capy-acp design

How capy-acp turns a Capy thread into an ACP session, and the workarounds for what the Capy public API does not give.
[capy-api-notes.md](capy-api-notes.md) is the feedback for Capy. This file is the adapter's own documentation.

## Tool items


- Tool titles come from the `calls` list of the transcript, not from `tool_call.text`. Strong models leave `text` empty, so the
  live frame shows only "execute". capy-acp shows a pending call as "Running tools". When the transcript entry arrives, it changes
  the title, for example to "write, bash (1.6 s)".
- Read-only tools, search tools and fetch tools get the kinds `read`, `search` and `fetch`. Shell tools and write tools get the
  kind `other`. Capy gives no command and no path for an `execute` or `edit` item. Real `edit` items come from the diffs (see "File diffs").
- No paths, diffs or output come through the API. In linked mode, the device edits the folder that the client has open. So
  capy-acp compares that folder after each tool call.
- Each assistant `callId` is a separate reply. capy-acp streams the early Astra replies as chunks, with a blank line before each
  new reply.

## Model labels and credits

- `GET /models` gives each model's `route` but no price. capy-acp reads the price table of
  `https://docs.capy.ai/models-and-pricing.md` once for each process (3 s timeout; `CAPY_ACP_PRICING_URL` changes the URL,
  and an empty value turns it off). A model on Capy credits gets its price in its name, for example
  `Inkling 2 Small · $0.30/$1.00 per 1M`, or `Particle-1 · free`. A model with tiered prices shows its first tier, after
  "from". If the page or the model's row is missing, the name ends in `· Capy credits`. Models on a subscription or a key keep
  their names, and the option description names the subscription or key.
- After each turn, capy-acp reads `usage` from `GET /threads/{id}`. If the turn added credits, an ACP `notice` gives the
  amount and the thread total. A credit is a thousandth of a dollar: the Capy app shows `totalCredits / 1000` as USD. Capy
  can book a turn's credits late; they then show after the next turn. capy-acp sends no `usage_update`, because ACP requires
  token counts that Capy does not give for each turn, and T3 Code would show "0 tokens used".

## File diffs

The Capy stream gives the names of the inner tools of a call (`write`, `edit`, `bash`), but no paths or contents. The thread
works on this machine: in linked mode in the folder that the client has open, and in worktree mode in its own worktree (the Capy API does not say where a thread works).
So `src/changes.ts` finds the changes itself, and only reads.

- **Baseline.** When a prompt starts, before capy-acp sends the message, it records `HEAD` and the content of each changed or
  untracked file. It uses `git status --porcelain=v1 -z --untracked-files=all --no-renames`, without ignored files. Thus
  capy-acp never shows uncommitted user edits as Capy edits. If Capy later edits such a file, the diff starts from the user
  version. A new thread's worktree does not exist yet when the prompt starts. Capy makes it clean at the base commit, so when
  capy-acp first finds it, the baseline is its `HEAD`.
- **Collection.** capy-acp looks at the folder when a tool call starts while no other call runs, and when a call finishes. It
  examines files that are changed now, files that it saw before, and files in `HEAD..newHEAD` if Capy committed during the
  turn. It compares each file by SHA-256 with the last version that it saw, or with the blob at the last `HEAD`.
- **Old text.** For a clean file, the old text comes from `git cat-file --filters`, which applies the checkout conversions. Git
  for Windows checks text out with CRLF, and `.gitattributes` can set eol and smudge filters. Git also accepts an LF copy as
  clean under `core.autocrlf`. If only the line endings of the raw blob agree with the working file, capy-acp uses the raw blob.
  capy-acp sets `GIT_LFS_SKIP_SMUDGE=1`, so a diff never downloads LFS content.
- **Update.** capy-acp sends the changes as a `tool_call_update` on that call. The update has the kind `edit` (`delete` if all
  changes are deletions), a title with the file names, `content: [{type: "diff", path, oldText?, newText}]` and `locations`.
- **Attribution by time.** A call gets the changes that occurred while it ran. A change found when a call starts, after a
  read-only call (`read`, `search`, `fetch`, `think`), or after the last call occurred while no Capy call could write. It gets
  an item of its own with the kind `other` and the title `Edited … outside a Capy tool call`, so that T3 shows the title and
  not "Changed files". Such changes come from the user, or from a command that Capy left running in the background. An edit
  of the user while a call that can write runs is credited to that call: capy-acp sees files, not processes.
- **Last check.** At the end of the turn, a last check finds edits from a call that did not report its end, for example after
  an interrupt. Each call gets its changes one time, so ACP `content`, which replaces and does not append, never loses a diff.
- **Limits.** Binary files and files over 256 KiB get a location, but no diff. capy-acp compares files over 16 MiB by size and
  modification time. Symlinks show as their target path, as git stores them. capy-acp tracks a maximum of 500 files in a turn.
  If tracking fails (no git repository, a git timeout), capy-acp writes the error to stderr and shows no diffs for that turn.
  The prompt does not fail.
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
  `files` to the message. For the first prompt of a new thread, capy-acp saves the files locally (thread create takes no files).
- **Delivered files** (`attachments` on assistant entries) become `resource_link` chunks. The link is `file://` if
  `sourcePath` exists on this machine. Otherwise it is the presigned download URL from
  `GET /threads/{id}/attachments/{fileId}/download`. On Windows, `sourcePath` has the form `C:/Users/…`, with forward slashes.
- **Subagents.** The `task` frames of the stream (or `subagent` frames with `frames=subagent`) become one tool call for each
  subagent, with its path as the title. `draft` is pending. `working` and `waiting` are in progress. `done` is completed.
  `failed` is failed. `idle` means "at rest". A new subagent sends `idle` first, before it starts (seen live). So `idle` is
  pending until the subagent was seen running, and completed after that. A parent that waits for its subagent ends its run as
  `waiting`. The later subagent frames and the answer of the parent come in the next run, and capy-acp follows that run in the
  same prompt. After a run ends, the stream does not replay `task` frames.
- **Cancel.** After the interrupt, Capy commits the stopped call as a normal tool entry, without a status (a tool entry has no status). In every
  cancelled test turn (Opus 5.5 on Linux, macOS and Windows), the stopped `execute` entry had no `calls` list, and each
  finished one had it. So capy-acp shows an `execute` entry without `calls` as failed, with the title "Stopped tool call", and
  all others as completed. For an entry that names its tool directly (Haiku), the outcome after a cancel is unknown, and
  capy-acp shows it as failed. `session/load` uses the same rule.
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
  and answers the first prompt with the setup problem and its fix. A missing API key is the exception. T3's provider check
  opens a session, and it shows the agent as signed out only when `session/new` fails with `auth_required` (-32000).
  Otherwise it shows the agent as ready. So without a key, `session/new` fails with `auth_required`, and T3 offers the
  terminal auth method (`--setup`).
- T3 shows ACP kinds strictly. `execute` becomes "Ran command", with `rawInput.command` or a title in backticks as the command
  line. `edit`, `delete` and `move` become "Changed files", with a patch from the `diff` content. All other kinds become one
  line with the title. Capy gives no command text. So capy-acp never sends `execute` (this prevents an empty `$ ` or an invented
  command), and it sends `edit` only with real diffs. Changes outside a Capy tool call get the kind `other`, so T3 shows their
  title, which says where they came from.
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

On Linux x64 with the desktop app 0.6.0 and an ACP test client, and on Windows with `capy dock` 0.7.2, 2026-11-25:

| Check | Result |
| --- | --- |
| Opus 5.5: `echo first`, then a long loop, cancel during the loop | The first call stayed `completed`, and the stopped call became `failed`. A second run, in which Opus ran both commands in one call, showed that call as `failed`, "Stopped tool call" |
| The harness edited README.md 1 s after the prompt, before the first Capy call | An item "Edited README.md outside a Capy tool call" came before the first call, which showed no diff |
| Worktree mode: a new file and an edit | "Edited README.md and notes/WORKTREE.md" with paths in `~/.capy/worktrees/<thread>/capy-acp-sandbox`. The open folder did not change |
| Worktree mode on Windows | "Created notes/WORKTREE.md" with a path in `C:\Users\…\.capy\worktrees\<thread>\capy-acp-sandbox` |
| Capy delivered a file (desktop app) | `file:///tmp/capy-acp-deliver/hello.txt`, `text/plain`, 20 B |
| One subagent on the same machine (desktop app) | Pending, in progress, completed. The answer, 187 bytes, matched `wc -c` |
| Haiku 5.5: the same cancel check | Capy put the loop in the background, so both calls finished before the cancel. Haiku entries have no `calls` list (a tool entry has no status) |

The unit tests pass on Linux, macOS 26 and Windows Server 2022.

These live checks found bugs. Each fix has a regression test:

- **The follow-up replayed the previous reply.** Capy commits the final assistant entry after `status: idle`. The turn ended on
  `idle`, so the resume cursor was one entry short. Now the turn ends when all streamed replies are committed, or when the
  stream closes and `GET /threads/{id}` shows idle (for an interrupted reply that Capy never commits).
- **A reply without streamed fragments was lost.** After a `session/load`, the reply committed after `idle`, and the turn had
  already ended on `idle`. Now capy-acp reads an `until=run` connection until the server closes it (`done` follows the last
  entries). A grace time of 10 s, checked on each frame, limits the wait (heartbeats come every 15 s).
- **`session/load` failed on `null` fields in the message list** (null fields in the message list). Now capy-acp decodes transcript entries one field at
  a time. Only `id` and `source` are strict, and capy-acp skips an entry that it cannot read, so the page does not fail.
- **The first turn after a load showed a reply again that the load had replayed.** Now the load moves the saved cursor to the
  newest replayed user or assistant entry, because the id of that entry is its event id.
- **capy-acp found no device on a machine paired with `capy dock`.** It now reads `~/.capy/dock/status.json` when the desktop
  app file is missing.
- **A new subagent showed as completed first**, and **a cancelled call showed as completed**. See "Subagents" and "Cancel".
- **Windows:** parallel session saves failed with `EPERM`, delivered files got the download URL instead of the local path, and
  diffs marked all lines as changed because of CRLF line endings.
- **macOS:** git resolves symlinks in the root that it prints, so a folder outside the local list went to Capy as
  `/private/tmp/…`. Now capy-acp sends the spelling of the opened folder (found by the unit tests on macOS).
