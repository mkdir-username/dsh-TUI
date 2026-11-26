# AGENTS.md

dsh-TUI is the terminal UI application for DeepSeek Harness (`@deepseek-harness-tui/dsh-tui`), with zero core changes and consuming only DSH's public exports. DSH is the primary integration target and first-party backend; this package is evolving from a "DSH plugin" into a "terminal application with its own entry point and composition root", at which point DSH, like claude / codex, will be loaded in-process as a backend on demand. DeepSeek Harness still owns the agent, session, model, tool, persistence, and policy domains; this package only consumes them. Before making changes, read [docs/contributing.en.md](docs/contributing.en.md) (the authoritative source for this repository's shared development contract) and [ADAPTER.md](ADAPTER.md) (upstream boundaries and contracts); see [docs/architecture.en.md](docs/architecture.en.md) for the overall structure, and [ADAPTER.md](ADAPTER.md) for the standalone host design and non-goals.

## Repository layout

```
src/index.ts Public Cordis plugin entry point, configuration schema, lazy handoff to the runtime implementation
src/dsh-adapter/plugin.ts Runtime implementation: TTY validation, service registration, agent creation/resumption, React tree mounting and cleanup
src/dsh-adapter/host-entry.ts Package entry point: does not compose a full DSH profile for non-DSH engines (instead composes a lightweight profile: this package's rows + third-party plugins declared by the profile); mounts the runtime on a bare Cordis root; routing decisions live in src/hostEntryRoute.ts (standalone host contract in ADAPTER.md)
src/dsh-adapter/channel.ts Channel entry point: backend-neutral core (channel/core/) + extensions mounted only for DSH sessions (channel/extensions.ts)
src/agent/ Backend-neutral session domain: AgentEvent, AgentSession, typed capabilities (no I/O or vendor dependencies)
src/channel/ Shared projector (AgentEvent → view state) and neutral stores for approvals, questionnaires, etc.
src/backends/claude/ Experimental Claude Agent SDK backend; see ADAPTER.md for the multi-backend structure
src/backends/codex/ Native Codex app-server backend: protocol, hub, translator, and capabilities; does not bundle the Codex npm dependency
src/dsh-adapter/oauth/ Built-in subscription OAuth: provider routing, /auth, credential storage, and questionnaire bridging
src/screens/ Chat.tsx interaction coordinator and status bar presentation
src/components/ Feature components; design-system/ contains theme-aware primitives
src/components/sidePanel/ Sidebar split layout (geometry, tab bar, PanelHost, keyboard seams) and built-in panel adapters
src/themeCatalog.ts Unified listing/resolution of built-in, static JSON, and runtime plugin themes
src/ui.ts Preferred facade for the local renderer, themed Box/Text, and public TUI primitives
src/ink/ Ink-family renderer and terminal implementation — sensitive infrastructure; keep changes focused and include dedicated regression checks
src/native-ts/ Yoga layout engine used by the renderer
src/terminal-utils/ Terminal formatting and presentation helpers
src/dsh-adapter/ The only location allowed to import official @deepseek-ai/* packages; themes.ts provides the tuiThemes plugin seam
src/*Prefs.ts etc. Persistent user preferences and session metadata under ~/.dsh-tui; src/tuiSettingsFile.ts is the dsh-tui section of /settings (settings.json)
.agents/skills/ Project skills for repository maintainers only; not distributed with the npm package
presets/ Presets distributed with the package (liangshen)
bin/dsh-tui.js Direct dsh-tui command entry point
cli/ Automation CLI: an independent application outside src/, MCP surface included
vendor/dsh-std Vendored dependency (built with a frozen lockfile; see the scripts/build-related scripts)
tui-profile/ In-repository TUI profile: plugin admission + private protocol definitions (plain files, revised alongside this repository's code)
cordis.patch.yml Package-level overlay for profile installation; row order, row IDs, and insert/override semantics are critical
cordis.yml Complete bare composition example for direct Cordis/DSH startup
scripts/ Headless regressions, reproduction environments, probes, and diagnostics; read each script's header before running it
docs/ Complete documentation outside the root README; every page is English and carries the .en.md suffix
lib/ Artifacts generated from src/ — excluded from version control, distributed with npm, never edited manually
```

See [docs/contributing.en.md](docs/contributing.en.md) for the complete repository map and runtime flow.

## Reference requests: resolve the phrase before searching

Some asks name a reference, not a file in this tree. Route them first, then search.

| The ask | What it is | Read first |
| --- | --- | --- |
| "исходники claude cli", "исходники Claude Code", "claude cli source" | Claude Code sources. Not vendored here: a readable snapshot lives outside the repo, its path is in `LOCAL-FORK-NOTES.md` | that snapshot; this repo's adapter is `src/backends/claude/` |
| "reference-map", "refference-map", "референс-мап", "рефференс-мап", "reference map" | The pinned upstream dsh-TUI reference map — not a symbol index, and not Claude | `docs/references.en.md` (`.upstream/README.md` is the local copy) |
| "посмотри как устроено в claude", "как в claude code", "how does claude do X" | Behaviour of Claude Code, unless the ask names a layer | `docs/agent-navigation.en.md` splits sources / this backend / the upstream pin |

