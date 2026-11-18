# False waits

A call that looks like work but waits under the hood. "Waiting" is not "work": the card keeps
spinning, the status line keeps the last step's tps, and the turn does not move. The class says what
a human and the agent may do about it.

| surface | where it shows | what actually happens | how long | class | detach |
|---|---|---|---|---|---|
| `job_output-wait` | read card "Read output from background job …" | `jobs.wait`: settlement, timeout, or a user steer | up to 10 min (`timeout_ms` clips 900000→600000) | JOB | ⌘B / Ctrl+B on the waiting card |
| `bash-foreground` | terminal card `❯ command` | the foreground call waits on its process (`waitOnJob`) | as long as the command runs | PROC | ⌘B / Ctrl+B (core patch `patch-dsh-tool-park.mjs`) |
| `heavy-slot` | terminal card | the slot queue waits for the machine to calm down, then the run | up to 9 min of queue | PROC+QUEUE | ⌘B after it started; the right path is `run_in_background` |
| `workflow` | workflow card with phases | waits for every subagent of the batch | minutes | TREE | none: the batch result *is* the answer |
| `job_kill` | read card | `stopping` until the producer actually stops | seconds | SHORT | — |
| `ask_user_question` | question dialog | waits for a human; `pending` is not a skip | unbounded | HUMAN | answer / Esc |
| `mcp-long-call` | tool card (`gemini_ask`, `session_prompt`, deploys) | network wait bounded by the configured deadline | 60–180 s | NET | only by lowering the deadline |

A legitimate wait: `job_output` with `wait: true` and a timeout of 120 s or less — short polling, and
the hook lets it through.

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
