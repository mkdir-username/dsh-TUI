/**
 * Real-agent regression for the /compact cycle hold: while the manual cycle
 * (restruct-plan fork + compaction) owns the agent, waking input — a settled
 * background job's notice — waits in the inbox instead of opening a turn, and
 * is delivered to the main session only after the cycle ends.
 *
 * Only the model transport, the fork provider and the compaction engine are
 * scripted; the agent loop, inbox, maintenance phases and the channel are real.
 *
 * Run after build: node scripts/verify-compact-hold-events.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
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

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-compact-hold-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
const { createChannel } = await import('../lib/types/dsh-adapter/channel.js')

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

/** What the model saw, one entry per request. */
const requests = []
class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    requests.push(options.messages)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'handled' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'handled' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const forkStarted = Promise.withResolvers()
const forkResult = Promise.withResolvers()
const compactionStarted = Promise.withResolvers()
const compactionGate = Promise.withResolvers()
let forkPrompt
let compactionCalls = 0
let compactionSawRunMaintenance = false

const subagents = {
  getProvider: name => name === 'fork' ? { name } : undefined,
  startActivation(spec) {
    forkPrompt = spec.request.prompt[0].text
    forkStarted.resolve()
    return { result: forkResult.promise }
  },
}
const compaction = {
  async compactNow(context) {
    compactionCalls += 1
    compactionSawRunMaintenance = typeof context.runMaintenance === 'function'
    return context.runMaintenance(async () => {
      compactionStarted.resolve()
      await compactionGate.promise
      return { shadowedSeqs: [] }
    })
  },
}

const ctx = new Context()
let channel
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())
  ctx.provide('subagents', subagents)
  ctx.provide('compaction', compaction)

  const handle = await ctx.agents.create({
    sessionId: 'compact-hold', cwd: root, agentOptions: { provider: 'scripted', model: 'scripted' },
  })
  channel = createChannel(ctx, handle.agent, {
    handle, cwd: root, provider: 'scripted', model: 'scripted', activity: false,
  })
  await settled(() => !channel.working)

  channel.compact()
  const forkSeen = await Promise.race([
    forkStarted.promise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 3000)),
  ])
  check('the restruct-plan fork started', forkSeen && forkPrompt !== undefined)
  check('the cycle shows the restruct-plan stage', channel.manualCompactionStage?.phase === 'restruct-plan', JSON.stringify(channel.manualCompactionStage))
  check('the agent is idle while the fork runs', handle.agent.status === 'idle')
  check('no model request was made yet', requests.length === 0, String(requests.length))

  // Exactly what dsh-tool-jobs sends when an owned background job settles.
  const notice = createUserMessage({
    content: [{ type: 'text', text: 'job bash-1 finished (exit code: 0)' }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'bash-1 finished' },
  })
  handle.agent.followup(notice)
  await new Promise(resolve => setTimeout(resolve, 50))
  check('a background notice opens no turn during restruct-plan', requests.length === 0, String(requests.length))
  check('the channel stays idle', channel.working === false)
  check('the notice waits in the inbox', handle.agent.inbox.nextTurn.length === 1, String(handle.agent.inbox.nextTurn.length))

  forkResult.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'RP_DONE compact-hold' }] })
  const compactionSeen = await Promise.race([
    compactionStarted.promise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 3000)),
  ])
  check('the compaction engine ran inside the held phase', compactionSeen && compactionCalls === 1 && compactionSawRunMaintenance)
  check('the compaction opens no turn either', requests.length === 0, String(requests.length))
  check('the notice still waits while summarizing', handle.agent.inbox.nextTurn.length === 1, String(handle.agent.inbox.nextTurn.length))

  compactionGate.resolve()
  check('the queued notice opens one turn after the cycle', await settled(() => requests.length === 1), String(requests.length))
  check('the queued notice reached the model', JSON.stringify(requests[0]).includes('job bash-1 finished'))
  check('the inbox was drained', handle.agent.inbox.nextTurn.length === 0, String(handle.agent.inbox.nextTurn.length))
  check('the turn settles', await settled(() => !channel.working))
} finally {
  forkResult.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'RP_DONE teardown' }] })
  compactionGate.resolve()
  channel?.releaseContributions()
  await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}

console.log(failed === 0 ? 'compact cycle hold OK' : `compact cycle hold FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