`cli/` is this package's own automation CLI, unrelated to Claude. `.upstream/` is gitignored on purpose, so codegraph and serena never see it, and its line numbers belong to the pin, not the working tree. Details and worked examples: [docs/agent-navigation.en.md](docs/agent-navigation.en.md).

## Commands

```sh
pnpm install --frozen-lockfile # pnpm 11; Node ^22.19 || >=24 (CI uses Node 24)
pnpm compile # Clean compilation of src/ → lib/types/ (deletes all of lib/ first; skips the vendor build if unchanged)
pnpm build # compile + all build gates
pnpm verify:build # Build gates (boundaries/contracts/patch surface/plugin checks, etc.), parallel, without recompiling; --jobs 1 for serial troubleshooting
pnpm verify:package # Complete npm tarball targets + entry-point import smoke checks
pnpm smoke # General headless screen-assembly smoke check
```

The repository **has no root-level `test` or `lint` scripts** — do not claim to have run them. The static gate is the TypeScript build; behavioral verification relies on focused regression scripts and reproduction environments. Most scripts invoked with plain `node` import `lib/types/`, so run `pnpm build` first; scripts that import TypeScript source declare `node --import tsx/esm <script>` in their headers. Do not infer the input layer from the file extension (`verify-themes.mjs` actually imports `src/` through tsx). `scripts/` also contains forensic/interactive tools (heap analysis, PTY probes, replay capture, performance probes); these are not bounded tests, so do not run them all as a suite.

- Choose verification based on the affected area: changes to shared rendering, `Chat`, prompt/questionnaire layouts, tool cards, theme primitives, or the `ink/` core must run the CI regressions; narrow changes should run the corresponding focused scripts. See the mapping in [docs/contributing.en.md](docs/contributing.en.md). For terminal-visible changes, supplement headless assertions with manual exercises of the affected flows in both inline and fullscreen modes at narrow terminal widths when the environment is available.
- Documentation-only, workflow-only, and YAML-only changes do not require a rebuild (unless TypeScript inputs also changed).

## Upstream boundaries and contracts

- Isolate vendor packages by directory: `@deepseek-ai/*` only in `src/dsh-adapter/`, `@anthropic-ai/*` only in `src/backends/claude/`; the backend-neutral layers `src/agent/` and `src/channel/` must not import vendor packages, `src/dsh-adapter/`, or `src/backends/`; the UI layer must not import `src/backends/` and may import only types from `src/dsh-adapter/` (the allowlist for existing value imports may only shrink, never grow). See [ADAPTER.md](ADAPTER.md) for the full rule table; `pnpm run verify:boundary` scans all source code and fails on boundary violations.
- The validated version line, peer ranges, and approved package list are in `src/dsh-adapter/contract.ts`; detected drift produces a local warning, while `verify:contract` fails outright in CI.
- The package entry point loads modules from the installed `dsh` using the host's realpath: `src/dsh-adapter/host-contract.ts` is the sole source for the inventory, replicated surface, and deviations; loading happens only in `host-dsh.ts` (only `import type` for `@deepseek-ai/*`). `verify:contract` runs the fake-host fallback and, when an installed host is available, capability probes and replica fingerprints (`host-replica.snapshot.json`); the host CLI is not a dependency, so verify changes to the version line on a machine with that `dsh` version installed. See "Host contract for the standalone entry point" in [ADAPTER.md](ADAPTER.md).
- Framework packages under `@deepseek-ai/*` referenced at runtime or by published types must be both peer and dev dependencies (the `verify:manifest-deps` gate); framework packages used only by tests/scripts belong only in dev dependencies.
- Changes to official rows made by `cordis.patch.yml` are snapshotted in `patch-surface.snapshot.json`; keep them synchronized when making changes (the `verify:patch-surface` gate).

## Upstream merges: the fork wins

Incoming upstream work never outranks ours. When a release from `ccch1mneyyy/dsh-TUI` conflicts with a fork patch or behavior, the fork side stays and upstream adapts: a merge may drop an upstream nuance, never a fork feature. Removing superseded fork code is an explicit decision, with evidence that the upstream replacement is equivalent or better. Upstream fixes are welcome as long as every fork behavior stays intact.

## Conventions and hard rules

