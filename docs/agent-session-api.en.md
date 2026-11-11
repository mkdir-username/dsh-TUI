# Session API (MCP)

`bin/dst-mcp.js` is a stdio MCP server that exposes the `dst session …` operations to any
agent (DSH, Claude Code, Codex): list, describe, tail, resume and fork **other** DSH
sessions without a TUI. Tool calls travel through the same CLI grammar and the same
official adapter, so commands and tools cannot drift in behaviour, exit codes or error codes.

## Install

```json
// ~/.mcp.json (merge into the existing document, never overwrite it)
{
  "mcpServers": {
    "dsh-sessions": {
      "command": "node",
      "args": ["/Users/username/Docs/dsh-tui-fork/bin/dst-mcp.js"]
    }
  }
}
```

DSH's `mcp-claude` plugin reads `~/.mcp.json` (`sources`) when it mounts, so the tools appear
as `mcp__dsh-sessions__*` after a TUI restart; Claude Code can take the same block in
`~/.claude.json`. `node` must be on PATH, or point `command` at an absolute node.

## Tools

| Tool | What it does | Limits |
| --- | --- | --- |
| `sessions_list` | Sessions of one cwd: `sessionId`, `kind` (root/fork/subagent), `ownerPid`, optional `title` | 50 rows by default, 200 max; `titles` reads every listed log |
| `session_status` | One session: title, cwd, kind, preset, event count, last event, whether a turn runs, holder pid | reads the full log |
| `session_tail` | Recent events: `seq`, `type`, `time`, text truncated to 500 characters, tool name | 20 rows by default, 200 max |
| `session_fork` | Copy up to the last completed turn into a new session with `parentSession` = source; the source log is untouched | a write; the child inherits the source `agentPreset` |
| `session_prompt` | Run one headless turn in an idle session and return its answer | `SESSION_OCCUPIED` when held; `SESSION_PRESET_UNSUPPORTED` with a preset |

## Not supported (by design)

- **Messaging a session that is working in a TUI**: there is no cross-process IPC or queue.
  `session_prompt` reads `~/.dsh-tui/session-mounts.json` first and refuses with
  `SESSION_OCCUPIED`; a damaged or unknown-version ledger is a refusal too
  (`SESSION_OCCUPIED_UNAVAILABLE`), never "free".
- **Sessions with an `agentPreset` cannot be resumed headlessly** (the headless profile does
  not compose those presets): `session_fork` them and continue in the TUI `/resume`.
- **Arbitrary cut points**: a fork always cuts at the last completed turn; a session without
  one returns `SESSION_FORK_UNAVAILABLE`.
- **MCP is not a sandbox**: tools run `dst` as the launching user, and `session_prompt` spends
  a real model turn.

## CLI equivalents

```sh
dst session list --json [--all] [--limit N] [--titles]
dst session status <id> --json
dst session tail <id> --json [--limit N]
dst session fork <id> --json [--title T]
dst run --session-id <id> "task"
```

Protocol frames, exit codes and version limits live in [Automation CLI](cli.en.md).
