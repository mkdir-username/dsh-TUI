<p align="center">
  <img src="docs/assets/readme/logo-en.svg" alt="dsh-TUI animated whale logo" width="560">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui"><img alt="npm" src="https://img.shields.io/npm/v/@deepseek-harness-tui/dsh-tui?style=flat-square&color=4b6fff"></a>
  <a href="https://github.com/ccch1mneyyy/dsh-TUI"><img alt="Fork of ccch1mneyyy/dsh-TUI" src="https://img.shields.io/badge/fork%20of-ccch1mneyyy%2Fdsh--TUI-263146?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square"></a>
  <img alt="Public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
</p>

# dsh-TUI — a personal fork

dsh-TUI is a terminal UI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It brings a pixel whale, streaming thinking, live work state, a context bar and a TPS
gauge, plus sessions you can fork, rewind and background. It draws Markdown, tool
cards, images, Mermaid diagrams and LaTeX math, and it drives the DSH, Claude and
Codex backends behind the same keys. Zero core changes: it consumes only DSH's
public exports, and an uninstall leaves no patches behind.

This repository is **a personal fork** of
[ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI). It tracks upstream
`v0.20.2` on the DSH `0.2.2-rc.5` line and keeps a set of local changes on top.
It is not published to npm: the package, the npm release, the Windows installer and
the issue tracker remain upstream's. What this fork adds is listed under
[This fork](#this-fork); how it runs on its author's machine is under
[Development](#development).

## This fork

- **Park key.** `Ctrl+B` / `⌘B` moves a waiting foreground call — a running
  command, `job_output(wait: true)`, a delegation, a foreground workflow — to the
  background, and the turn moves on. With nothing waiting the key does nothing:
  the side panel has its own combo.
- **Side panel key.** `⌘/` (`Ctrl+/` off macOS) runs the smart three-state
  toggle — closed → open and focus the panel → focus back to the chat → closed;
  `/panel` and a tab click open it without any key.
- **Automatic park.** `autoBackground` (on by default) asks the same seam the
  moment a delegation or workflow starts waiting, so a long child never holds a
  turn for a key press.
- **Compaction holds the turn.** `/compact` runs `restruct-plan` first, queues
  what you type one line per message, and keeps waking jobs and subagents in the
  inbox until the compaction ends.
- **`/hs`.** Skips the DSH end-of-turn controller check: bare `/hs` for this step,
  `/hs --on` for the rest of the chat, `/hs --off` to restore. A `⏸ hs` chip in
  the status line shows the state.
- **Less chrome.** No goal row in the chat footer (the todo panel carries the
  objective and its rounds), no star prompt, TPS on by default.

<details>
<summary>Full change list — what differs from upstream</summary>

- **Ctrl+Enter steers instead of interrupting.** Mid-turn, `Enter` and `Ctrl+Enter`
  send the draft without stopping the turn; `Esc` interrupts. An interrupt also
  silences automatic follow-ups (a Stop hook's verdict, a finished job, a goal
  round, a subagent settlement) until your next message, and the next turn opens
  with a note that the previous one was cancelled.
- **Input survives `/compact`.** Text typed while a compaction runs is held in the
  composer, folded to one line per message with a hover peek, and delivered when
  the compaction ends. The whole cycle (restruct-plan + engine compaction) runs
  inside `Agent.runMaintenance`, so job and subagent wake-ups wait in the inbox
  instead of cutting in.
- **The compaction notice names its cause.** A cancelled `/compact` says who
  cancelled it (user, switch, disposal) and that no compaction was made; ten
  seconds of silence says the model's answer is still pending. The fork runs on
  a budget, not a kill: the soft mark asks it to finish with its marker, the
  hard mark stops it and the compaction still runs on the plan written so far.
- **`/hs` (handoff-skip).** The TUI writes `~/.claude/.state/hs-mode/<session>.hs`;
  the DSH Stop hook reads it. `once` carries a two-hour TTL and covers the current
  step, `on` has no expiry and silences all stop pings except the turn-end recall
  until `/hs --off`. Another kernel answers with a notice instead of writing a
  file no check will read.
- **The chat footer has no goal row.** Objective, phase and rounds live in the
  `todo` side panel with full wrapping; a bare `/goal` prints the status block.
  The status line keeps a compact phase chip.
- **Star mechanics removed.** No `/star`, no `Alt+S`, no star prompt or usage
  counter; the login-bonus coupon card stays as `WhaleCouponPrompt`.
- **TPS on by default.** The chip draws `▕████▏ 42 tps` during a reply and holds
  the last measurement between turns.
- **Selection keeps its column viewport.** The fork's column-aware selection is
  wired through upstream's painted-position signatures, and drag-autoscroll
  (edge-inclusive) stays.
- **English-only documentation.** The Chinese document set and `README_ZH.md` are
  gone; `en` is the source of truth for every string. The UI still ships the
  `zh` translation behind `/lang`.
- **Node 24 for the build.** `.nvmrc` pins 24.22.2; the package keeps
  `^22.19 || >=24`.

Fork notes, gate names and the local core patches (applied outside this
repository) are in [`LOCAL-FORK-NOTES.md`](LOCAL-FORK-NOTES.md). The pinned
upstream reference map — mechanism → file → lines → permalink → fork difference —
is [`docs/references.en.md`](docs/references.en.md).

</details>

## Quick start

Three ways in. Only the first one gives you upstream as it ships; the other two
run this tree.

**Upstream, from npm.** This installs the released `@deepseek-harness-tui/dsh-tui`,
not the fork.

```sh
npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui
dsh-tui          # first run auto-initializes the profile; needs pnpm
dst              # the same program under a short alias
```

**This tree.** Clone with the submodule, build, and launch the workspace host.

```sh
git clone --recurse-submodules https://github.com/mkdir-username/dsh-TUI
cd dsh-TUI
pnpm install --frozen-lockfile     # pnpm 11, Node 24
pnpm build
pnpm smoke
pnpm tui                           # workspace host; pnpm dev runs the full cycle
```

**As a profile dependency.** Point the `dsh-tui` profile at the checkout, then
`pnpm compile` after every `src/` change.

```sh
cd ~/.dsh/profiles/dsh-tui
pnpm add "@deepseek-harness-tui/dsh-tui@link:$HOME/Docs/dsh-tui-fork"
pnpm install
```

Afterwards `dsh-tui` and `dsh --profile dsh-tui` are the same launcher. A manual
alternative is `dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`;
the repo's `install.sh` runs that step and checks the required commands.

<details>
<summary>Windows installer, updates, restart, safe mode</summary>

**Windows one-click installer (x64).** Download `dsh-tui-setup-win-x64.exe` from
upstream [Releases](https://github.com/ccch1mneyyy/dsh-TUI/releases) and run it.
Per-user, no administrator, fully offline, no preinstalled Node or DSH.

**Prerequisites.** [Node.js](https://nodejs.org/en) and
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). The
`deepseek-official` API-key route needs `DEEPSEEK_API_KEY`; on DSH 0.2.0-rc.1+ the
standard profile can use `/auth login deepseek-account` instead and pick the
account route through `/model`. Other accounts sign in through `/provider` or
`/auth` after startup.

**Compatibility.** The primary target is DSH `0.2.2-rc.5`: its Shell API, V4
session messages, declarative presets and profile-backed settings are supported,
and older hosts keep their compatibility paths. See
[configuration](docs/configuration.en.md).

**Updates.** After startup the TUI checks for newer versions in the background
and never blocks the first frame. `/update` upgrades the whole set in one shot —
TUI, dsh engine and global launcher — restarts, and resumes the current session.
It refuses rather than leave an incompatible TUI/engine pair: launcher alignment
is best effort until the engine advances, then a failure blocks the restart and
prints a repair command. A newer dsh release outside the validated line is
reported and waits for a TUI update. Only proven global installs are touched;
local npm/npx packages, ambiguous aliases and multi-member pnpm groups stay as
they are. `/update` needs a `dsh --profile` launch and is refused while a turn
runs. See [Getting started](docs/getting-started.en.md) for the profile
lifecycle, source builds and migration from the former `dsh-cc-tui` package.

**Restart.** `/restart` resumes the current session without installing anything.
On non-Windows runtimes with `process.execve` it replaces the process, so
repeated restarts do not stack waiting TUI processes; other runtimes and kernel
switches keep the supervised child handoff. A launch delegated to
`dsh --profile` stays on that path until the next cold launch or kernel switch.

**pnpm blocks install scripts.** pnpm ≥11 refuses dependencies with install
scripts and reports `ERR_PNPM_IGNORED_BUILDS`. Updates skip foreign-platform
natives (`@img/sharp-*`, the Claude SDK's per-platform bundles) so only this
machine's binaries arrive, and `/update` plus `dsh-tui update` write both
settings themselves. An update never installs the Claude SDK on its own: it
enters a profile only when you pick that backend in the kernel picker. Details:
[Getting started](docs/getting-started.en.md#pnpm-install-script-blocks-and-foreign-platform-natives).

**Safe mode.** `dsh-tui safe` gives read-only diagnostics, a plugin inventory and
repair guidance; `safe --rescue` builds a clean rescue profile. `doctor` checks
the environment before launch.

</details>

### Command line

Automation: `dst -p "task"`, `dst run --json`, `dst session list --json`.
The independent engine loads no TUI and inherits no profile or preferences; it
uses official DSH headless/services (validated on 0.2.0-rc.2, 0.2.1-rc.2 through
rc.5, and 0.2.2-rc.1). `dst cli --help` lists the commands, `dst dsh <argv...>`
forwards native DSH. Agents get the same session operations as MCP tools
(`node bin/dst-mcp.js`) — see
[Session API for agents](docs/agent-session-api.en.md).

| Command | Purpose |
| --- | --- |
| `dsh-tui` / `dst` | Start the TUI; `dst` is a short alias for the same program |
| `dsh-tui --resume [id]` | Resume a session |
| `dsh-tui update` | Align the TUI, dsh engine and global launcher as one set |
| `dsh-tui doctor` | Pre-flight environment checks |
| `dsh-tui safe` | Read-only diagnostics and repair guidance; `--rescue` builds a rescue profile |
| `dsh-tui version` / `dsh-tui help` | Versions and usage; both work without a `dsh` install |

Leading DSH options such as `--dump-config` and `--patch <path>` are forwarded
unchanged; other arguments go to the app in `dsh --profile dsh-tui`. To send
`--resume=sid-1 ./notes` as literal prompt text, use
`dsh-tui -- --resume=sid-1 ./notes`; when invoking DSH directly, the first `--`
belongs to DSH and the second to the app:
`dsh --profile dsh-tui -- -- --resume=sid-1 ./notes`. Host options may precede a literal
prompt: `dsh-tui --patch ./overlay.yml -- --resume=sid-1` applies the overlay and
sends the rest as text. Protocol details, resume restrictions and
Node/Python/PowerShell examples: [Automation CLI](docs/cli.en.md).

<details>
<summary>Importing conversations from other agents</summary>

`dsh-tui migrate` brings Claude Code, Codex, OMP, zcode and Grok Build histories
into the DSH session store; `/resume` then lists them by their original working
directory.

```sh
dsh-tui migrate                    # list importable counts per agent (writes nothing)
dsh-tui migrate claude-code        # likewise codex / omp / zcode / grok-build
dsh-tui migrate codex --dry-run    # preview what would land
```

- **Read-only source.** Only the foreign agent's local store is read. Artifacts
  go through the official `JsonlSessionPersistence` backend, so imported sessions
  are first-class: openable and continuable.
- **Idempotent.** One deterministic UUID per source conversation; re-importing
  skips what is already there instead of stacking duplicates.
- **Structure preserved.** User and assistant messages, reasoning traces, tool
  calls with results and the source's compactions are rebuilt turn by turn;
  harness-injected machine text opens no turn.
- **In the TUI.** The session screen shows a tab per agent that has
  conversations; picking one imports just that conversation. `/migrate`
  (optionally `/migrate <agent> [--dry-run]`) runs the same import in a child
  process and reports through notifications; `dsh-tui migrate …` from any shell
runs the same import.

More agents (pi, opencode, …) join the adapter registry as adapters land;
grok-build reads `GROK_HOME` when set. Full guide:
[Session migration](docs/migrate.en.md).

</details>

<details>
<summary>Resume rules and startup recovery</summary>

Bare `--resume` (`-c`, `--continue`) reopens the last session of the backend this
launch selected. Recovery only ever targets that backend: a backend with no last
session, or a target that belongs to another backend than the one that booted (an
unknown id falling back to DSH, `--backend` naming an uninstalled backend, a
remembered kernel that is not the marker's source), refuses with a clear error
and exit code 1 — never a silent cold start, never another backend's session,
never a new session. An explicit `--resume <id>` passes that id through as-is.
The one exception is safe mode's "retry normal startup": it retries the kernel
and session recorded in `last-run.json`, so a record whose backend is gone
degrades to a warning plus a cold start.

If resume reports that another DSH process owns the writer, release the session
in that process (for example, `dsh web`) and retry in the same TUI. The
foreground session stays intact; do not delete session or lock files to bypass
single-writer protection.

</details>

## What you get

- **Launchpad and first run.** Every ordinary launch lands on a page with a real
  input box — big text, the whale, quick actions — that walks a four-step wizard:
  accounts and models, language and theme, model and workspace, shortcuts. The
  wizard re-runs with `/setup`, signs in to a subscription or adds an API key.
- **Terminal-native transcript.** Streaming Markdown, tool and diff cards,
  clickable timeline, `#L12-14` ranges, `/` and `@` completion, history search,
  and images, Mermaid and LaTeX rendered in the terminal.
- **Live state.** Context bar, TPS gauge, cache hit rate, effort, tokens, session
  cost estimate, Git and session metadata — all updating independently of the
  transcript and pausing when idle.
- **One session manager.** `/resume` `/home` `/agentview` `/bg` `⌸` open the same
  screen: workspace rail, live state, filter, pins. Fork, rewind and the session
  tree hang off it.
- **Backends and integrations.** DSH presets, skills, MCP, goals, todos,
  subagents and questionnaires; Claude and Codex as experimental backends behind
  the same keys; plugin panels, slash commands and extensions for browser
  interaction and computer use.

<details>
<summary>Editor and terminal integrations</summary>

**VS Code.** Use the integrated terminal or the `dsh-tui-vscode` extension; a
VS Code selection lands in the prompt. See the [VS Code guide](docs/vscode.en.md).

**Herdr.** Run `dsh-tui` in a [Herdr](https://herdr.dev) pane: `idle` / `working`
/ `blocked` are reported through its local integration API.

**Any terminal.** dsh-TUI reports `idle` / `working` / `blocked` / `done` / `error`
over the pty with [OSC 7501 (Program Status
Protocol)](https://www.superlogical.com/rex/docs/build/program-status), so
terminals and agentic inboxes that implement it can show what the session is
doing; others ignore the sequence. Set `DSH_TUI_PROGRAM_STATUS=0` to turn it off.

</details>

<div align="center">
  <picture>
    <source media="(max-width: 640px)" srcset="docs/assets/readme/preview-en-mobile.svg">
    <img src="docs/assets/readme/preview-en.svg" alt="Recorded dsh-TUI session: welcome, completion, help and typing, with animated pixel whale." width="78%">
  </picture>
</div>

<details>
<summary>Launchpad, whale and the first-run wizard</summary>

The launchpad is on by default; `/settings` → `launchpad` off boots straight into
chat. Blocks drop whole on short or narrow terminals, and the whale-girl images
use a compact native-canvas footprint instead of leaving a gap before the title.
Command completion matches chat: `Tab` fills the input, `Enter` runs the command
and clears it.

The wizard's first step signs in to a subscription and catches the models it
brings in: none — no question, one — that one, several — you choose. Otherwise it
adds an API key through the `/provider` wizard, which asks which of the enabled
models to switch to, or keeps the current one.

The pixel whale has three startup intros and wakes on click; it freezes after the
first task. The pixel whale, the large title and the context/TPS colors follow the
terminal's color depth — monochrome, 16-color, 256-color or truecolor. Apple
Terminal and tmux use the shared fallback; `NO_COLOR` and `FORCE_COLOR` keep the
shared policy.

</details>

<details>
<summary>Transcript, diff cards and the timeline rail</summary>

Every turn is clickable on the timeline rail: timeline, scrollbar or hidden
gutter.

Split diff cards give one-sided additions and deletions the full body width,
without an empty opposite pane. Ordinary edits stay side by side, and mixed files
choose their layout separately before folding or streaming reveal.

A completed text-only assistant reply that contains only a leading `⏵` status line
stays visible and can be selected for copying; live status lines, and status lines
followed by a real answer, stay out of the transcript body.

Plugin slash-command results, errors included, remain as local transcript blocks
for scrolling and copying during the session: indentation and line breaks are
preserved, each report keeps at most 200 lines, 65,536 UTF-16 code units and 4,000
terminal cells per line plus a truncation marker, and older blocks are evicted
within the shared 600-row budget. The rows are never sent as model input or
replayed as conversation history; the backend may persist command audit events
separately. Built-in report layouts such as `/goal` keep their own formatting.

</details>

<details>
<summary>Images, Mermaid and LaTeX</summary>

Kitty and Sixel thumbnails, a centered preview with zoom and pan, paste-time
fitting and a text fallback. Kitty images scale to the reserved cells' physical
pixels, including on HiDPI terminals.

`mermaid` fences draw as Unicode diagrams.

`$…$` and `$$…$$` render as Unicode text, with fractions and limits stacked in
display blocks; `mathRendering: image` typesets block and one-row inline formulas
as terminal images on graphics terminals.

Image files referenced with `@path` follow the same admission and
resize/conversion policy as pasted images. Adjustment notices report the stored
dimensions and format; a required animation conversion is refused instead of
dropping frames. Mention images and staged images share the count and stored-byte
limits in source order.

</details>

## Using it

**Keys.** `Enter` send · `Tab` complete · `Ctrl+Enter` send without stopping the
turn · `Alt+Up` recall the last message · `Esc` close local layers before
interrupting · double-`Esc` rewind on empty idle input · `Ctrl+B` / `⌘B` park a
waiting call · `⌘/` side panel · `Ctrl+O` details · `Ctrl+R` history · `Ctrl+V` paste ·
`Ctrl+Shift+E` fullscreen draft editor · `?` shortcuts · `←` session manager.

**Mouse (fullscreen).** Drag to select and copy, double or triple click a word or
line, click tool cards, timeline ticks and `[Image #N]` previews. Inline mode uses
the terminal's native selection.

**When the model is working.** `Enter` or `Ctrl+Enter` steers, `Tab` queues a
follow-up, `Esc` interrupts. Input that names a command stays a command — `/model`
or `/new` reach their own gate instead of silently becoming an interruption; a
skill gesture such as `/skill-name …` still steers.

**Commands.** Sessions: `/resume` `/home` `/agentview` `/bg` `⌸` · `/new`
`/compact` `/export` `/btw` `/tree` `/fork` `/rewind` · state: `/status` `/cost`
`/context` `/balance` `/jobs` · model: `/model` `/effort` `/thinking` · account:
`/provider` `/auth` `/login` · tooling: `/skills` `/mcp` `/plugin` · system:
`/settings` `/setup` `/doctor` `/update` `/kernel` `/dsh` `/codex` `/claude` ·
fork: `/hs` `/panel`.

<details>
<summary>Composer and editing keys</summary>

In both the launchpad and chat, `Ctrl+U` deletes from the caret to the current
line start, keeping text to the right and whole image chips; it edits only the
focused input. `Alt/Option+←/→` moves by whitespace-delimited words,
`Alt/Option+Backspace` deletes the previous word like `Ctrl+W`. On macOS, set the
terminal to send Option as Meta.

In the launchpad input, `Shift+Enter` (or `Option+Enter`) opens chat and inserts a
newline at the caret, keeping the draft and staged images unsent.

The questionnaire's answer field is the same editor: `Alt/Option+←/→` and
`Ctrl+←/→` jump by words, `Ctrl+A/E` and `Home`/`End` go to the line edge,
`Ctrl+W` and `Alt/Option+Backspace` delete the previous word, `Ctrl+U` deletes to
the line start, `Ctrl+↑/↓` move between lines. `Shift+Enter`, `Option+Enter` or
`Ctrl+J` insert a line break; a bare `Enter` submits. Options are numbered: with
an empty buffer, `1`–`9` pick that option (multi-select toggles it); once the
buffer holds text, digits are typed into the answer.

The plan-review feedback row uses the same editor and the same line-break keys.

The rewind list (double-`Esc` on an empty idle input, or `/rewind`) shows one
checkpoint per message with a dim metadata line — its position, plus `last message`
for the newest — keeps the focused checkpoint on screen, collapses the rest behind
`↑ N more` / `↓ N more`, and says `⚠ No code restore` when the rewind restores the
conversation only.

The focused text input inherits your terminal's cursor shape, color, blinking and
animation or trail effects, in both inline and fullscreen modes. The `/model`
picker keeps that cursor while it moves between provider tabs, model rows and
effort levels, then hides it after 0.5 seconds at rest; clipped regions fall back
to the model row. The session manager moves the same cursor between the workspace
rail, session rows and the search box — typing claims the search caret, and
navigation returns it to the focused row. Animation and trail effects are
configured in your terminal.

`Alt+Up` / `Alt+Down` page through question text and approval previews without
moving the choice focus; the keys are remappable in `/settings` → `Shortcuts`.
Fullscreen also supports the wheel over the preview. OAuth links stay readable
when browser and clipboard helpers are unavailable. Permission questions offer
only the caller's choices; ordinary questionnaires still accept free text.

Text, cursor position and staged images survive a backend still starting: press
`Enter` when it is ready to send; an earlier `Enter` keeps the draft without
queueing it. Opening a new session while startup is pending clears the draft and
its images.

</details>

<details>
<summary>Mouse selection, copying and scrolling</summary>

A fullscreen selection stays in the pane where the gesture starts — chat, sidebar
or either diff column. Diagonal, word and line selection copy that pane's text;
soft wraps join independently, source newlines remain, and divider drags only
resize. Holding the pointer on the transcript's top or bottom row while dragging
keeps scrolling, so copied text can include rows outside the viewport the drag
began in.

Automatic copies keep the text selected; `Esc` clears it, a new selection
replaces it. Highlighting skips trailing padding and blank rows while preserving
inner spaces and code indentation.

While dragging, `PgUp` / `PgDn` or the wheel extend the selection across pages:
its origin follows the text while the other endpoint stays at the pointer. After
release both endpoints follow scrolling. Off-screen selections keep their captured
text without highlighting unrelated edge cells; scrolling back restores their
position and column range.

A selection started inside a code block joins soft-wrapped rows without adding
frame padding or newlines, in both light and full frames; hard breaks and the
hard-line inset remain part of what you copy.

While a text drag is in progress the native cursor follows the selected text's
edge using the terminal's cursor animation or trail effects; releasing or
cancelling the drag restores the focused input's caret.

Fullscreen drag-copy uses the final highlight. If a live row changed during the
drag, move the selection back to stable text to establish a new baseline; a
stationary selection whose copied text changes is still refused, and automatic
scroll or resize does not clear that protection.

On Windows, copying uses PowerShell with UTF-8 stdin: copies run in order, each
attempt has a two-second timeout (Windows PowerShell, then PowerShell 7), and
OSC 52 remains the fallback when both fail. SSH never writes the remote native
clipboard.

</details>

<details>
<summary>Pasting, dropped files and the file-action menu</summary>

The launchpad accepts clipboard images and pasted image paths as `[Image #N]`
attachments; `Enter` sends them with the first message. Commands that do not
accept images keep the draft and its attachments; a slash-invoked skill is not
such a command — its images ride the same message as the skill gesture. Image
chips behave like chat: arrows step across them, `Backspace` at the end or
`Delete` at the start removes the whole image, and `Ctrl+W` never splits a chip.
Text pasted on the launchpad folds to one line. In chat, native and bracketed
paste keep ordinary text and newlines and never submit on arrival.

On Windows terminals that deliver a paste as win32-input-mode key records, a
record stream leaked into the payload is decoded back into the characters its
`Uc` field encodes — newlines included — so the composer's line count matches
what was pasted. Records with no character meaning are stripped, a complete
record is consumed before an ESC-less tail, and pasted CRLF collapses to one
newline; genuine underscores and bracketed-paste text are untouched.

A native Windows desktop drop (Windows Terminal / OpenConsole) arrives as an
OSC 8 hyperlink; the parser restores its `file://` URI to a decoded local path
before paste hygiene runs, so the `]8;id=…;` parameters never reach the draft.
Image paths enter the image staging pipeline; other files are inserted as a
referenceable path, in the composer's quoted `"…"` single-token form when it
contains whitespace. Restoration is
fail-closed: a remote authority or UNC, several distinct URIs, or a URI carrying
several tokens stays literal text instead of being guessed. Multi-file drops and
terminator-less truncated frames are not covered.

File paths in prose can open the file-action menu; automatic detection does not
extract a path from inside a slash-delimited token such as `working/idle/needs-input`
or a date such as `2024/01/15`. On Linux a handler marked `Terminal=true` (for
example `vim.desktop`) opens inside a terminal (`kitty -1 vim <file>`); other
targets go to the system default handler. Non-empty `Path=` stays with
`xdg-open`, and such a terminal handler can still fail without a TTY.

`Ctrl+V` needs platform clipboard tools; unsupported bitmap formats are rejected.

</details>

<details>
<summary>Pickers, kernels and the session manager</summary>

`/dsh`, `/codex` and `/claude` switch to the named kernel exactly like choosing it
in `/kernel`: the choice is remembered, the process restarts into a new session,
and a running turn blocks the switch. Choosing the current kernel keeps the
session. Availability checks and the Claude install wizard follow the same picker
flow.

`/model` shows models and reasoning effort on one page. On DSH it has provider
tabs with **Recently used** first and the current model on top; `Tab` / `Shift+Tab`
move between providers. Codex and Claude open their catalogs directly. `↑/↓`
select a model, `←/→` adjust effort, `Enter` applies the model and any explicit
effort draft, `Esc` cancels; changing only the model keeps the backend's own
preference handling. Mouse users can click tabs, models and effort levels — an
effort click applies the focused model and that effort, then closes the picker.
Short terminals keep the focused model and the select/cancel actions visible,
hiding descriptions, neighbouring models and finally the effort row.

In `/provider`'s model list, focus a model and press `Tab` to edit its context
window, max output tokens, reasoning efforts and image-input capability.

On DSH, `/fork` keeps the current session open and creates a resumable copy; a
copy with history records its parent and appears in the same session family.

The session manager focuses the most recent session of the current workspace, or
the new-session card when there is no history. Moving between the rail and the
list keeps the selection, including when the mouse enters the list; switching to
another workspace selects its latest session, and switching back starts there
again. `←` moves to the workspace rail. The list preloads in the background after
startup, the manager paints the last successful list at once, and a pending read is
shared with an open `/resume`. The first-paint snapshot survives restarts and is
isolated by backend and storage directory. Fresh sessions and titles merge in
immediately; cached rows from other workspaces stay until the full read finishes.
Background updates preserve a session selected by hand.

Claude and Codex first request up to 32 recent sessions in their native scope
(Claude's SDK includes Git worktrees of the same repository; Codex matches the
session cwd exactly). Codex listings reuse the running connection, read the first
32 regular results alongside the state DB shortcut and fill later pages after.
DSH resolves the current workspace's metadata first, even when it holds fewer than
32 sessions; titles needing a deeper log scan appear with a fallback name and
update in place.

The manager shows the selected workspace's absolute path once beneath the source
tabs, wrapping when needed. Session rows show title and essential status or time
instead of repeating the directory; DSH size and model stay in the title tooltip.
The project rail uses one line per directory on every backend and source tab.

Removing a workspace registration keeps its sessions under a "History only"
directory: edit and new-session actions stay available, while rename and remove
need a registered workspace. A failed or cancelled `/resume` releases the
occupancy it acquired, so the session can be retried.

With DSH's current JSONL backend, startup and `/new` keep initial permission
events in memory until further activity saves the complete log; a session holding
only initialization is never stored, and restarting it starts fresh.

On Linux, stale TUI occupancy and mount locks can be reclaimed when the old PID
was reused by a non-leader thread, given readable `/proc` identity in the same PID
namespace. Uncertain identities stay occupied; this is not a general fix for PID
reuse.

`/btw` uses an overlay when its sidebar cannot render. Main-task questionnaires
and the fullscreen draft editor take priority while preserving the side question
and the draft.

</details>

<details>
<summary>Sessions that move, background sessions, workspace counts</summary>

On DSH, `/bg` or `←` on an empty prompt backgrounds the current session and opens
the session manager; `Esc` returns to it. Background sessions run in this process
and stop when the TUI exits; logs survive. On Claude and Codex those entries open
the manager without backgrounding the session.

When a DSH 0.2.1+ agent moves its session to another directory (the
`working_directory` tool or a Git worktree), the status line, Git branch, `@`
completion, `!` commands, clicked paths, skill commands and loaded context follow
it, including after `/resume`. The session stays registered under the project it
started in. Relative paths in cards rendered before a move resolve against the
session's current directory when clicked; absolute paths keep their target.

Workspace side-panel counts match the session manager: the current conversation
counts; empty logs, subagents, fork ancestors and archived sessions do not.
Registered workspaces with no visible conversation stay at zero. Loading and read
errors are shown separately; press `r` to refresh.

</details>

<details>
<summary>Terminal input edge cases (Windows, extended keys, sixel)</summary>

Windows Neovim/Vim terminals identified by `NVIM` or `VIM_TERMINAL` keep VT input
instead of enabling ConPTY mode 9001. For another incompatible embedded host, set
`DSH_TUI_DISABLE_WIN32_INPUT_MODE=1` before launch (PowerShell:
`$env:DSH_TUI_DISABLE_WIN32_INPUT_MODE="1"`). The gate applies at startup and
after resume. Native Windows Terminal, conhost and VS Code keep their mode unless
disabled; the opt-out can remove modified-Enter reporting.

Extended key reporting (Kitty keyboard protocol and xterm `modifyOtherKeys`) is on
for a fixed terminal list: iTerm2, kitty, WezTerm, Ghostty, rio, Orca, tmux, Warp
and Windows Terminal. A terminal missing from the list opts in with
`DSH_TUI_FORCE_EXTENDED_KEYS=1`; `DSH_TUI_DISABLE_EXTENDED_KEYS=1` opts an
allowlisted terminal back out for SSH or nested xterm.js hosts and wins when both
are set. Outside native Windows, a terminal without extended keys cannot tell
`Shift+Enter` from `Enter`, and `Ctrl+J` is the newline fallback.

On native Windows, fragmented Win32 input records are reassembled across short
delays instead of appearing as numeric protocol text. A bare `ESC[` fragment is
held only after one record has been decoded; a fragment whose shape is already
record-specific holds on its own. Terminals that never enter the mode (mintty,
GitBash) keep the classic VT path, so a lone `Esc` keeps its response time.

Incomplete records are held for a bounded window: one second from first capture,
never extended by later input, 64 bytes at most. Past either bound the hold ends.
Unrecognized complete CSI sequences are not inserted as text; after a damaged CSI
prefix a bare ASCII letter can be consumed as its terminator. A session's very
first record can still leave residue if it splits before its record-specific
shape forms; inside the window, literal input starting with `[digit;…` may be held
or re-joined to a preceding `Esc`.

Split terminal replies are reassembled the same way while a query is awaiting its
answer: an unfinished DA1 / DA2 / DSR / DECRPM / XTVERSION tail is held across
input delays, but only while its shape can still complete into the expected
response type. It is then consumed as the reply instead of entering the prompt as
protocol text. No outstanding query means nothing is claimed. The window is
bounded like the record hold; bytes still shaped like an unfinished reply prefix
are dropped rather than shown.

Fragmented SGR mouse reports no longer land in the prompt: an incomplete report
header is held until the rest arrives, and a completed report is handled as a
mouse event. The hold is armed only while mouse reporting is active (fullscreen
with tracking); inline sessions keep the existing behavior. The claim window is
one second and 64 bytes from first capture; release has no timer — once a parse
sees either bound exceeded, the held bytes replay as ordinary keys in arrival
order. Literal input can be delayed, but is never dropped.

Windows Terminal/ConPTY sixel frames check the last transmitted raster's cursor
position before parking, using measured cell geometry and encoded band controls.
Detected drift uses the same physical clear and redraw as `Ctrl+L`. Probes allow
one pending reply (500 ms), skip resize and handoff, and pause for 60 seconds
after an unanswered query or three repairs within ten seconds. Set
`DSH_TUI_SIXEL_CURSOR_HEAL=0` to disable; `DSH_TUI_DEBUG` records
probe/recovery decisions. This mitigation cannot detect every pixel corruption or
repair ConPTY itself.

While the TUI owns active raw input it reasserts OS raw mode on input-gap/focus
recovery and every five seconds without waiting for a key. That repairs externally
reset cooked/ECHO state even when Node still reports `isRaw=true`; the periodic
check stops during editor pauses and shutdown/handoff and does not resend display
protocols.

Catchable exits explicitly end synchronized output (DEC 2026) as part of terminal
cleanup, even without a final frame. SIGKILL, native aborts and a fully blocked
event loop cannot guarantee in-process cleanup.

</details>

## Goals, todos and compaction

**No goal row in the footer.** The objective, its phase and its rounds live in the
`todo` side panel, which wraps long text to the panel width. A bare `/goal` prints
the full status — objective, phase, rounds or budget, available commands — as a
transcript block in the `/plugins` shape; inline mode and narrow terminals read a
long objective there.

**Hiding is display only.** `Ctrl+Q` folds todos while working and hides or
restores the idle goal/todo footer; clicking the todo header also hides it while
idle. A new goal or todo snapshot, or a new session, brings it back, and
`/goal clear` does not clear todos.

**`/compact` holds the turn.** `restruct-plan` runs first, queued input arrives
after the compaction, and waking jobs or subagents wait in the inbox until the
cycle ends. `Esc` / `Ctrl+C` cancel the cycle, and the notice says who cancelled
it and that no compaction was made. The fork itself has a budget: at eight
minutes it is asked to wrap up and answer with its marker, at twelve it is
stopped and the compaction continues on the plan written so far.

<details>
<summary>What the compaction shows, and what it does not reset</summary>

Live Compact partial checkpoints appear as folded summaries in chat and as summary
entries in `/tree`; they do not reset the whole context composition. Occupancy
follows the host token meter. Folded previews use the durable summary with the
same `compactionId`; expanding keeps the full text, which is also the fallback
when the summary event is missing.

Compaction status stays on one line in narrow panes: phase and cancellation hints
yield first, then the label shortens; elapsed time appears only as a complete
field.

The cycle is a fork feature: job and subagent wake-ups (`followup`) wait in the
inbox instead of interrupting the compaction, and the engine receives a proxy
agent whose maintenance call is inlined. A cancelled cycle names the abort source
(`user`, `switch`, `disposed`) in its notice; a spent fork budget is not one of
them — the compaction continues on the plan written so far.

</details>

## Panels, jobs and waiting

**Side panel.** `/panel` splits the chat with a panel column once the terminal is
wide enough; `⌘/` (`Ctrl+/` off macOS) runs the three-state toggle — closed →
open and focus → chat focus → closed. The background key never opens it (see
"Waiting is never work"). Drag the divider to resize. All eight built-in panels and
later-registered plugin panels are enabled by default (`sidePanel.panels: '*'`);
untick a row in `/settings` for an explicit list. The header shows each inactive
panel's symbol — hover for the name. Narrow terminals and inline mode keep
full-screen panels.

**Waiting is never work.** A foreground call that blocks — a command, a
`job_output(wait: true)`, a delegation, a foreground workflow — can be parked with
the same key: the call returns at once, the work keeps going, and its result
arrives later. `autoBackground` (on by default) does that by itself for
delegations and workflows. For partial progress the agent calls `monitor(job_id)`,
which returns immediately and reports new output as notices.
[`docs/false-waits.en.md`](docs/false-waits.en.md) catalogs every surface that
looks like work but waits under the hood.

<details>
<summary>How the park seam works</summary>

`Ctrl+B` on a running command moves it to the background: the turn stops waiting,
the command becomes a job, its card keeps going as a job card, and the card names
the key while it runs. With nothing running the byte does nothing — the side
panel has its own combo (`⌘/`; `/panel` and a tab click do the same; remap
`sidePanel` under `/settings` → `Shortcuts`). The seam comes from the local core patch
`patch-dsh-tool-park.mjs`, applied with the other core patches outside this
repository.

A waiting `job_output` (`wait: true`) is the second wait: the same key releases
it, the read returns at once with the job's current state, and the command keeps
running (`patch-dsh-job-wait-park.mjs`).

A delegated child is the third: the key returns the delegation at once with a
`backgrounded` handoff, the child keeps running and keeps its delegation slot, and
the real handoff arrives as a message when it settles — including while the call
is still queued for a slot (the delegation plugin's `dsh.delegate-park` ticket).

A foreground `workflow` is the fourth: the key hands the run to jobs, the call
returns its job id at once, and the batch keeps fanning out
(`patch-dsh-workflow-steer.mjs`).

`autoBackground` (default on, `/settings` → Conversation) asks the same seam as
soon as a call starts waiting: the delegation or workflow returns a `backgrounded`
ack and its result follows. `off` restores the manual key.

</details>

<details>
<summary>Background job cards and the jobs panel</summary>

Card headers open the focused task panel. Click the card body or press `Ctrl+O` to
toggle the command between its first statement and the full script. Commands and
output use separate colored edges with `❯` (`>` on Windows) and `≡` on their first
rows; output always stays at the latest two visible rows. `/jobs` and the side
panel keep the full output scrollable, while `e` toggles the focused command.
Consecutive blank script lines collapse to one. `/jobs` shows status, elapsed time
and exit code, `k` kills; with the split layout and a wide terminal it opens in the
right column instead.

</details>

## Live state, notifications and cost

**Status line.** Activity animation, context bar, TPS, cache hit rate, effort,
tokens, session cost estimate (main + subagents), Git and session metadata. Title,
trajectory-strip and session-state animations update independently of the
transcript and pause when idle or unfocused. The context bar's fill follows
backend occupancy while its colors estimate content composition; compaction clears
obsolete estimates, and missing composition shows a single used block.

**Notifications.** One switch covers four moments: task completion, an approval
waiting for your decision, a question waiting for your answer, and a plan review
waiting for your decision. Only the current session's approvals notify: background
sessions and subagents stay quiet, and replay, cancellation and failures do not
notify.

<details>
<summary>Notification titles, methods and per-terminal delivery</summary>

Completion on DSH, Claude and Codex fires once live work settles, with no queued
follow-up and no active goal. Its title is “dsh-TUI · Task complete”, and the body
previews the latest reply as one plain-text line of up to 200 characters.
Approvals are titled “dsh-TUI · Approval needed” (session name, tool name, reason —
never the command); questions “dsh-TUI · Waiting for your answer” (the first
question's header and question); plan reviews “dsh-TUI · Plan review” (the
question header and question, never the plan).

`/settings` → Conversation: `taskNotifications` = `unfocused` (default),
`always` or `off`; `notificationMethod` = `auto` (default), `osc9`, `bel` or
`windows`. `auto` follows the terminal — OSC 777 on Ghostty/WezTerm, OSC 99 on
Kitty, a title prefix on iTerm2/Warp, a bell elsewhere — and resolves to the native
system toast on local Windows. There, an enabled active external DSH notification
plugin makes dsh-TUI yield completions, approvals and questions; a plan review is
always sent by dsh-TUI itself.

Delivery details, terminal requirements (tmux and the like) and `jumpBack`:
[User guide](docs/user-guide.en.md#53-the-settings-editor) and
[terminal requirements](docs/user-guide.en.md#54-terminal-requirements).

</details>

<details>
<summary>Cost and token accounting</summary>

The status bar's `≈¥` and `/cost` are session estimates that include subagent usage
(priced per agent's model × peak/idle × cache components). Unofficial or unlisted
models show tokens only and are marked unpriced. **The platform bill is
authoritative.** TPS includes hidden reasoning time and excludes tool execution
time; live text estimates are corrected when the backend reports output token
usage, and decode spans of 500 ms or less are left out of TPS samples while token
and cost totals keep all reported usage.

</details>

## Backends

**DSH (default).** The first-party backend: presets, skills, MCP, goals, todos,
subagents and questionnaires, plus the experimental session-search and worktree
presets, all loaded in the same process behind the first screen.

**Claude (experimental).** The same interface driving the Claude Code CLI through
the Claude Agent SDK: your `CLAUDE.md`, settings, hooks, MCP servers and plugins
load the way the CLI loads them.

**Codex (native, experimental).** Your own Codex through `codex app-server`,
sharing its configuration, login, instructions, skills, hooks, MCP and native
threads.

**Account sign-in.** The standard profile offers pi-ai OAuth for ChatGPT/Codex,
Claude and Grok (plus OpenAI direct and Meta Muse when available), and Host-owned
DeepSeek browser sign-in as `deepseek-account` on DSH 0.2.0-rc.1+. Use `/provider`
or `/auth` without another plugin. A profile-only update from a global TUI patch
that already mounts `dsh-tui-auth` can still start the official loopback callback
listener on demand; fixed-port SSH forwarding still needs the global package
aligned.

<details>
<summary>Claude backend</summary>

```sh
# once, in the dsh-tui profile directory (the SDK is an optional dependency)
cd ~/.dsh/profiles/dsh-tui && pnpm add @anthropic-ai/claude-agent-sdk@0.3.287
dsh-tui --backend claude     # or pick Claude in /kernel; that choice is remembered
```

The easy path is the kernel picker (the launchpad "Kernel" entry or `/kernel`):
pressing Enter on the dim Claude row locates the profile and installs the pinned
SDK; the command above is its manual equivalent. An existing Claude Code CLI,
including a Homebrew install, still needs this SDK. Without it the row keeps the
detected CLI version and says "SDK unavailable"; Enter installs it, and the
confirmation names the package and version. Closing the wizard cancels a pending
installation.

- **Sign-in**, in order: a `/channel` relay profile, your dsh-auth `anthropic`
  sign-in (`/login`), `ANTHROPIC_API_KEY` or cloud-provider variables, or an
  existing `claude login`. A `claude` on `PATH` is used when present, then one in
  the native install directory under your home (`~/.local/bin`, or
  `%USERPROFILE%\.local\bin`); each candidate must launch and report a version, and
  the SDK's bundled binary is the last resort.
- **Works**: streaming, tool cards, approvals and questions, `/model`, `/effort`,
  Claude's permission modes (`/permission`, `Shift+Tab`), `/compact`, `/context`,
  `/mcp`, `/resume`, `/fork`, double-`Esc` rewind, subagents, background jobs,
  images, `/btw`, and the USD cost Claude reports.
- **Not available**: DSH-only commands such as `/tree`, `/preset`, `/provider`,
  `/workspace`, `/agentview` and `/bg`. One process runs one backend; `/kernel`
  switches by restarting into a new session.
- **Startup**: the screen appears before the session opens, with only a light
  profile composed (this package plus the profile's third-party plugins). The DSH
  kernel starts from the same entry and loads DSH in-process behind its first
  screen; `DSH_TUI_HOST_ENTRY=0` restores the old launch path for every kernel.

Details and known limitations: [Claude backend](docs/claude-backend.en.md).

</details>

<details>
<summary>Codex backend</summary>

```sh
npm install -g @openai/codex@0.160.1
dsh-tui --backend codex
dsh-tui --backend codex --resume <thread-id>
```

Protocol baseline **0.160.1**, minimum **0.144.0**; other versions may drift.
`CODEX_EXECUTABLE` selects a binary; `/kernel` remembers the backend.
`codex resume <id>` can open the same thread after the other writer exits. This is
not `migrate codex`, which imports history into DSH.

Streaming and tool cards, approvals, questions, steer/queue/interrupt, model and
effort controls, Plan, `/review`, `/diff`, `/usage`, `/init`, skills and MCP share
the existing UI. Async questions open the questionnaire while Codex keeps working;
answers steer the turn or queue, and dismissing the question leaves work running.
**Shift+Tab only toggles Plan**, keeping its underlying permission preset; Full
Access needs an explicit choice. Existing Codex settings are respected, not
overwritten.

`/login` offers ChatGPT OAuth, a device code or an API key (the last writes to
Codex's own credential store). Relay `/channel` connections take precedence;
managed subscription tokens are injected only on first-party routes. dsh-TUI does
not write `~/.codex/config.toml` and does not log out your native Codex account.

A provider `env_key` from your own config (for example `DEEPSEEK_API_KEY`) that the
shell did not export is injected from the DSH credential store when the ref is
stored there — the active store first, then the default `~/.dsh` — so the key can
live in the store with no per-shell export. When nothing can supply it the session
still starts, and the reason is reported once; Codex itself then rejects every turn
of that provider. For Claude and Codex, `/channel` tokens (`CHANNEL_*` refs) belong
to the active `DSH_HOME` only: disconnecting cannot revive a token from the default
home.

With native credentials, a writer conflict on an idle thread kept by the official
background server triggers a reconnection to that server; managed subscription
credentials and `/channel` connections use private app-server processes.

Native browsing and archive, fork and conversation rewind (the first message needs
app-server 0.160.1+), paged history, images, subagents, polled background
terminals, goals and `/btw`/`/recap` use the existing surfaces. `/logout` removes
only the matching dsh-auth credential; already-loaded managed tokens need a normal
restart. Real subscription login, credentialed model calls and real-TTY
interaction were not run in validation; only Codex identification and title change
automatically, not palette or companion. Using ChatGPT subscription tokens in
third-party clients is subject to OpenAI's terms.

Full instructions and current boundaries: [Codex backend](docs/codex-backend.en.md).

</details>

<details>
<summary>DSH Agent Teams</summary>

Agent Teams lets the session's agent (the Lead) delegate to named subagents that
share the working directory, message each other and coordinate on a shared task
board. Since DSH `0.2.2-rc.2` it ships inside `dsh-base`: no plugin to install and
no bundle to enable. It is off per root session — `/team on` enables it for this
session and its whole subagent tree (the choice survives restarts), `/team off`
switches it off while keeping the subagents and the board. `/team` (or
`/team status`) reports the saved selection, the service and this session's
subagents; with subagents still running, `/team off` asks first (`/team off force`)
and they keep running — only the task tools and the Team guidance stop.

Members are the root session's named subagents: `subagent` / `subagent_fork` take
an optional `name` (the root is `lead`, descendants are paths such as
`reviewer/checker`) and are the delegation tools. The four `team_task_*` tools are
the shared board. Control tools address agents by name: `send_message` takes `{agent, message}`,
`interrupt_agent` takes `{agent}`, and `wait_agent` reports `{timedOut}`.
`list_agents` rows carry `{name, status, description?}`. Their calls render as
one-line cards, and a message between agents as a `✉ <sender>` bubble in the
receiving session. The agents dashboard (`Ctrl+A`) and the agents side panel show
the team view: the Lead line, members under their catalog name with `running` /
`idle`, the remaining subagents, a read-only board (status, owner, `blocked`,
write-scope warnings) and a banner when the team record was rejected. A root with
Team off still shows its read-only board with a note.

An older DSH line (`0.2.2-rc.1` and earlier) mounts the retired experimental
bundle instead: `/plugin enable` (or `disable`) with
`@deepseek-ai/dsh-experimental-agent-team-profile`, or the CLI route
`dsh plugin --profile dsh-tui add <bundle>@<dsh-version>`; `spawn_teammate` is the
delegation tool, and the switch covers the whole profile rather than one session. Those packages pin their peers exactly, so versions must match.

Limits: there is no "enter teammate session" yet, and `/export` leaves team
messages out. Teammates share one working directory, a team lives in one process,
and a task owner is never released automatically. Upgrade every process that opens
the same session store together: catalogs written by `0.2.2-rc.2` subagents cannot
be opened by older DSH.

A delegation provider whose settled runs fail at least twice and at least half the
time gets one degraded-channel line above the agents list; the built-in `subagent`
route, workflow members and per-type Claude children are excluded because there is
no provider to switch to.

Subagent failure badges and the Companion error state share session-scoped unread
status: opening that child's detail acknowledges only that failure, a new run or
failure alerts again, and a cold restart starts unread. Opening the dashboard alone
does not acknowledge every child; task status stays failed.

</details>

## Configuration and permissions

**Settings.** `/settings` groups its sections into pages: the TUI's own settings
sit under **General**, and plugins that declare a page get their own tab. The
`dsh-tui` section is saved in `~/.dsh-tui/settings.json`, shared by every kernel;
the first launch imports it once from the profile's `cordis.patch.yml` (and an
older host's `~/.dsh/settings.yaml`).

**Language.** `/lang` switches the interface between English and Chinese and
persists the choice; documentation and code comments are English only.

**Permissions.** dsh-TUI has no sandbox of its own: the active DSH profile owns
the filesystem, shell, sandbox and approval policies, and presets come from the
`permissionPresets` registry. A durable `/permission` pick is remembered per
backend and applied to sessions that never customized their own planes.

> **Windows warning:** the Windows profile defaults to `danger-full-access` with
> approval set to `never`, so tools have unrestricted access. Inspect and tighten
> the profile before starting next to sensitive credentials or in an untrusted
> repository.

**Plugins.** `/plugin install <package | path | git url>` goes through the host's
profile plugin manager: a pre-install notice, a trust confirmation, cancellable
progress, build-script approval and exact-version exemptions. `/plugin remove`,
`/plugin enable` and `/plugin disable` manage what is installed; the TUI refuses
the three ways it could switch itself off.

<details>
<summary>Settings pages, model effort and panel identity</summary>

On DSH 0.2.1-rc.2 and later, `/settings` also selects DeepSeek Search / Fetch APIs
and edits their endpoint and result limits, with custom Loader entry IDs and a
masked API key saved through DSH's credential store. Official Flash model labels
show the `1017` release marker while keeping the `deepseek-flash` model ID.

On DSH 0.1.7, `/settings` uses the TUI's actual Loader entry ID, including custom
IDs, and needs matching `@deepseek-ai/schemastery` 3.18.3 or newer; an
incompatible schema stops startup with repair guidance instead of showing an
uneditable page.

The default reasoning-effort setting offers the current backend or model's
declared tiers, including custom IDs. Saved values missing from that catalog stay
visible and stored; while loading or unavailable, only Auto is selectable. On DSH,
Auto follows the saved `/effort` choice, then the configured effort, then the model
default. Claude and Codex keep backend preferences for Auto at startup and for
resumed sessions; explicitly choosing Auto resets the model default. Explicit
changes affect the next request, unsupported preferences fall back with a notice
and are never forced onto a route. Resuming a DSH session preserves its recorded
effort (or the live selection when reattaching); the saved default seeds new
sessions.

Panels without a verified Component identity are temporary: settings show their
title and a distinct number for this run, their toggles take effect immediately
without being saved, and unrelated settings changes preserve that choice. Old
`actN:panel` entries cannot be mapped safely — remove the placeholder and select
the current panel again. Verified Components named `actN` keep their public
runtime address; an explicit selection stores `component:actN:panel` so an old
anonymous entry is never claimed.

Plugin side panels stay enabled when unrelated settings change; editing the
enabled panel list still applies your explicit selection.

</details>

<details>
<summary>Account notices, search APIs and reporting</summary>

DSH account notices use the existing account card: a notification with complete
coupon metadata keeps the coupon presentation, otherwise the card shows the
server's title and message without inventing an amount. The card refreshes its
language and follows the server's display deadline; `Enter` or `Esc` dismisses it,
and account-page actions point to the official DSH account page instead of running
inside this TUI. Older hosts keep their original bonus API.

DSH profiles inherit official reporting defaults: DeepSeek API requests carry
plugin package identities and incremental session logs to the configured
`baseURL`, including third-party gateways, while OpenTelemetry uploads a session
log prefix only after explicit feedback. User overrides stay supported — see
[reporting settings](docs/configuration.en.md#official-request-metadata-and-feedback-reporting).

With the DeepSeek brand, the Companion skins `deepy` and `whaleGirl` replace the
maid portrait; choose `whale` and enable Maid portrait to use it. Claude uses its
own artwork, Codex its own raster portrait or the maid character-art fallback.
Both brands ignore these settings for splash artwork. See
[Configuration](docs/configuration.en.md).

</details>

<details>
<summary>Permission persistence and the experimental presets</summary>

**Persistence** works on all three backends: Claude and Codex keep `/permission`
picks in `~/.dsh-tui/backends/<id>/prefs.json`, DSH in
`~/.dsh-tui/permission.json`. Every durable preset switch teaches it — picker,
typed `/permission`, `Shift+Tab` static modes, or a switch the official command
performed itself — and a session that never customized its permission planes
starts on the remembered preset through the same official path. A composition's
own default written at session creation does not count as a user choice, plan-mode
transients and the Auto review preset are excluded, a `DSH_PERMISSION_MODE` launch
pin outranks the file, and an identity the mounted roster no longer offers is
skipped.

**Auto review** (DSH, experimental): `/plugin list` advertises it; after
`/plugin enable @deepseek-ai/dsh-experimental-auto-review` the `auto` preset
appears in `/permission` tagged `EXP`. Session-only: the model reviews every tool
call before it runs, there is no file sandbox, and each call costs one extra model
request. Its approval prompts show the localized reason, and a subagent denial
reads "Auto review denied; not executed". Picking it first shows a risk
confirmation (`Enter` enables, `Esc` goes back, its rows are clickable in
fullscreen); a typed `/permission auto` switches directly, and once selected the
picker skips the confirmation.

**Session search** (DSH, experimental): after
`/plugin enable @deepseek-ai/dsh-experimental-session-search` an agent gains five
read-only tools over earlier sessions in the same workspace — `session_search`,
`session_event_search`, `session_trace`, `session_event_trace`,
`session_event_read`. Cross-session access needs an identical `cwd`. The index is
in memory and is built on the first search; nothing is written to disk. The kernel
Minimal preset keeps its single persistent-shell tool, so it never shows them.

**Git worktrees** (DSH, experimental): after
`/plugin enable @deepseek-ai/dsh-experimental-tool-worktree` an agent gains
`create_worktree`, which creates a branch and a checkout under
`.agents/worktrees/<name>` (from `HEAD` or a local revision; uncommitted files stay
in the source checkout) and moves the session into it. The status line, Git branch
and `@` completion follow while the session stays registered under its project;
its card reads `Worktree("<branch>")` with the path and base revision. Nothing is
cleaned up: remove the checkout with `git worktree remove <path>` and the branch
with `git branch -D <branch>`; a leftover branch makes a later `create_worktree`
with the same name fail. Calling it inside a worktree nests the new checkout.
Minimal and the bundled liangshen preset hide it, because their persistent shell
keeps the directory it started in.

**Upstream auto-retry** (DSH): whenever a session binds (boot, `/model` switch,
resume) the TUI seeds a retry policy — 5 attempts, transport-drop-aware failure
codes including `STREAM_CLOSED` — on the provider route that session actually
uses, through the official `llm-pi-ai` settings section executed by the kernel's
`llm-retry` plugin. Only routes without an explicit `retryPolicy` are seeded, so
dormant channels are never written; `upstreamRetry: false` in `cordis.yml` opts
out.

Details: [Permissions and security boundary](docs/architecture.en.md#permissions-and-security-boundary).

</details>

<details>
<summary>Plugin install, lifecycle and grants</summary>

Plugin development:
[admission and development guide](tui-profile/docs/plugin-admission-and-development.md)
· [plugin-template](https://github.com/dsh-tui-ecosystem/plugin-template) ·
[dsh-tui-ecosystem](https://github.com/dsh-tui-ecosystem). Reference
implementation: `dsh-working-activity`. Seam grading and API notes:
[Plugin development](docs/plugins.en.md). The organization maintains the listing
only; it does not endorse community plugins.

Exported plugin subcomponents are admitted using the nearest package manifest of
their ESM entry, including import-only and conditional exports; they do not
inherit an outer package's identity.

A backend plugin (the `tui.dsh/v1alpha1` `Backend` contribution family) appears in
the kernel picker after a restart: the boot scans the bundles the profile declares,
admits each package-root `dsh-plugin.json` declaration and reads the implementation
from the package's `backend` export, importing that module only when the backend is
selected. Each bundle may declare one backend, and its handler id must match the
declaration. Entries awaiting authorization are neither probed nor loaded.

`/plugin install` accepts three shapes:

```sh
/plugin install /path/to/repo
/plugin install https://github.com/exam/ple.git
/plugin install @scope/package@1.2.3
```

They are examples, never candidates: `Tab` leaves the draft as typed and `Enter`
runs your line; the same shapes follow installed names on `/plugin info `. The
same actions stay available from the CLI (`dsh plugin --profile dsh-tui …`).
Packages on the first-party feed
(`tui-profile/feed/first-party.json`, pinned per release and decided offline) skip
the trust confirmation, but only a spec naming that exact version qualifies — a
bare name, tag or range is resolved again and confirmed. What was confirmed is what
gets installed — the run pins the exact `name@version` it inspected — and a running
turn refuses the install (finish it or `/new`
first). The confirmation lists declared permissions: `Enter` installs **and
grants**, writing the grant to `~/.dsh-tui/extension-grants.json` before the
install starts, and a failed install rolls that write back. A registry package's
declaration cannot be read before it lands, so a `grant` step follows a successful
install: `Enter` grants, `Esc` skips (the install stays). Unknown declared
permissions are skipped and named. On a terminal too short for a permission row,
the list folds to a count or the key hint carries it.

Installation accepts `esc` as cancellation and keeps the pane open until the
write settles; if cancellation is too late, it waits for the installation to
finish. Failed installs show up to six redacted log lines; lines over 16 KiB are
omitted with a notice.

`/plugin remove <bundle>`, `/plugin enable <name | row id>` and
`/plugin disable <name | row id>`: a bundle is a composition layer, a row is one
patch entry, so the two are separate actions, and a bundle name matches before any
row identity. A module name shared by several rows needs a specific row ID. **Gate
2 refuses the three ways this app could switch itself off** — removing or
disabling the bundle that provides it, the host layer `dsh-base`, or one of its own
rows — and names the rule it broke without calling the service, whether or not hot
reload is live. `enable` is never refused (it is the repair action). Every enable
and removal asks first; `disable` asks only about a host-layer row. The host does
not attest installed package sources, so even an exact feed match needs
confirmation.

These actions have no cancellation — the service offers none — so `esc` only
closes the pane while the write finishes and reports itself into the transcript;
there is no CLI verb either. **Grants follow the lifecycle**: `enable` enables and
grants the declared permissions, `disable` disables and revokes them, and `remove`
deletes the component's `grants`/`denies` entries — grants are keyed by component
id, so leftovers let any later package reusing that id inherit them silently.
Backend data directories, storage namespaces and the effect ledger stay, and the
residue report names each source by its path. A failed grant write never blocks an
install or enable; it is reported. Grants are behavioural constraints, not a
security boundary.

`/plugin list` also advertises the experimental features DSH ships and this app
knows how to drive — currently Auto review, Session search and Git worktrees —
each with its switch and usage line. A DSH installation that does not ship one
shows no such section. Agent Teams is no longer one of them: `0.2.2-rc.2` builds it
into `dsh-base`, so it is switched per session with `/team on|off`.

</details>

## How it works

```text
dsh profile → dsh-base → dsh-TUI Cordis patch → agent preset + DSH services
  → session/event → Channel projection → React components → Ink/Yoga renderer → terminal
```

The TUI owns interaction and presentation. The session log is the source of truth.
DSH services own models, tools and persistence. Long sessions render in
O(visible window). Runtime paths, module boundaries, performance notes and
persistence locations: [Architecture and limitations](docs/architecture.en.md).

## Known limitations

- **`@` completion is cached.** A menu refreshes on the next query after its
  two-second cache expires; path-shaped queries such as `@src/` read the directory
  directly. Scan budgets stay at 100 files and 100 directories.
- **`/model` changes the next request.** History and session ID are preserved and
  the last used route is recorded when the next request starts. On DSH `0.2.2`,
  API and plugin selections also update the next-model readout; late events from a
  previously fixed step do not overwrite the selected model's metadata. DSH before
  `0.1.2-alpha.3` refuses switching because its subagents inherit the original
  route.
- **The `minimal` kernel preset is minimal.** It has one persistent-shell tool,
  mounts no compaction and does not prune tool results: a long session can hit the
  context limit, oversized tool output stays in full, and `/compact` plus the
  questionnaire are unavailable. This is not the `/settings → Minimal UI` display
  switch.
- **Costs are estimates.** The status bar's `≈¥` and `/cost` include subagent
  usage; unlisted models show tokens only. **The platform bill is authoritative.**
- **A background session lives in this process** and stops when the TUI exits;
  its logs survive.

<details>
<summary>Full limitations list</summary>

- Injected plugin context has no standalone display; it counts into the context
  segments.
- `/thinking` is not persisted.
- `/update` needs a `dsh --profile` launch and is refused while a turn is running.
- `Ctrl+V` needs platform clipboard tools; unsupported bitmap formats are
  rejected.
- A dropped file is restored from its OSC 8 `file://` URI alone. Multi-file drops,
  non-Windows drop encodings and terminator-less truncated frames are not covered,
  and the hyperlink's display name is never used.
- Fragmented SGR mouse reports are covered at the mechanism level with controlled
  fixture comparisons; the reporter environments (macOS → SSH, WSL2 with
  `dsh web`) have not been re-tested.
- Windows Terminal/ConPTY sixel healing is bounded: it cannot detect every pixel
  corruption or repair ConPTY itself.
- Local Windows copying depends on PowerShell; OSC 52 remains the fallback and
  needs terminal support.
- Terminal shutdown drains only the renderer-owned input after a 150 ms settle
  window. Embedders keeping only `unmount` keep that lease, and wrappers replacing
  the method must pass the renderer's `shutdownInput` lease to `finishExit`; a
  custom input drains its own buffered bytes, and a device-specific kernel drain
  can be supplied as the bounded synchronous `render({ drainStdin })` callback.
  Revoked or replaced owners and non-TTY input are not drained.
- SIGKILL, native aborts and a fully blocked event loop cannot guarantee in-process
  terminal cleanup.
- The raw-mode reassert runs every five seconds while the TUI owns input, so
  recovery after an external reset can take one interval.

</details>

## Development

```sh
pnpm install --frozen-lockfile   # pnpm 11, Node 24 (CI), package supports ^22.19 || >=24
pnpm build                       # compile + every build gate
pnpm typecheck
pnpm smoke                       # headless screen assembly
pnpm dev                         # full install/build/pack cycle
```

The repository has no root `test` or `lint` script. The static gate is the
TypeScript build; behavioral verification uses focused regressions and reproduction
environments. Most `node scripts/…` entry points import `lib/types/`, so build
first; scripts that import TypeScript source declare `node --import tsx/esm`.
Rendering, questionnaire and tool-card changes also need their matching regression
scripts. `lib/types/` is ignored generated output — edit `src/`, never `lib/`.

<details>
<summary>Working on this fork</summary>

- **Remotes.** `mine` = `mkdir-username/dsh-TUI` (personal, public since
  2026-11-12; every push is immediately visible). `origin` = `ccch1mneyyy/dsh-TUI`,
  read-only for us — fetch and merge mainstream from it, never push.
- **Branches.** Work in a worktree, not on a branch created inside the main
  clone: `git worktree add ../dsh-tui-<task> -b <type>/<task>`. Merge upstream
  into `main` and let the fork win every conflict: a merge may drop an upstream
  nuance, never a fork feature.
- **Commits.** Atomic, English past tense, `type(scope): description`, no AI
  attribution. Stage explicit paths only. After verification, commit and push to
  `mine main`.
- **Gates.** `pnpm verify:build` (boundaries, contracts, patch surface, plugin
  checks), `pnpm verify:boundary`, `pnpm verify:source-hygiene`,
  `pnpm verify:contract`, `pnpm verify:package`. Fork probes:
  `verify:ctrl-enter-steer`, `verify:compact-queue`, `verify:compact-hold`,
  `verify:compact-rp`, `verify:tool-park`, `verify:false-waits`, and
  `node --import tsx/esm scripts/verify-handoff-skip.tsx`.
- **Docs.** English only, `docs/*.en.md`, never a second language. Keep behavior,
  configuration, shortcuts and limitations in sync across `README.md` and the
  docs set. `CLAUDE.md` is a symlink to `AGENTS.md`.

</details>

<details>
<summary>Running this tree on its author's machine</summary>

Author-local tooling lives outside the repository; nothing here is required to
build or read the fork.

- The `dsh-tui` profile depends on this checkout by link, so the TUI comes from
  `pnpm compile` output: `~/.dsh/profiles/dsh-tui/package.json` →
  `"@deepseek-harness-tui/dsh-tui": "link:$HOME/Docs/dsh-tui-fork"`.
- A managed release runs from `~/.dsh/runtime/current`, not from the working tree:
  `node ~/.dsh/bin/dsh-runtime.mjs prepare --candidate` compiles a candidate;
  `proof --release <candidate> --out <proof.json> --acceptance stop-retry` accepts
  it; `publish` takes `--expect-current`, `--expect-generation`, `--release` and
  `--proof` and switches to the candidate; `status` and `rollback` are the way
  back.
- Core patches (`bin.js` import guard, TLS guard, transport errors, plan-mode,
  working-directory recovery, the park seams) are applied by
  `~/.dsh/bin/patch-dsh-tui.sh` and friends, not by this repository. The parity
  gate is `~/.dsh/bin/verify-fork-parity.mjs`.
- Reverting to the registry package: restore `package.json` from
  `package.json.bak-registry` in the profile and `pnpm install`.

</details>

<details>
<summary>Development host details, heap watch and fast mode</summary>

`pnpm dev` keeps the full install/build/pack checks by default. For explicit local
iteration set `DSH_TUI_DEV_FAST=1` (for example
`DSH_TUI_DEV_FAST=1 pnpm dev -- --no-launch`): a miss runs frozen install,
`compile`, pack without repeating `prepare`, and isolated profile installation; an
unchanged hit skips all four only while source and config, compiler-loader
contents, Node/pnpm/npm/dsh versions, compiled and vendor output, the tarball and
the installed package or profile match. Replacing pnpm/npm/dsh without changing
its reported version needs one normal run. Internal document links such as
`CLAUDE.md -> AGENTS.md` are fingerprinted; external, excluded, dangling or cyclic
links and unreadable inputs disable reuse with a diagnostic, and a failure
invalidates the success stamp before work begins. Fast mode does not change
release gates.

The monorepo development host (`pnpm tui`, `scripts/run.ts`) enables heap forensics
only with `DSH_TUI_HEAP_WATCH=1`: it samples every 15 seconds and takes one
snapshot at each threshold of 1024, 1536, 2048, 2560 and 3072 MiB. Its own
completed files in `$DSH_HOME` keep at most four 64-KiB logs and two snapshots totaling 1024 MiB;
`DSH_TUI_HEAP_MAX_MB` (1–16384) changes the snapshot budget. Snapshot creation
blocks and uses extra memory and disk space; this does not fix memory leaks. Files
use a `dsh-tui-heap-watch-` prefix; incomplete `.writing` files are removed only
after their owner PID is confirmed absent, and cleanup failures are nonfatal.

TUI entry points use production React even when the workspace sets
`NODE_ENV=development`. For renderer debugging set `DSH_TUI_REACT_DEV=1`
(`DSH_TUI_REACT_DEV=1 pnpm dev` or `DSH_TUI_REACT_DEV=1 pnpm tui`);
instrumentation can accumulate memory in long sessions.

The launcher checks the manifest's Node range before loading. Known unsupported
versions, including Node 23 and prereleases, stop with upgrade instructions;
missing or unrecognized ranges allow startup for compatibility with migrated
launchers, and `doctor` reports that it cannot be determined. `help` and `version`
always work.

**Git URL installs are not supported.** The source manifest keeps `@dsh-std/*` as
workspace deps and `vendor/dsh-std` as a submodule; pnpm ≥11 also refuses git-hosted
`prepare` scripts. Install the registry package instead:
`dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui`.

</details>

<details>
<summary>Storage migration, read budgets and bounded updates</summary>

The SQLite migration script uses the official `node:sqlite.backup()` API on
supported Node 22.19+ and Node 24+ builds. It probes that capability before
opening the source read-only and includes committed WAL data in a consistent
snapshot; it never copies a live database/WAL pair by hand. A build missing the
API reports a migration-specific prerequisite. Session-tree reads validate packed
rows and check their member count against the remaining scan budget before
expanding events: oversized rows report truncation, malformed rows report failure,
and the logical budget does not remove physical JSON or frame parsing.

Development `@deepseek-ai/*` release-age exceptions list only exact package
versions from the current lockfile (including the legacy SQLite island); all other
versions keep the 24-hour delay. Regenerate with
`node scripts/verify-release-age-cohort.mjs --write` after an intentional lockfile
update and review the cohort diff.

`/update` and `dsh-tui update` give each installer invocation, profile and engine
alike, a **30-minute wall-clock limit** (`DSH_TUI_UPDATE_TIMEOUT_MS`, milliseconds;
invalid values use the default). Output activity does not reset the deadline, and
only the final exit code establishes success — a printed `Done` does not. `Ctrl+C`
cancels the owned installer: on POSIX it terminates its process group and
force-kills remaining descendants after two seconds; Windows uses a PowerShell and
native supervisor with a private Job Object, where the installer joins while
suspended and verified membership is required before it runs. The supervisor keeps
the job handle after the root exits, so cancellation and timeout also terminate
orphaned descendants holding output pipes; it does not enable job breakaway or
kill by name. Windows needs Windows 10 / Server 2016 or later with `Add-Type` and
native interop available. Startup or membership failures stop the installation
before an unowned installer runs; a cleanup failure is reported as unconfirmed,
never as proof that writes stopped. Timeout, cancellation or unconfirmed cleanup
returns nonzero and prevents retries, stale-file removal, repair and TUI
replacement, and a partial installation may remain — check or repair that profile
before using the recovery command printed at start and on failure.
`~/.dsh-tui/restart.log` records installer category, PID, termination reason and
the last output timestamp before any restart.

The **Windows installer process ownership** workflow runs the native regression on
`windows-latest` with Node 24 and no dependency installation; locally on Windows
it is `node scripts/verify-update-process-windows.mjs`. It covers orphan
descendants, timeout and cancellation, nested jobs, failure diagnostics, streams,
arguments and an unrelated process; a Linux run skips native acceptance.

</details>

## Documentation

- **Start** — [Getting started](docs/getting-started.en.md) · [VS Code](docs/vscode.en.md)
- **Use** — [Keys and commands](docs/interaction.en.md) · [User guide](docs/user-guide.en.md) · [Themes](docs/themes.en.md)
- **Configure** — [Configuration](docs/configuration.en.md)
- **Internals** — [Architecture and limitations](docs/architecture.en.md) · [Session mounting](docs/session-mount-runtime.en.md)
- **Plugins** — [Admission and development](tui-profile/docs/plugin-admission-and-development.md) · [Seams](docs/plugins.en.md)
- **Contribute** — [Contributing](docs/contributing.en.md) · [Roadmap](docs/roadmap.en.md) · [Community](docs/community-management.en.md)

Everything: [docs/README.en.md](docs/README.en.md).

Fork notes: [`LOCAL-FORK-NOTES.md`](LOCAL-FORK-NOTES.md) ·
[false waits](docs/false-waits.en.md) ·
[upstream reference map](docs/references.en.md).

## Credits and license

- **[ccch1mneyyy/dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)** is the upstream
  project this fork tracks: core development and maintenance by
  [ccch1mneyyy](https://github.com/ccch1mneyyy), with CikeSeven, T-Auto,
  AdamPlatin123 and Nagi-ovo. Upstream is featured by the DeepSeek Harness
  community and listed in the [dshfind](https://dshfind.com/en/plugins/ccch1mneyyy/dsh-TUI)
  directory.
- The pixel whale's 22 hand-drawn frames and its idle behaviors — fin flutters,
  tail thumps, sleep Z's, click hearts — are ported from
  **[dsh-ui-whale](https://github.com/lhh010/dsh-ui-whale)** by
  [@lhh010](https://github.com/lhh010), BSD-3-Clause.
- Please read the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.en.md)
  before taking part.

[MIT](LICENSE)