- **Language**: English only. Never author CJK — not in code, comments, check labels, fixtures, identifiers, documentation, or localized product copy — and never mirror a string into a second language. `en` is the source of truth for every UI string; a translation is optional data that nobody is required to add or maintain. Existing Chinese text in the tree is frozen legacy data: a change never extends it, and a passage you rewrite becomes English. Machine tokens that tooling matches literally, such as the `固定窗:<category>` sleep tags read by `verify:fixed-window`, are never translated. Retranslating or deleting the legacy Chinese set is its own task, not a side effect of an edit that happens to pass through it.
- **Separate source and artifacts**: Edit `src/`, never edit `lib/` directly, and do not commit generated output under `lib/`.
- **Project from the source of truth**: The backend's persisted session records (DSH session event logs, Claude transcript files) are the transcript's source of truth; do not insert optimistic assistant/tool facts that may diverge from persisted records. Preserve event order, sequence anchors, and call-ID matching.
- **Separate responsibilities**: Projection belongs in the shared projector `src/channel/projection.ts`; TUI actions belong in the channel core `dsh-adapter/channel/core/` and DSH extensions `channel/extensions.ts` (new backends integrate through session capabilities without adding channel code); interaction modes and key precedence belong in `Chat.tsx`; terminal protocols, layout, and frame diffing belong in `ink/`. Do not reimplement DSH domain services in the TUI for UI convenience — adapt through the channel or existing registry seams.
- **Registration is an effect**: Register resources through Cordis and clean them up with `ctx.effect` or the existing single exit funnel. Rendering failures must be loud and exit with a non-zero status; restore terminal state before normal exit (raw mode, cursor, alt-screen, synchronized output, mouse, focus).
- **Keep rendering quiet**: Do not add `console.log` or stdout diagnostics while the TUI is active; use opt-in stderr/debug paths (`DSH_TUI_DEBUG`, `DSH_TUI_RENDER_LOG`).
- **TypeScript**: Pure ESM; use `.js` suffixes for relative imports and prefer `import type` for type-only dependencies. Do not introduce `any` because the Ink-family renderer has relaxed rules; narrow `unknown` instead. Follow the existing two-space indentation, single quotes, and no-semicolon style; do not bulk-format renderer files.
- **Terminal width is display-cell width**, not JS string length; account for ANSI escapes, combining characters, emoji, and East Asian wide characters, and use the repository's width/slicing/wrapping helpers.
- **One source for dimensions**: Outside `ink/`, always obtain dimensions through `useTerminalSize()` (margins and split layouts narrow them at each level); do not read `stdout.columns/rows` directly or add your own resize listeners. If physical terminal dimensions are truly required, add the use to `ALLOWED` in `verify:terminal-size-source` and document the reason.
- **Documentation synchronization**: Keep behavior, configuration, shortcuts, and limitations synchronized in English in `README.md` and the English documentation set (`docs/*.en.md`). No second language is required or maintained; see [docs/contributing.en.md](docs/contributing.en.md) for the cross-file synchronization checklist covering plugin configuration, slash commands, themes, the renderer, and skill discovery.
- **Secrets**: Interactive startup reads `DEEPSEEK_API_KEY`; diagnostics may report only whether it is set and must never reveal its full value.
- **PRs**: Always use `.agents/skills/pr` when creating or updating a PR (including rewriting its description).
- **Git safety**: Stage only explicit paths; do not use `git add .`/`git add -A` or run destructive cleanup commands. This is a personal fork: the agent must make atomic commits of its own changes and push them without waiting for the user to ask or handing commit/push back to the user — after verification passes, commit using `type(scope): description` (English past tense, no AI attribution), immediately followed by `git push mine main` (`origin` is read-only; report rejected pushes and never force-push). Tags, releases, and `npm publish` still require an explicit request; releases are driven by `v*` tags and must exactly match the `package.json` version.

## Code review principles

When reviewing PRs, prioritize **introducing no new bugs, making the minimum necessary changes, and keeping the code simple**:

1. **Prevent regressions**: Prioritize new bugs, races, resource leaks, performance regressions, and compatibility issues, paying particular attention to how shared code (backend-neutral layers such as `src/agent/` and `src/channel/`) affects other backends and existing functionality.
2. **Avoid overengineering**: Identify duplicate implementations, unnecessary abstractions, redundant wrappers, and excessive defensive programming. Report them only when a simpler equivalent exists; do not misclassify necessary security checks or error handling.
3. **Keep scope strict**: Changes should serve the PR's goal and related issues, without unrelated refactoring, formatting, dependency upgrades, or other feature changes. Necessary tests and documentation synchronization are exceptions.
4. **Ensure substantive value**: Focus on ineffective code, duplicate logic, pointless file splitting, and tests without meaningful assertions. Do not judge contribution value by line count or commit count, or speculate about contributors' motives.
5. **Base reviews on evidence**: Report only substantive issues introduced by the PR, identifying the exact location, triggering conditions, and actual impact; prefer minimal fixes. Do not nitpick just to add comments.

## Editing this file

`CLAUDE.md` is a symbolic link to `AGENTS.md`; edit the target file. Keep each rule self-contained and link details to authoritative documentation; prefer concise wording as long as clarity is preserved.
