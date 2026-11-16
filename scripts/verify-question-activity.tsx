/**
 * Questionnaire activity regression: the host counts a timed ask's deadline
 * down only while no answer UI holds a claim, so the panel has to report that
 * the user is working on the answer. This pins the two links of that chain:
 *
 *  1. every key that reaches the panel — typing, ↑/↓ between options, Tab to
 *     the free-text row, Space on a multi-select, ←/→ between questions — and
 *     a click on an answer row calls `onActivity`;
 *  2. the real Chat wires that prop to `questionStore.noteActivity()`, so a
 *     keystroke in the mounted panel reaches the activity observer the DSH
 *     binding installs.
 *
 * Run: node --import tsx/esm scripts/verify-question-activity.tsx
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import xterm from '@xterm/headless'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { settled, settle, viewportLines } from './lib/term-test.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-question-activity-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
process.env.FORCE_COLOR = '0'

const [
  { render, AlternateScreen },
  { Chat },
  { QuestionStore },
  { AskUserQuestionPanel },
  { createChannel },
  { createChannelUi, createChannelUiLease },
] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/components/questions/AskUserQuestionPanel.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/adapter/channel/ui.js'),
])

const COLS = 100
const ROWS = 40
const term = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _e: BufferEncoding, cb: () => void): void { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
}
const stdin = new FakeStdin()
const screen = (): string => viewportLines(term, ROWS).join('\n')

const results: string[] = []
let failures = 0
const check = (name: string, ok: boolean, extra?: string): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures++
    if (extra !== undefined) results.push(`      actual: ${extra.slice(0, 300)}`)
  }
}

type AppLike = { rerender(el: unknown): unknown; unmount(): void }

// ── 1. The panel reports every kind of touch ───────────────────────────────
{
  let activity = 0
  const element = React.createElement(AskUserQuestionPanel, {
    question: {
      question: 'Pick a colour',
      options: [{ label: 'Azure' }, { label: 'Beige' }],
      multiSelect: true,
    },
    position: 1,
    total: 1,
    answered: 0,
    onAnswer: () => {},
    onCancel: () => {},
    onActivity: () => { activity += 1 },
  })
  const app = await render(element, {
    stdout: new FakeStdout(),
    stdin,
    stderr: new FakeStderr(),
    debug: true,
    exitOnCtrlC: false,
  }) as unknown as AppLike
  await settle(() => screen().includes('Pick a colour'))

  /** One key group, one assertion: did the panel report the touch? */
  const touch = async (name: string, sequence: string): Promise<void> => {
    const before = activity
    stdin.write(sequence)
    check(`1[${name}]: the panel reported activity`, await settled(() => activity > before), String(activity - before))
  }
  await touch('typing', 'a')
  await touch('down', '\x1b[B')
  await touch('up', '\x1b[A')
  await touch('space on a multi-select', ' ')
  await touch('tab to the answer row', '\t')
  await touch('backspace in the answer row', '\x7f')
  await touch('enter', '\r')

  app.unmount()
}

// ── 2. The real Chat wires the panel to the store ──────────────────────────
// The first part's frame still sits in the shared terminal buffer; without a
// reset, "the question is on screen" would match a panel that is already gone
// and the first keystroke would land before Chat's panel is mounted.
term.reset()
{
  const session = Session.create(SessionId('question-activity'), [], {
    ...Session.create(SessionId('question-activity')).header, createdAt: 1, cwd: home,
  })
  // A live session, not the launchpad: the question panel is answered from the
  // chat screen in every real scenario that reaches it.
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }],
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [],
    message: createAssistantMessage({
      source: { provider: 'fake', model: 'model' },
      content: [{ type: 'text', text: 'Ready' }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const ctx = new Context()
  const agent = {
    id: String(session.header.id),
    status: 'idle',
    session,
    ctx: { on: () => () => {} },
    followup(): void { throw new Error('the probe must not send') },
    steer(): void {},
    cancel(): void {},
    inbox: { nextTurn: [], nextStep: [], clear(): void {}, remove: () => true },
  }
  const channel = createChannel(ctx, agent as never, {
    model: 'model', provider: 'fake', cwd: home, activity: false, whaleIdle: false,
  })
  const store = new QuestionStore()
  const lease = createChannelUiLease(() => true)
  let touches = 0
  store.setActivityObserver({ active: () => {}, touch: () => { touches += 1 } })
  const app = await render(React.createElement(AlternateScreen, null,
    React.createElement(Chat, {
      channel: createChannelUi(channel, 'legacy', lease),
      questionStore: store,
      onExit: () => {},
      fullscreen: true,
    })), {
    stdin,
    stdout: new FakeStdout() as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  }) as unknown as AppLike

  void store.ask({
    questions: [{ id: 'q1', question: 'Pick a colour', options: [{ label: 'Azure' }] }],
  }).catch(() => {})
  check('2a: the mounted chat shows the question',
    await settled(() => screen().includes('Pick a colour') && screen().includes('Ready')), screen())

  stdin.write('a')
  check('2b: typing in the chat panel reaches the store', await settled(() => touches > 0), String(touches))

  stdin.write('\x1b[B')
  const afterKeys = touches
  check('2c: moving between options keeps reporting', await settled(() => touches > afterKeys), String(touches))

  store.cancelCurrent()
  app.unmount()
}

console.log(results.join('\n'))
assert.equal(failures, 0, 'the questionnaire must report the user working on it')
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
rmSync(home, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
