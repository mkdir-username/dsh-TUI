#!/usr/bin/env node
/**
 * A TUI fork child inherits the parent's dialogue, never its pending input.
 *
 * `/fork`, `/rewind` and the tree actions copy the parent log themselves instead of
 * going through the subagent fork provider, so the runtime patch that guards the
 * provider seed does not reach them. The parent below runs one real turn and queues
 * a background notice for its next turn — the state a live restruct-plan fork
 * replayed on 2026-11-27 — and the child is created through the same
 * `liveSessionCreateOptions()` factory all three channels use.
 *
 * The control creates the child from the raw cut with the identical metadata: it is
 * the pre-fix shape, and it must still open with the queued notice. Otherwise the
 * scenario no longer reproduces and this regression proves nothing.
 *
 * Run: node --import tsx/esm scripts/verify-tui-fork-seed-queue.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as JsonlSessionPersistenceModule from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { liveSessionCreateOptions, sliceLiveSessionSeed } from '../src/dsh-adapter/compat/liveSession.ts'
import { holdsNoConversation } from '../src/dsh-adapter/session-seed.ts'
import { settled } from './lib/term-test.mjs'

const JsonlSessionPersistence = 'default' in JsonlSessionPersistenceModule
  ? JsonlSessionPersistenceModule.default
  : JsonlSessionPersistenceModule

const NOTICE = 'Background delegation task:6bc35d1c settled'
const TASK = 'revision prompt'
const DIALOGUE = 'first prompt'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const requests = []
function requestText(options) {
  const parts = []
  for (const message of options.messages ?? []) {
    if (typeof message.content === 'string') parts.push(message.content)
    else for (const block of message.content ?? []) if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}
class ScriptedAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model } }
  async *stream(options) {
    requests.push(requestText(options))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ack' }
    if (requests.length === 1) {
      // The parent's turn stays open until it is cancelled: that is the shape a live
      // fork inherited — queued input written before turn/end and still pending after it.
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('parent turn cancelled')), { once: true })
      })
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ack' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Pending next-turn input a seed would replay, folded exactly as the inbox projection does. */
function pendingTurns(seed) {
  let queued = []
  for (const event of seed) {
    if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-turn') continue
    queued = queued.toSpliced(event.data.start, event.data.removedCount ?? 0, ...(event.data.inserted ?? []))
  }
  return queued
}

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-fork-queue-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')

const scripted = { provider: 'scripted', model: 'scripted' }
const ctx = new Context()
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())

  const parent = await ctx.agents.create({ sessionId: 'fork-parent', cwd: root, agentOptions: scripted })
  parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: DIALOGUE }], source: { kind: 'user' } }))
  check('the parent opens its first turn', await settled(() => requests.length === 1 && parent.agent.status === 'running'))
  parent.agent.inbox.append('next-turn', createUserMessage({
    content: [{ type: 'text', text: NOTICE }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'task:6bc35d1c settled' },
  }))
  parent.agent.cancel(new Error('verify stop'), { stop: true, keepInbox: true })
  check('the parent ends its turn with the notice still queued', await settled(() => parent.agent.status === 'idle' && parent.agent.inbox.nextTurn.length === 1), String(parent.agent.inbox.nextTurn.length))

  const cut = sliceLiveSessionSeed(parent.agent.session)
  check('the live parent cut carries the queued turn', pendingTurns(cut).length === 1, String(pendingTurns(cut).length))
  check('the live parent cut holds a conversation', !holdsNoConversation(cut))
  const seed = cut

  const optionsOf = sessionId => liveSessionCreateOptions({
    sessionId,
    seed,
    runtimeSession: parent.agent.session,
    inheritedCount: seed.length,
    cwd: root,
    parentSession: parent.agent.session.id,
    agentOptions: scripted,
  })
  const tuiOptions = optionsOf(SessionId(randomUUID()))
  const controlOptions = { ...tuiOptions, sessionId: SessionId(randomUUID()), seed: cut }

  check('a TUI fork seed carries no queued input', pendingTurns(tuiOptions.seed).length === 0, String(pendingTurns(tuiOptions.seed).length))
  check('the control seed still carries the queued turn', pendingTurns(controlOptions.seed).length === 1)
  check('a TUI fork seed keeps the dialogue', tuiOptions.seed.some(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(DIALOGUE)))
  check('a TUI fork seed keeps every event', tuiOptions.seed.length === cut.length)
  check('a TUI fork seed keeps contiguous sequence numbers', tuiOptions.seed.every((event, index) => event.seq === index))

  async function runChild(options) {
    const before = requests.length
    const child = await ctx.agents.create(options)
    child.agent.followup(createUserMessage({ content: [{ type: 'text', text: TASK }], source: { kind: 'user' } }))
    await settled(() => requests.length > before)
    // A seeded child with a live queue wakes on its own during create: that wake request is
    // the first new one, and the task prompt trails it exactly as it did in production.
    return requests[before] ?? ''
  }

  const controlFirst = await runChild(controlOptions)
  check('the control child opens with the parent\'s queued notice', controlFirst.includes(NOTICE), controlFirst.slice(0, 80).replace(/\n/g, ' '))
  check('the control child leaves its own task for a later turn', !controlFirst.includes(TASK))

  const tuiFirst = await runChild(tuiOptions)
  check('the TUI fork child opens with its own task', tuiFirst.includes(TASK), tuiFirst.slice(0, 80).replace(/\n/g, ' '))
  check('the TUI fork child never sees the queued notice', !tuiFirst.includes(NOTICE))
  check('the TUI fork child still sees the parent dialogue', tuiFirst.includes(DIALOGUE))

  console.log(failed === 0 ? 'tui fork seed queue OK' : `tui fork seed queue FAILED (${failed})`)
} finally {
  await ctx.fiber.dispose().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed === 0 ? 0 : 1)
