# Agent navigation: user phrases → sources

## Principle

A phrase like "исходники claude cli" names a reference that may live outside this
tree. Resolve the reference first, then search. This file routes phrases; it does
not restate the repository map ([docs/contributing.en.md](contributing.en.md)) or the
pinned upstream table ([docs/references.en.md](references.en.md)).

<boundaries>

| Question in the ask | Read |
| --- | --- |
| Where does code live in this repo? | [docs/contributing.en.md](contributing.en.md) (repository map) |
| What did upstream dsh-TUI do, at which pin, on which lines? | [docs/references.en.md](references.en.md) |
| How does this repo drive Claude Code? | [docs/claude-backend.en.md](claude-backend.en.md) |
| What does the user mean by "claude", "reference-map", "исходники"? | this file |

</boundaries>

<routing>

| The ask | Resolves to | First read |
| --- | --- | --- |
| "исходники claude cli", "исходники Claude Code", "claude cli source", "source of the claude cli" | Sources of Claude Code, which are not in this repo | the local snapshot whose path is recorded in `LOCAL-FORK-NOTES.md`; the adapter here is `src/backends/claude/` |
| "reference-map", "refference-map", "референс-мап", "рефференс-мап", "reference map" | The pinned upstream dsh-TUI map — not Claude, not a symbol index | [docs/references.en.md](references.en.md), local copy `.upstream/README.md` |
| "посмотри как устроено в claude", "как в claude code", "how does claude do X" | Behaviour of Claude Code, unless the ask names a layer | the layer table below |

</routing>

## Claude Code sources: what exists on this machine

- **Readable sources**: a local snapshot of the Claude Code CLI tree (`cli/`,
  `ink/`, `components/`, `bridge/`, `commands/`, `hooks/`, `main.tsx`) lives
  outside this repository. Its exact path is in `LOCAL-FORK-NOTES.md`, which is
  gitignored. Snapshot commits are dated 2026-03-31, while the installed CLI is
  newer: read it for shape and naming, not as the behaviour of the version under
  `~/.local/share/claude/versions`.
- **Installed executable**: `~/.local/bin/claude` is a symlink into
  `~/.local/share/claude/versions/<version>`, a native executable, not sources.
  `claude --version` reports which one is current.
- **SDK**: `@anthropic-ai/claude-agent-sdk` is an optional peer. When installed it
  brings the running platform's native CLI bundle through its optional
  dependencies (roughly 230 MB unpacked); the profile keeps one platform bundle.
  This repo spawns the real CLI when it can find one and uses the SDK bundle as
  the last fallback — the resolution order is documented in
  [docs/claude-backend.en.md](claude-backend.en.md) and implemented in
  `src/backends/claude/process.ts`.
- **This repo's integration**: `src/backends/claude/` — `backend.ts` (entry),
  `process.ts` (child process), `translate/` (events), `session/` (store and
  lifecycle), `permissions.ts`, `dialogs.ts`.
- **Transcripts**: `~/.claude/projects/<munged-cwd>/<session>.jsonl`. Discovery is
  in `src/dsh-adapter/migrate/adapters/claude-code.ts`; the line format is parsed
  by the pure `claude-code.parse.ts`. Imported-history semantics are described in
  [docs/migrate.en.md](migrate.en.md).

## Upstream pin map

[docs/references.en.md](references.en.md) is the single source for the pin hash,
the mechanism → path → line-range table, permalinks, and the fork relation. The
same reviewed files are copied byte-for-byte under `.upstream/` (index:
`.upstream/README.md`). That directory is gitignored on purpose, so symbol indexes
never see it: read the copies by path, or rebuild one file from the local object
store with the pin from `references.en.md`. Line ranges belong to the pin — never
compare them with this working tree.

## "How does claude do X": pick the layer

| Layer | Symptom in the ask | Read |
| --- | --- | --- |
| Claude Code behaviour | hooks, permissions prompts, MCP servers, slash commands, transcripts, "в оригинале" | the local source snapshot (path in `LOCAL-FORK-NOTES.md`), or run `claude --help` / the CLI itself |
| This repo's Claude backend | "наш бэкенд", file names from `src/`, "как мы это делаем" | `src/backends/claude/`, [docs/claude-backend.en.md](claude-backend.en.md), `ADAPTER.md` |
| Fork versus upstream dsh-TUI | "апстрим", "в оригинале dsh-TUI", "что мы поменяли" | [docs/references.en.md](references.en.md), `.upstream/README.md` |

The upstream pin is dsh-TUI code. Routing a Claude-behaviour question there returns
dsh-TUI behaviour, not Claude's.

<examples>

<example>
Input: "исходники claude cli in dsh-tui-fork"
Output: "Not vendored: `cli/` here is dsh-tui's own automation CLI. Claude Code
sources are the local snapshot recorded in `LOCAL-FORK-NOTES.md`; the installed
executable is `~/.local/bin/claude` → `~/.local/share/claude/versions/<version>`
(native binary). This repo's adapter is `src/backends/claude/`."
</example>

<example>
Input: "покажи reference-map по Codex reconnect"
Output: reads `docs/references.en.md`, finds the row `Codex reconnect: held
events, replay, duplicate suppression` → `.upstream/de73c6f3/src/backends/codex/session/session.ts`
(or `git show <pin>:src/backends/codex/session/session.ts`), quotes the pin's line
range and says it is the pin's, not the working tree's.
</example>

<example>
Input: "посмотри как устроено в claude: права на инструменты"
Output: asks or infers the layer. Default: this repo's backend — `src/backends/claude/permissions.ts`
plus the boundary rules in `ADAPTER.md`. If the ask is about the
product itself, reads the local source snapshot instead and cites a file from it.
</example>

<example>
Input: "как в claude, но у нас в TUI" (edge case: two layers at once)
Output: answers in two parts — what Claude Code does (source snapshot, cited by
file) and what this fork does (`src/backends/claude/…`), naming where they differ.
</example>

<example>
Input: a phrase that matches nothing, e.g. "refference-map по widgets"
Output: "Проверял: `docs/references.en.md` — нет строки про widgets; `.upstream/README.md`
— нет; grep по `src/` — нет." Never a bare "not found".
</example>

</examples>

<red_flags>

- Grepping this repository for `cli.js` or a vendored Claude Code tree: it was
  never vendored, and `cli/` is a different application.
- Treating `.upstream/` as indexed: codegraph and serena skip it, so an empty
  symbol search there means "not indexed", not "absent".
- Quoting pin line numbers as this tree's line numbers.
- Editing `lib/` or the installed package instead of `src/`.
- Answering what Claude Code does from memory without a cited source file or a
  command whose output shows it.
- Saying "not found" after a single search.
- Reading `docs/references.en.md` as if it covered Claude; it covers dsh-TUI.

</red_flags>

<verification>

Before answering a reference request, check:

- [ ] The answer names a path (`src/…`, `docs/…`, `~/.local/share/claude/versions/…`) and, when it claims absence, the search that would have found it.
- [ ] Each claim about Claude Code behaviour points at the local snapshot or a command, not at memory.
- [ ] A claim about the pin names `docs/references.en.md` as its source and does not present pin lines as the working tree's.
- [ ] `pnpm verify:source-hygiene` passes after editing this file or `AGENTS.md`.
- [ ] `test -e docs/agent-navigation.en.md` and its row in `docs/README.en.md` still resolve.

</verification>
