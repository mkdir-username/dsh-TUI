/**
 * Core half of the workflow park seam, exercised on the module the runtime
 * actually boots: the patched `@deepseek-ai/dsh-tool-workflow` from the current
 * release snapshot. Three facts the text check cannot see:
 *
 *  - a foreground call publishes its ticket while it waits;
 *  - asking the hub once makes the call return a `background` result with the
 *    job id, and leaves the run alive (a parked run keeps going);
 *  - the ticket is gone from the hub after the ack.
 *
 * The TUI half (key -> `parkAnyWorkflow` -> toast) is pinned by
 * `scripts/verify-tool-park.tsx`; only the physical keypress is left to a human.
 *
 * Run: node --import tsx/esm scripts/verify-workflow-park-core.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = homedir()
const MODULE = resolve(HOME, '.dsh/runtime/current/packages/fs', HOME.slice(1), '.bun/install/global/node_modules/@deepseek-ai/dsh-tool-workflow/lib/index.js')
const PARK = Symbol.for('dsh.workflow-park')

if (!existsSync(MODULE)) {
  console.log(`SKIP: no release snapshot at ${MODULE} — run this after \`dsh-runtime.mjs prepare\``)
  process.exit(0)
}

// Drop a hub installed by an earlier import in this process: the module
// assigns it once, at evaluation.
delete globalThis[PARK]
const { apply } = await import(pathToFileURL(MODULE).href)

function deferred() {
  let settle
  const promise = new Promise((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

/** The smallest plugin context the module needs: fake engine, fake jobs, no event bus. */
function makeContext(name) {
  const definitions = []
  const started = []
  const outcome = deferred()
  const run = {
    id: `run-${name}`,
    meta: { name },
    cancelled: false,
    result: outcome.promise,
    dispose: async () => {},
    cancel() {
      run.cancelled = true
    },
  }
  const jobs = {
    started,
    start(entry) {
      started.push(entry)
      entry.run({ updateProgress() {}, append() {} })
      return 'job-1'
    },
  }
  const ctx = {
    systemPrompt: { section() {}, getSectionOrder: () => 0 },
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
    on: () => () => {},
    get: (service) => (service === 'jobs' ? jobs : undefined),
    logger: { warn() {} },
    workflowEngine: { start: () => run },
  }
  return { ctx, definitions, jobs, run, outcome }
}

function makeExec(callId) {
  const agent = { id: 'root', session: { id: 'root', append: () => true }, inbox: { nextStep: [] } }
  return { agent, signal: new AbortController().signal, callId, parent: undefined }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

const { ctx, definitions, jobs, run, outcome } = makeContext('probe')
apply(ctx, { toolName: 'workflow', maxResultChars: 4_000, enableRunInBackground: true })
assert.equal(definitions.length, 1, 'one tool registered')
const tool = definitions[0]
assert.equal(tool.name, 'workflow')

const hub = globalThis[PARK]
assert.ok(hub !== undefined, 'the patched module publishes the park hub on first load')
assert.equal(typeof hub.requestAny, 'function')

// ── a waiting call answers one ask and hands the run to jobs ────────────────
const call = tool.execute({ script: 'return 1', meta: { name: 'probe', description: 'park probe' } }, makeExec('call-wf'))
await tick()
const ticket = hub.requestAny()
assert.deepEqual(ticket, { callId: 'call-wf', label: 'probe' }, 'the ticket names the call and the workflow')
const ack = await call
assert.equal(ack.kind, 'background', 'the call returns an ack instead of the batch result')
assert.equal(ack.jobId, 'job-1', 'the ack carries the job id')
assert.equal(jobs.started.length, 1, 'exactly one job owns the run')
assert.equal(run.cancelled, false, 'a parked run is not cancelled')
assert.equal(hub.requestAny(), null, 'the ticket is gone after the ack')

// ── the parked run settles later, under the job ─────────────────────────────
outcome.settle({ stopReason: 'completed', agentsStarted: 2, value: { ok: true } })
await tick()

console.log('PASS workflow park core: ticket published, ack carries the job id, run left alive, hub drained')
console.log('All workflow park core checks passed.')
