/**
 * A fork child inherits the parent's dialogue, never its pending input.
 *
 * The parent runs one real turn, then a background notice is queued for its next turn —
 * the exact state a live restruct-plan fork replayed on 2026-11-27, when the child's first
 * turn was the parent's delegation notice and its own prompt waited a turn behind it.
 *
 * The provider is the vendor module with the runtime patch applied, and the unpatched module
 * is the control: its child must still open with the queued notice, otherwise the scenario no
 * longer reproduces the bug and this regression proves nothing.
 *
 * The patch lives with the other vendor patches in
 * `$HOME/.claude/dotfiles/dsh/bin/patch-dsh-fork-seed-queue.mjs` because releases are built
 * from there; this script only proves its behavior against the real agent loop.
 *
 * Run: node scripts/verify-fork-seed-queue.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

const NOTICE = 'Background delegation task:6bc35d1c settled'
const TASK = 'task prompt'
const DIALOGUE = 'first prompt'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const home = process.env.HOME
const patchModulePath = join(home, '.claude/dotfiles/dsh/bin/patch-dsh-fork-seed-queue.mjs')
let patchForkSeed
try {
  ;({ patchForkSeed } = await import(pathToFileURL(patchModulePath).href))
} catch (error) {
  console.error(`FAIL: the fork seed patch must be installed at ${patchModulePath} (${error.message})`)
  process.exit(1)
}

// The fork provider ships with the installed DSH host, not with this package: the TUI never
// imports it, so it is resolved from the global install and loaded by path.
const hostRequire = createRequire(join(home, '.bun/install/global/node_modules/host.js'))
const vendorMain = hostRequire.resolve('@deepseek-ai/dsh-subagent-fork-in-process')
const verifyDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.dsh-verify-fork-seed')
mkdirSync(verifyDir, { recursive: true })
const patchedFile = join(verifyDir, `fork-${process.pid}.mjs`)
const controlFile = join(verifyDir, `fork-control-${process.pid}.mjs`)
const vendorSource = readFileSync(vendorMain, 'utf8')
const patchedSource = patchForkSeed(vendorSource)
writeFileSync(patchedFile, patchedSource)
// The control is the same module with only the neutralization removed — not the installed
// file, whose state depends on whether the patch was applied to this machine yet.
writeFileSync(controlFile, patchedSource.replace(
  'return withoutQueuedInput(events.slice(0, lastEnd.seq + 1));',
  'return events.slice(0, lastEnd.seq + 1);',
))
const patchedModule = await import(pathToFileURL(patchedFile).href)
const controlModule = await import(pathToFileURL(controlFile).href)

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
      // The parent's turn stays open until it is cancelled: that is the shape the live fork
      // inherited — queued input written before the turn/end, and still pending after it.
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('parent turn cancelled')), { once: true })
      })
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ack' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function providerOf(module, providerName) {
  const providerCtx = new Context()
  const providers = new Map()
  providerCtx.provide('subagents', { registerProvider: provider => { providers.set(provider.name, provider) } })
  module.apply(providerCtx, { providerName })
  const provider = providers.get(providerName)
  assert.ok(provider, `${providerName} provider is registered`)
  return provider
}

function pendingTurns(seed) {
  let queued = []
  for (const event of seed) {
    if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-turn') continue
    queued = queued.toSpliced(event.data.start, event.data.removedCount ?? 0, ...(event.data.inserted ?? []))
  }
  return queued
}

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-fork-seed-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')

const ctx = new Context()
try {
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['scripted'], new ScriptedAdapter())

  const parent = await ctx.agents.create({
    sessionId: 'fork-parent', cwd: root, agentOptions: { provider: 'scripted', model: 'scripted' },
  })
  parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: DIALOGUE }], source: { kind: 'user' } }))
  check('the parent opens its first turn', await settled(() => requests.length === 1 && parent.agent.status === 'running'))
  parent.agent.inbox.append('next-turn', createUserMessage({
    content: [{ type: 'text', text: NOTICE }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'task:6bc35d1c settled' },
  }))
  parent.agent.cancel(new Error('verify stop'), { stop: true, keepInbox: true })
  check('the parent ends its turn with the notice still queued', await settled(() => parent.agent.status === 'idle' && parent.agent.inbox.nextTurn.length === 1), String(parent.agent.inbox.nextTurn.length))

  const patchedProvider = providerOf(patchedModule, 'fork-patched')
  const controlProvider = providerOf(controlModule, 'fork-control')
  const patchedSeed = (await patchedProvider.prepareContinuable({ parent: parent.agent, sessionId: 'fork-patched', cwd: root })).seed
  const controlSeed = (await controlProvider.prepareContinuable({ parent: parent.agent, sessionId: 'fork-control', cwd: root })).seed

  check('the control seed carries the queued turn', pendingTurns(controlSeed).length === 1, String(pendingTurns(controlSeed).length))
  check('a patched seed carries no queued input', pendingTurns(patchedSeed).length === 0, String(pendingTurns(patchedSeed).length))
  check('the patched seed keeps the dialogue', patchedSeed.some(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(DIALOGUE)))
  check('the patched seed keeps contiguous sequence numbers', patchedSeed.every((event, index) => event.seq === index))

  async function runChild(sessionId, seed) {
    const before = requests.length
    const child = await ctx.agents.create({
      sessionId, cwd: root, seed, inheritedEventCount: seed.length,
      meta: { parentSession: String(parent.agent.session.header.id), isSeeded: true, origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'scripted', model: 'scripted' },
    })
    child.agent.followup(createUserMessage({ content: [{ type: 'text', text: TASK }], source: { kind: 'user' } }))
    await settled(() => requests.length > before)
    // A seeded child with a live queue wakes on its own during create: the wake request is
    // the first new one, and the task prompt trails it exactly as it did in production.
    return requests[before] ?? ''
  }

  const controlFirst = await runChild('fork-control', controlSeed)
  check('the control child opens with the parent\'s queued notice', controlFirst.includes(NOTICE), controlFirst.slice(0, 80).replace(/\n/g, ' '))
  check('the control child leaves its own task for a later turn', !controlFirst.includes(TASK))

  const patchedFirst = await runChild('fork-patched', patchedSeed)
  check('the patched child opens with its own task', patchedFirst.includes(TASK), patchedFirst.slice(0, 80).replace(/\n/g, ' '))
  check('the patched child never sees the queued notice', !patchedFirst.includes(NOTICE))
  check('the patched child still sees the parent dialogue', patchedFirst.includes(DIALOGUE))

  console.log(failed === 0 ? 'fork seed queue OK' : `fork seed queue FAILED (${failed})`)
} finally {
  await ctx.fiber.dispose().catch(() => {})
  rmSync(root, { recursive: true, force: true })
  rmSync(patchedFile, { force: true })
  rmSync(controlFile, { force: true })
}
process.exit(failed === 0 ? 0 : 1)
