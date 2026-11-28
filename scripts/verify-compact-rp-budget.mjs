/**
 * Behavioural check of the restruct-plan time budget: the real Channel through
 * createChannel with fake subagents and a fake compaction engine, plain node
 * against the compiled lib.
 *
 * - scene A: the fork never settles — one wrap-up steer at the soft mark, the
 *   hard mark stops it through the budget's own controller, and the compaction
 *   still runs on the plan written so far (a spent budget is not a failed cycle);
 * - scene B: a host without `sendMessage` — the steer is skipped and the stop
 *   still bounds the fork;
 * - scene C: the fork ends with RP_DONE before the soft mark — no steer, no
 *   stop, no budget note.
 *
 * Both windows are compressed through DSH_TUI_RP_SOFT_BUDGET_MS and
 * DSH_TUI_RP_HARD_BUDGET_MS, the seam the channel reads for this regression.
 *
 * Run with plain node after a build:
 *   node scripts/verify-compact-rp-budget.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistenceModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { settled } from './lib/term-test.mjs'

const JsonlSessionPersistence = 'default' in JsonlSessionPersistenceModule
  ? JsonlSessionPersistenceModule.default
  : JsonlSessionPersistenceModule

const SOFT_MS = 80
const HARD_MS = 200
process.env.DSH_TUI_RP_SOFT_BUDGET_MS = String(SOFT_MS)
process.env.DSH_TUI_RP_HARD_BUDGET_MS = String(HARD_MS)

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-rp-budget-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'handled' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'handled' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** One channel per scene: the fake services own their own counters. */
async function makeWorld(scene, { sendMessage = true } = {}) {
  const record = { steers: [], disposed: 0, compactions: 0 }
  const fork = Promise.withResolvers()
  /** The real engine takes a while; holding it keeps the post-stop row
   *  observable instead of racing the poller for one microtask. */
  const gate = Promise.withResolvers()
  const subagents = {
    getProvider: name => name === 'fork' ? { name } : undefined,
    startActivation() {
      return Promise.resolve({
        result: fork.promise,
        childId: `child-${scene}`,
        dispose: async () => { record.disposed += 1 },
      })
    },
  }
  if (sendMessage) {
    subagents.sendMessage = async (_sender, id, content) => {
      record.steers.push({ id, text: content.map(part => part.text ?? '').join('\n'), disposed: record.disposed })
      return { messageId: `m-${record.steers.length}` }
    }
  }
  const compaction = {
    async compactNow() {
      record.compactions += 1
      await gate.promise
      return { shadowedSeqs: [] }
    },
  }
  const ctx = new Context()
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  ctx.provide('subagents', subagents)
  ctx.provide('compaction', compaction)
  const handle = await ctx.agents.create({
    sessionId: `rp-budget-${scene}`,
    cwd: root,
    agentOptions: { provider: 'scripted', model: 'scripted' },
  })
  const channel = createChannel(ctx, handle.agent, {
    handle, cwd: root, provider: 'scripted', model: 'scripted', activity: false,
  })
  await settled(() => !channel.working)
  return {
    channel,
    record,
    fork,
    gate,
    close: async () => {
      channel.releaseContributions()
      await ctx.fiber.dispose()
    },
  }
}

/** The row's note is short-lived: sample it while the cycle runs. */
function watchNotes(channel) {
  const notes = new Set()
  const timer = setInterval(() => {
    const note = channel.manualCompactionStage?.note
    if (note !== undefined && !notes.has(note)) notes.add(note)
  }, 4)
  return { notes, stop: () => clearInterval(timer) }
}

// ── scene A: the fork never settles ───────────────────────────────────────
{
  const world = await makeWorld('a')
  const watch = watchNotes(world.channel)
  try {
    world.channel.compact()
    check('scene A: the soft mark steers the fork once', await settled(() => world.record.steers.length > 0, { stepMs: 5 }))
    const steer = world.record.steers[0]?.text ?? ''
    check('scene A: the steer names the marker and the budget', steer.includes('RP_DONE') && steer.includes('Бюджет restruct-plan'), steer.slice(0, 60))
    check('scene A: the steer lands while the fork is still running', world.record.steers[0]?.disposed === 0, String(world.record.steers[0]?.disposed))
    check('scene A: the hard mark stops the fork', await settled(() => world.record.disposed > 0))
    check('scene A: the fork is stopped once', world.record.disposed === 1, String(world.record.disposed))
    check('scene A: the compaction still runs after the budget', await settled(() => world.record.compactions === 1))
    check('scene A: the row names the stop while the compaction runs', await settled(() => watch.notes.has('budget-hard'), { stepMs: 4 }))
    check('scene A: the row named both budget phases', watch.notes.has('budget-soft'), [...watch.notes].join(','))
    world.gate.resolve()
    check('scene A: the cycle ends', await settled(() => world.channel.manualCompactionStage === undefined))
    check('scene A: no second steer after the stop', world.record.steers.length === 1, String(world.record.steers.length))
  } finally {
    watch.stop()
    world.gate.resolve()
    world.fork.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'RP_DONE teardown' }] })
    await world.close()
  }
}

// ── scene B: a host without sendMessage ───────────────────────────────────
{
  const world = await makeWorld('b', { sendMessage: false })
  const watch = watchNotes(world.channel)
  try {
    world.channel.compact()
    check('scene B: the compaction runs without a steer', await settled(() => world.record.compactions === 1))
    check('scene B: no steer reaches the fork', world.record.steers.length === 0, String(world.record.steers.length))
    check('scene B: the hard mark still stops the fork', world.record.disposed === 1, String(world.record.disposed))
    check('scene B: the row still names the stop', await settled(() => watch.notes.has('budget-hard'), { stepMs: 4 }), [...watch.notes].join(','))
  } finally {
    watch.stop()
    world.gate.resolve()
    world.fork.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'RP_DONE teardown' }] })
    await world.close()
  }
}

// ── scene C: the fork finishes before the soft mark ───────────────────────
{
  const world = await makeWorld('c')
  const watch = watchNotes(world.channel)
  try {
    world.fork.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'RP_DONE budget-scene' }] })
    world.channel.compact()
    check('scene C: a completed fork runs the compaction', await settled(() => world.record.compactions === 1))
    check('scene C: no steer on a completed fork', world.record.steers.length === 0, String(world.record.steers.length))
    check('scene C: no stop on a completed fork', world.record.disposed === 0, String(world.record.disposed))
    check('scene C: no budget note on a completed fork', watch.notes.size === 0, [...watch.notes].join(','))
  } finally {
    watch.stop()
    world.gate.resolve()
    await world.close()
  }
}

rmSync(root, { recursive: true, force: true })
console.log(failed === 0 ? 'compact-rp budget OK' : `compact-rp budget FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
