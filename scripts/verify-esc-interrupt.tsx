/**
 * Esc stops a running turn — from either layer that can receive the key.
 *
 * Part 1 — the shared decision (`src/components/turnInterrupt.ts`): an idle
 *   channel is a no-op, a live turn cancels, queued rows dock instead, and an
 *   abort already in flight answers with the pending / stuck warning.
 * Part 2 — the composer alone (`PromptInput`): with a turn running, Esc stops
 *   it and NEVER arms the rewind gesture; once idle, the double-Esc rewind is
 *   still the gesture it always was.
 * Part 3 — the real Chat over a session that records `cancel()`: Esc while a
 *   turn runs reaches the backend abort and no rewind picker appears.
 *
 * Run: node --import tsx/esm scripts/verify-esc-interrupt.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
import './lib/fake-home.mjs' // must stay first: DATA_DIR resolves at import time
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
import * as ui from '../src/ui.js'
import { PromptInput } from '../src/components/PromptInput.js'
import { interruptTurnFromEscape } from '../src/components/turnInterrupt.js'
import { sleep, viewportLines } from './lib/term-test.mjs'

const { Terminal: XTerm } = xtermHeadless

let passed = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== '' ? `\n      ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

// ── 1. the shared decision ──────────────────────────────────────────────
interface Recorder {
  cancels: number
  docks: number
  notes: { text: string; timeoutMs?: number }[]
}
function fakeChannel(state: { working: boolean; cancelPending: boolean; pending: { docked?: boolean }[]; dockReturns: number }): { channel: never; rec: Recorder } {
  const rec: Recorder = { cancels: 0, docks: 0, notes: [] }
  const channel = {
    working: state.working,
    cancelPending: state.cancelPending,
    pending: state.pending,
    cancel() { rec.cancels += 1 },
    interruptAndDock() { rec.docks += 1; return state.dockReturns },
    notify(text: string, options?: { timeoutMs?: number }) { rec.notes.push({ text, timeoutMs: options?.timeoutMs }) },
  }
  return { channel: channel as never, rec }
}

const idle = fakeChannel({ working: false, cancelPending: false, pending: [], dockReturns: 0 })
check('1 an idle channel is not a stop', interruptTurnFromEscape(idle.channel) === false && idle.rec.cancels === 0)

const live = fakeChannel({ working: true, cancelPending: false, pending: [], dockReturns: 0 })
check('1 a live turn cancels', interruptTurnFromEscape(live.channel) === true && live.rec.cancels === 1)

const queued = fakeChannel({ working: true, cancelPending: false, pending: [{}, {}], dockReturns: 2 })
check(
  '1 queued rows dock and the dock owns the abort',
  interruptTurnFromEscape(queued.channel) === true && queued.rec.docks === 1 && queued.rec.cancels === 0,
  JSON.stringify(queued.rec),
)

const docked = fakeChannel({ working: true, cancelPending: false, pending: [{ docked: true }], dockReturns: 0 })
check('1 an already-docked queue still aborts the turn', interruptTurnFromEscape(docked.channel) === true && docked.rec.cancels === 1)

const pendingAbort = fakeChannel({ working: true, cancelPending: true, pending: [], dockReturns: 0 })
check(
  '1 a repeat press answers with the pending warning',
  interruptTurnFromEscape(pendingAbort.channel) === true
    && pendingAbort.rec.cancels === 0
    && /Interrupt requested/.test(pendingAbort.rec.notes[0]?.text ?? ''),
  JSON.stringify(pendingAbort.rec.notes),
)
const stuckAbort = fakeChannel({ working: true, cancelPending: true, pending: [], dockReturns: 0 })
check(
  '1 the watchdog wording names /restart',
  interruptTurnFromEscape(stuckAbort.channel, { stuck: true }) === true
    && /restart/.test(stuckAbort.rec.notes[0]?.text ?? '')
    && stuckAbort.rec.notes[0]?.timeoutMs === 10_000,
  JSON.stringify(stuckAbort.rec.notes),
)

// ── 2. the composer alone ───────────────────────────────────────────────
function streams(): { stdout: never; stderr: never; stdin: never; term: InstanceType<typeof XTerm> } {
  const term = new XTerm({ cols: 100, rows: 30, scrollback: 100, allowProposedApi: true })
  const stdout = new Writable({ write(chunk, _encoding, callback) { term.write(String(chunk), callback) } }) as never
  Object.assign(stdout as object, { columns: 100, rows: 30, isTTY: true })
  const stderr = new Writable({ write(_chunk, _encoding, callback) { callback() } }) as never
  Object.assign(stderr as object, { isTTY: true })
  const stdin = new PassThrough() as never
  Object.assign(stdin as object, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  })
  return { stdout, stderr, stdin, term }
}

function composerChannel(state: { working: boolean }): { channel: never; rec: Recorder & { rewinds: number } } {
  const rec = { cancels: 0, docks: 0, notes: [], rewinds: 0 } as Recorder & { rewinds: number }
  const channel = {
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: [],
    commandCompletions: () => [],
    notifications: [],
    pending: [],
    working: state.working,
    notify(text: string) { rec.notes.push({ text }) },
    submit() {},
    steer() {},
    cancel() { rec.cancels += 1 },
    interruptAndDock() { rec.docks += 1; return 0 },
    interruptAndDeliver() { return 0 },
    removePending() { return false },
    stageImage() {},
    listFiles: async () => [],
  }
  return { channel: channel as never, rec }
}

async function mountComposer(working: boolean) {
  const { stdout, stderr, stdin, term } = streams()
  const { channel, rec } = composerChannel({ working })
  const instance = await ui.render(
    React.createElement(PromptInput, {
      channel,
      helpOpen: false,
      onToggleHelp() {},
      onRunCommand() { return false },
      onRewindRequest() { rec.rewinds += 1 },
      selectionActive: false,
    }),
    { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await sleep(400)
  return {
    rec,
    screen: (): string => viewportLines(term, 30).join('\n'),
    press: async (): Promise<void> => { (stdin as unknown as PassThrough).write('\x1b'); await sleep(320) },
    unmount: async (): Promise<void> => { instance.unmount(); await sleep(40) },
  }
}

const busy = await mountComposer(true)
await busy.press()
check('2 a live turn is stopped by the first Esc', busy.rec.cancels === 1, JSON.stringify(busy.rec))
await busy.press()
check('2 and never arms the rewind gesture', busy.rec.rewinds === 0 && !/rewind/i.test(busy.screen()), JSON.stringify(busy.rec))
await busy.unmount()

const idleComposer = await mountComposer(false)
await idleComposer.press()
check('2 an idle composer still asks before rewinding', idleComposer.rec.rewinds === 0 && idleComposer.rec.cancels === 0)
await idleComposer.press()
check('2 the second idle Esc opens the rewind gesture', idleComposer.rec.rewinds === 1, JSON.stringify(idleComposer.rec))
await idleComposer.unmount()

// ── 3. the real Chat ───────────────────────────────────────────────────
const SID = '77777777-7777-4777-8777-777777777777'
const { default: instances } = await import('../src/ink/instances.js')
const { Chat } = await import('../src/screens/Chat.js')
const { QuestionStore } = await import('../src/dsh-adapter/questions.js')
const { ApprovalStore } = await import('../src/dsh-adapter/approvals.js')
const { createChannel } = await import('../src/dsh-adapter/channel.js')

const listeners = new Set<(batch: unknown, meta: unknown) => void>()
let chatCancels = 0
const session = {
  ref: { backendId: 'dsh', sessionId: SID },
  cwd: process.cwd(),
  status: 'idle',
  capabilities: { native: {} },
  history: () => Promise.resolve([]),
  subscribe(listener: never) { listeners.add(listener); return () => { listeners.delete(listener) } },
  submit: () => Promise.resolve({ accepted: true }),
  cancel: () => { chatCancels += 1; return Promise.resolve({ stillQueued: [] }) },
  dispose: () => Promise.resolve(),
}
const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never
const channel = createChannel(ctx, session as never, { model: 'fake-model', provider: '', cwd: process.cwd(), activity: false, backendLabel: 'Fake Agent' })
const chat = streams()
const chatInstance = await ui.render(
  React.createElement(Chat, { channel: channel as never, questionStore: new QuestionStore(), approvalStore: new ApprovalStore(), onExit: () => undefined, fullscreen: false, trajectorySeen: true }),
  { stdout: chat.stdout, stderr: chat.stderr, stdin: chat.stdin, exitOnCtrlC: false, patchConsole: false },
)
for (const value of instances.values()) instances.set(process.stdout, value)
await sleep(300)
for (const listener of [...listeners]) (listener as never)([{ type: 'turn.start', turn: 1, origin: 'user', time: Date.now() }], { replay: false, wake: 'sync' })
await sleep(200)
check('3 the fixture really is mid-turn', channel.working === true)
;(chat.stdin as unknown as PassThrough).write('\x1b')
await sleep(400)
check('3 Esc reaches the backend abort', chatCancels === 1, `cancels=${chatCancels}`)
check('3 and no rewind picker appears', !/rewind/i.test(viewportLines(chat.term, 30).join('\n')))
chatInstance.unmount()
await sleep(50)

console.log(`\n${failures === 0 ? 'verify-esc-interrupt OK' : `verify-esc-interrupt FAILED (${failures})`} — ${passed} passed, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
