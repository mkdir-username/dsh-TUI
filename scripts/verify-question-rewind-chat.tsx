/**
 * Chat-level regression for the two session-UI paths:
 *  - `/rewind` on a 20-message history renders two-line checkpoints with
 *    hidden-row counters, a confirm pane, and Esc back/close;
 *  - a real QuestionStore ask (the ask_user_question entry) renders numbered
 *    options, and digit 2 settles the ask with the second option.
 * Run: node --import tsx/esm scripts/verify-question-rewind-chat.tsx
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
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { settled, sleep, viewportLines } from './lib/term-test.mjs'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-live-paths-'))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_DISABLE_TERMINAL_IMAGES = '1'
process.env.FORCE_COLOR = '0'

const [{ render, AlternateScreen }, { Chat }, { QuestionStore }, { createChannel }, { createChannelUi, createChannelUiLease }] = await Promise.all([
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/adapter/channel/ui.js'),
])

const COLS = 100
const ROWS = 40

function appendReply(session: Session, turn: number, text: string): void {
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn, step: 1, stream: [],
    message: createAssistantMessage({
      source: { provider: 'fake', model: 'model' },
      content: [{ type: 'text', text: `Reply ${turn}` }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

const source = Session.create(SessionId('live-paths'), [], {
  ...Session.create(SessionId('live-paths')).header, createdAt: 1, cwd: home,
})
for (let turn = 1; turn <= 20; turn += 1) {
  source.append('turn/start', { turn })
  appendReply(source, turn, `Message ${String(turn).padStart(2, '0')}`)
}

const ctx = new Context()
const agent = {
  id: String(source.id),
  status: 'idle',
  session: source,
  ctx: { on: () => () => {} },
  followup() { throw new Error('the probe must not send') },
  steer() {},
  cancel() {},
  inbox: { nextTurn: [], nextStep: [], clear() {}, remove: () => true },
}
const channel = createChannel(ctx, agent as never, {
  model: 'model', provider: 'fake', cwd: home, activity: false, whaleIdle: false,
})
const store = new QuestionStore()
const lease = createChannelUiLease(() => true)

const term = new xterm.Terminal({ cols: COLS, rows: ROWS, scrollback: 2000, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
    term.write(String(chunk), cb)
  }
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
const promptShows = (text: string): boolean =>
  viewportLines(term, ROWS).some(line => /^\s*(?:⌸\s*)?❯/u.test(line) && line.includes(text))
const enter = async (): Promise<void> => {
  await sleep(120) // 固定窗:pacing Enter deduplication is 80 ms in both Chat and PromptInput
  stdin.write('\r')
}

const app = await render(
  React.createElement(AlternateScreen, null,
    React.createElement(Chat, {
      channel: createChannelUi(channel, 'legacy', lease),
      questionStore: store,
      onExit: () => {},
      fullscreen: true,
    })),
  {
    stdin: stdin as never,
    stdout: new FakeStdout() as never,
    stderr: new FakeStderr() as never,
    exitOnCtrlC: false,
    patchConsole: false,
  },
)

let failures = 0
const check = (name: string, ok: boolean, extra?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || extra === undefined ? '' : ` — ${extra.slice(0, 400)}`}`)
  if (!ok) failures += 1
}

try {
  check('P0 long transcript is rendered',
    await settled(() => screen().includes('Message 20')), screen())

  stdin.write('/rewind')
  check('P1 the slash command reaches the composer', await settled(() => promptShows('/rewind')))
  await enter()
  check('P2 /rewind opens the picker on the long history',
    await settled(() => screen().includes('Rewind') && /↓ \d+ more/.test(screen())), screen())

  const lines = viewportLines(term, ROWS)
  const metaAt = lines.findIndex(line => line.includes('20 of 20'))
  check('P3 the newest checkpoint has a metadata line', metaAt > 0
    && lines[metaAt]!.includes('last message'), lines.slice(Math.max(0, metaAt - 2), metaAt + 2).join('\n'))
  check('P4 the checkpoint message sits directly above its metadata', metaAt > 0
    && lines[metaAt - 1]!.includes('Message 20') && lines[metaAt - 1]!.includes('❯'),
    lines.slice(Math.max(0, metaAt - 2), metaAt + 2).join('\n'))
  check('P5 the list fits the screen and the footer is visible',
    screen().includes('Enter to select') && screen().includes('Esc to exit'), screen())

  await enter()
  check('P6 Enter opens the confirm pane',
    await settled(() => screen().includes('Rewind conversation to this message?')), screen())
  check('P7 the confirm pane states code-restore availability',
    await settled(() => screen().includes('No code restore')), screen())
  check('P8 the confirm footer offers Enter and Esc',
    screen().includes('Enter to rewind') && screen().includes('Esc'), screen())

  stdin.write('\x1b')
  check('P9 Esc returns to the checkpoint list', await settled(() => screen().includes('last message')
    && !screen().includes('No code restore')), screen())
  stdin.write('\x1b')
  check('P10 Esc closes the picker', await settled(() => !screen().includes('20 of 20')), screen())

  let resolved: { answers: { id: string; selected: string[] }[] } | undefined
  const pending = store.ask({
    questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'Alpha' }, { label: 'Beta' }] }],
  })
  void pending.then(answer => { resolved = answer })
  check('P11 a real store ask mounts the questionnaire',
    await settled(() => screen().includes('Pick one') && screen().includes('1)') && screen().includes('2)')), screen())
  stdin.write('2')
  check('P12 digit 2 settles the real ask with Beta',
    await settled(() => resolved !== undefined), JSON.stringify(resolved))
  check('P13 the store returned the digit-picked option',
    resolved?.answers?.[0]?.id === 'q1' && resolved?.answers?.[0]?.selected?.[0] === 'Beta',
    JSON.stringify(resolved))
  check('P14 the questionnaire closes after the answer',
    await settled(() => !screen().includes('Pick one')), screen())
} finally {
  app.unmount()
  rmSync(home, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`${failures} live-path check(s) failed`)
  process.exit(1)
}
console.log('live paths: all checks passed')
