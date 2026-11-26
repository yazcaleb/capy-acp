<img src="assets/icon.svg" width="64" height="64" alt="">

# Capy, from your tools

Three small packages that put [Capy](https://capy.ai) coding-agent threads where you already work. A community
project: Capy did not make it.

| Package | For | Start |
|---|---|---|
| [capy-acp](packages/acp#readme) | Editors that speak the Agent Client Protocol: T3 Code, Zed, JetBrains IDEs | `npx -y capy-acp --setup` |
| [capy-mcp-server](packages/mcp#readme) | Agents: Claude Code, Codex, Cursor, Grok Build, Grok Bot, Conductor | `claude mcp add capy -s user -- npx -y capy-mcp-server` |
| [capy-cli](packages/cli#readme) | Terminals, scripts and CI jobs | `npx -y capy-cli run "<task>"` |

They share one setup. `--setup` (or `capy-cli setup`) saves your Capy API key once for all three. On a computer without
a Capy device, it can install and pair Capy's headless [`capy dock`](https://docs.capy.ai/dock), and you approve the
pairing on capy.ai.

## Where a thread runs

| Mode | Where | Your folder | Machine time |
|---|---|---|---|
| Linked | Your folder, on this computer's Capy device | Edited in place | None |
| Worktree | A new git worktree on a Capy device: this computer, or another one with `CAPY_DEVICE_ID` | Not changed | None |
| Cloud | A Capy cloud machine, small to bigguy | Not changed | Capy credits |

The editor adapter uses linked mode by default. The MCP server and the CLI use a worktree by default, so Capy never
edits the folder that you or your agent work in. Nothing starts a cloud machine unless you ask for one.

## Docs

- [Capy API notes](docs/capy-api-notes.md): what we learned from building on the Capy public API, and the changes we ask for.
- [Design](docs/design.md): how the adapter maps Capy threads to ACP sessions.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build    # bundles packages/*/dist/bin.js
```

The shared code is in `packages/core`. It is bundled into each package, so each one installs with only its own
dependencies.

MIT license.
