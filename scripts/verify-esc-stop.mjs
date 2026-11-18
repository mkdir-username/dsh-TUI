/**
 * verify-esc-stop — the Esc key on a working turn is the engine's user stop.
 *
 * The chain the incident needed: Chat's Esc handler (screens/Chat.tsx) →
 * channel.cancel() → createDshSession.cancel('user') → agent.cancel(...,
 * { keepInbox: true, stop: true }). The last hop is what the dsh.user-stop
 * engine patch reads; this probe mounts the REAL Chat over the REAL channel
 * (the engine agent is a recording fixture) and sends the same `\x1b` the
 * terminal delivers.
 *
 * Run after build: node scripts/verify-esc-stop.mjs
 */
import './lib/fake-home.mjs' // must stay first: DATA_DIR resolves at import time
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [React, { PassThrough, Writable }, xtermModule, { render, AlternateScreen }, { Chat }, { QuestionStore }, { PageMargin }, { createChannel }] = await Promise.all([
  import('react'),
  import('node:stream'),
  import('@xterm/headless'),
  import('../lib/types/ui.js'),
  import('../lib/types/screens/Chat.js'),
  import('../lib/types/dsh-adapter/questions.js'),
  import('../lib/types/components/PageMargin.js'),
  import('../lib/types/dsh-adapter/channel.js'),
])

const { Terminal } = xtermModule.default
const screenText = () => { const b = term.buffer.active; return Array.from({ length: term.rows }, (_, y) => b.getLine(b.baseY + y)?.translateToString(true) ?? '') }

const COLS = 100
const ROWS = 30
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true })
class FakeStdout extends Writable {
  columns = COLS; rows = ROWS; isTTY = true
  _write(chunk, _e, cb) { term.write(String(chunk), cb) }
}
class FakeStderr extends Writable {
  isTTY = true
  _write(_c, _e, cb) { cb() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const handlers = new Map()
const ctx = {
  on(event, handler) {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
    return () => { const index = list.indexOf(handler); if (index !== -1) list.splice(index, 1) }
  },
  get() { return undefined },
  logger: { warn() {} },
}
const stubAgentCtx = { on: () => () => {} }
const cancelCalls = []
const agent = {
  id: 'esc-stop-agent',
  status: 'running',
  session: { id: 'esc-stop-session', seq: 0, events: [] },
  ctx: stubAgentCtx,
  followup() {},
  steer() {},
  cancel(cause, options) { cancelCalls.push({ cause, options }) },
  inbox: { remove: () => true },
}
const channel = createChannel(ctx, agent, { model: 'deepseek-chat', cwd: '/tmp', provider: 'deepseek', activity: false })

const stdin = new FakeStdin()
const stdout = new FakeStdout()
const app = await render(
  React.createElement(AlternateScreen, null,
    React.createElement(PageMargin, null,
      React.createElement(Chat, { channel, questionStore: new QuestionStore(), onExit: () => {} }))),
  { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
await sleep(400)

// Feed one live turn/start through the adapter's session bus: that is what a
// running turn projects, and what makes Chat's Esc branch active.
for (const handler of handlers.get('session/event') ?? []) {
  handler(agent.session, { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } })
}
await sleep(80)
check('the channel reports the turn as running', channel.working === true)

stdin.write('\x1b')
await sleep(200)

check('Esc on a working turn cancels the user turn', cancelCalls.length === 1, JSON.stringify(cancelCalls))
check('the cancel cause is the user', cancelCalls[0]?.cause?.kind === 'user')
check('the cancel keeps the queue', cancelCalls[0]?.options?.keepInbox === true, JSON.stringify(cancelCalls[0]?.options))
check('the cancel marks the user stop', cancelCalls[0]?.options?.stop === true, JSON.stringify(cancelCalls[0]?.options))

try { app.unmount() } catch { /* the renderer tears down on exit */ }
process.exit(failed === 0 ? 0 : 1)
