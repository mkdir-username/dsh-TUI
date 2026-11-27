# False waits

A call that looks like work but waits under the hood. "Waiting" is not "work": the card keeps
spinning, the status line keeps the last step's tps, and the turn does not move. The class says what
a human and the agent may do about it.

| surface | where it shows | what actually happens | how long | class | detach |
|---|---|---|---|---|---|
| `job_output-wait` | read card "Read output from background job …" | `jobs.wait`: settlement, timeout, or a user steer | up to 10 min (`timeout_ms` clips 900000→600000) | JOB | ⌘B / Ctrl+B on the waiting card |
| `bash-foreground` | terminal card `❯ command` | the foreground call waits on its process (`waitOnJob`) | as long as the command runs | PROC | ⌘B / Ctrl+B (core patch `patch-dsh-tool-park.mjs`) |
| `delegate-wait` | delegation card (`delegate`, `delegate_fork`) | the call awaits the child's result inside the delegation plugin; the child holds a delegation slot meanwhile | up to 15 min (`delegateTimeoutMs`) | TREE | automatic (settings `dsh-tui.autoBackground`, on by default); ⌘B / Ctrl+B as the manual fallback (plugin seam `dsh.delegate-park`), also while the call is still queued for a slot |
| `heavy-slot` | terminal card | the slot queue waits for the machine to calm down, then the run | up to 9 min of queue | PROC+QUEUE | ⌘B after it started; the right path is `run_in_background` |
| `workflow` | workflow card with phases | waits for every subagent of the batch; the run keeps going after the call returns | minutes | TREE | automatic (settings `dsh-tui.autoBackground`, on by default); ⌘B / Ctrl+B as the manual fallback (core patch `patch-dsh-workflow-steer.mjs`, symbol `dsh.workflow-park`) |
| `job_kill` | read card | `stopping` until the producer actually stops | seconds | SHORT | — |
| `ask_user_question` | question dialog | waits for a human; `pending` is not a skip | unbounded | HUMAN | answer / Esc |
| `mcp-long-call` | tool card (`gemini_ask`, `session_prompt`, deploys) | network wait bounded by the configured deadline | 60–180 s | NET | only by lowering the deadline |

A legitimate wait: `job_output` with `wait: true` and a timeout of 120 s or less — short polling, and
the hook lets it through.

## Who ends a wait, by class

The TREE class is the one that used to hold the turn until a human found ⌘B: a delegated child
or a workflow batch keeps working while the call waits for it, and nothing in the tool moves the
turn on. Settings `dsh-tui.autoBackground` (on by default) now asks the same park seam the key
asks, by kind — `parkDelegation` / `parkWorkflow`, never a shell wait — so the turn continues and
the handoff or job id arrives afterwards. `off` leaves the manual key as the only exit.

The other classes have their own exits and are deliberately not auto-parked:

- PROC (`bash-foreground`): the tool promotes the call to a job when its own timeout expires
  (`promoteOnTimeout`), and the key is the "now" accelerator.
- JOB (`job_output` wait): the model asked to wait and chose the timeout; releasing it behind its
  back would contradict the call.
- NET (`mcp-long-call`): bounded by the configured deadline; the core tool's result schema has no
  room for a synthetic ack, so there is no seam to ask.
- HUMAN (approvals, `ask_user_question`): the human is the blocker, not the TUI.

## Patterns without an anchor

These are commands, not surfaces, so they have no code anchor to check:

- `sleep N` in the foreground instead of `run_in_background` — the wait guard rejects N ≥ 2.
- A "check again in a couple of seconds" loop — the same `sleep`; use `run_in_background` + `monitor`.
- `tail -f` without `run_in_background` — hangs until Ctrl+C; use `run_in_background` + `monitor`.

## Why this list exists

The observed incident: a session held the turn for 10 minutes on a `job_output(wait: true,
timeout_ms: 900000)` card (the harness clips the wait to 600000) while a `heavy-slot bats` run with
908 cases kept going in the background. Nothing was being generated, so the status line kept showing
the last step's speed — 425 tps next to a card that had not produced a token for eight minutes.

`scripts/verify-false-waits.ts` keeps the table honest: every surface above must have its row and a
live anchor in the code that performs the wait.
