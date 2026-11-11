# Upstream reference map

The files that carry the mechanisms reviewed on 2026-11-11 in the upstream
repository (`ccch1mneyyy/dsh-TUI`), pinned to commit
`de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3` (2026-11-10). Permalinks below point at
that commit, so they keep working as upstream moves on.

Line ranges were read from `git show de73c6f3:<path> | grep -n`, not from the
working tree: `src/sessionMounts.ts` and `docs/cli.en.md` differ between the pin
and this fork.

## Mechanism → file

| Mechanism | Path at pin | Lines | Permalink |
| --- | --- | --- | --- |
| Upstream retry policy (5 attempts, `STREAM_CLOSED`) | `src/dsh-adapter/channel/upstream-retry.ts` | 30-65 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/dsh-adapter/channel/upstream-retry.ts#L30-L65) |
| Codex reconnect: held events, replay, duplicate suppression | `src/backends/codex/session/session.ts` | 170-579 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/backends/codex/session/session.ts#L170-L579) |
| Codex rewind: conversation only | same file | 697-708 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/backends/codex/session/session.ts#L697-L708) |
| Cross-process session mount ledger | `src/sessionMounts.ts` | 1-25 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/sessionMounts.ts#L1-L25) |
| Backend capability contract | `src/agent/capabilities.ts` | 104-124, 269-271 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/agent/capabilities.ts#L104-L124) |
| Claude rewind: `files` mode | `src/backends/claude/session/store.ts` | 58-60 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/backends/claude/session/store.ts#L58-L60) |
| DSH rewind: fork a child session | `src/dsh-adapter/channel/session-rewind.ts` | 83-94 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/dsh-adapter/channel/session-rewind.ts#L83-L94) |
| Rewind picker: overlay-height window, 80-character preview | `src/components/RewindPicker.tsx` | 62-63, 180 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/components/RewindPicker.tsx#L62-L63) |
| Plugin decision guard: default deny, scope checks | `src/dsh-adapter/decision-guard.ts` | 3, 184, 213 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/src/dsh-adapter/decision-guard.ts#L3) |
| Automation CLI: `dst run`, output formats, known gaps | `docs/cli.en.md` | 11-15, 33-34, 79 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/docs/cli.en.md#L11-L15) |
| Roadmap staleness (updated 2026-09-07) | `docs/roadmap.en.md` | 61, 119 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/docs/roadmap.en.md#L119) |
| No TUI sandbox; Windows uses `danger-full-access` | `docs/architecture.en.md` | 246-259 | [link](https://github.com/ccch1mneyyy/dsh-TUI/blob/de73c6f3e5fa8c5b98b7fc87907395f5832c8aa3/docs/architecture.en.md#L246-L259) |

## How this fork differs at the pin

- Identical: `upstream-retry.ts`, `capabilities.ts`, `decision-guard.ts`,
  `codex/session/session.ts`.
- `src/sessionMounts.ts`: this fork adds a pid-start witness (`ps -o lstart`) so a
  recycled pid cannot keep a dead owner's claim alive.
- `cli/**` and `docs/cli.en.md`: this fork adds an MCP surface and the
  fork/mounts adapters.
- `src/components/RewindPicker.tsx`: this fork adds two-line checkpoints and a
  scrolled viewport; the 80-character preview is unchanged.

## Reproducing the pinned files

`.upstream/` is not shipped: the directory is ignored by git, because it would
duplicate these sources. Rebuild any file from the local object store:

```sh
git fetch origin
git show de73c6f3:src/dsh-adapter/channel/upstream-retry.ts > /tmp/upstream-retry.ts
```

A local snapshot of the whole reviewed set (25 files: six implementation files,
two documents, and the 17-file `cli/` tree) is kept at
`.upstream/de73c6f3/`, with an index at `.upstream/README.md`.

## Why code indexes skip it

Symbol indexes (`codegraph`, `serena`) respect `.gitignore` and therefore never
see `.upstream/`. That is intended: `capabilities.ts` exists both here and in
`src/agent/`, so indexing the snapshot would return two definitions for one
symbol and make call-graph answers unreliable. Read the snapshot by path, or use
`git show`.

## Refresh

When a new upstream commit becomes the reviewed pin: `git fetch origin`, rewrite
the snapshot from `git show <sha>:<path>`, recount the line ranges from that
commit, and update the tables above. Never recount from the working tree — the
fork diverges from the pin.
