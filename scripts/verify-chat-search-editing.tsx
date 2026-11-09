/**
 * Chat overlay search fields must edit by CODE POINTS: the history search
 * (Ctrl+R) and the transcript search (`/` in transcript mode) are single-line
 * fields, and a ⌫/Del that steps one UTF-16 unit splits an emoji into lone
 * surrogates — the query renders as a replacement glyph and never matches
 * again. Same contract as the shared answer-field editor
 * (src/components/questions/answerField.ts), which is where the stepping
 * comes from now.
 *
 * Drives the real Chat key path with fake stdin; the query is asserted on the
 * headless terminal screen.
 */
import './lib/fake-home.mjs'
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render }, { Chat }, { QuestionStore }, { settled, sleep, viewportLines }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/questions.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean, extra?: string): void => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
  if (!ok && extra !== undefined) results.push(`      actual: ${extra.slice(0, 400)}`)
}

function makeChannel(rows: unknown[]) {
  return {
    version: 0,
    rows,
    status: 'idle',
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    tokens: { input: 120, output: 45 },
    cwd: '/tmp/demo',
    displayCwd: '/tmp/demo',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting',
    responseChars: 0,
    activeToolCount: 0,
    mode: { id: 'default', plan: true },
    modeIndex: 0,
    cycleMode() {},
    turnStart: Date.now(),
    lastUserText: 'make a plan',
    pending: [],
    commandList: [],
    notifications: [],
    activityEnabled: false,
    contextBarEnabled: false,
    activityFrames: [],
    subscribe: () => () => {},
    submit: () => {},
    cancel: () => {},
    clear: () => {},
    notify: () => {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  }
}

/** A fresh Chat on its own terminal; returns the screen reader + teardown. */
async function mountChat(): Promise<{ screen: () => string; stdin: PassThrough; done: () => Promise<void> }> {
  const term = new XTerm({ cols: 100, rows: 30, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = 100
    rows = 30
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable {
    isTTY = true
    _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin()
  const app = await render(
    React.createElement(Chat, {
      channel: makeChannel([
        { id: 0, kind: 'user', text: 'make a plan' },
        { id: 1, kind: 'assistant', text: 'Here is a plan.' },
      ]) as never,
      questionStore: new QuestionStore(),
      onExit() {},
    }),
    {
      stdout: new FakeStdout() as never,
      stdin: stdin as never,
      stderr: new FakeStderr() as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const screen = (): string => viewportLines(term, 30).join('\n')
  await settled(() => screen().includes('make a plan'))
  return {
    screen,
    stdin: stdin as unknown as PassThrough,
    done: async () => {
      await app.unmount()
      term.dispose()
      await sleep(60) // 固定窗:pacing 卸载/dispose 无可观测完成条件
    },
  }
}

/** One key group, then a pacing window: caret moves are not observable. */
async function feed(stdin: PassThrough, sequence: string): Promise<void> {
  stdin.write(sequence)
  await sleep(150) // 固定窗:pacing 按键分组之间，语义由下一次插入/删除断言
}

// ── 1. History search: ⌫ removes the whole emoji, never half of it ───
{
  const chat = await mountChat()
  chat.stdin.write('\x12') // Ctrl+R
  await settled(() => chat.screen().includes('搜索历史'))
  chat.stdin.write('👍')
  await settled(() => chat.screen().includes('👍'))
  await feed(chat.stdin, '\x7f') // Backspace
  const afterBackspace = await settled(() => !chat.screen().includes('👍'))
  check('1a: history search ⌫ removes the whole emoji', afterBackspace, chat.screen())
  check('1b: …and the empty query shows its placeholder', chat.screen().includes('输入以搜索…'), chat.screen())
  await chat.done()
}

// ── 2. History search: Del at the head removes the whole emoji ──────
{
  const chat = await mountChat()
  chat.stdin.write('\x12')
  await settled(() => chat.screen().includes('搜索历史'))
  chat.stdin.write('👍')
  await settled(() => chat.screen().includes('👍'))
  await feed(chat.stdin, '\x1b[H') // Home
  await feed(chat.stdin, '\x1b[3~') // Delete
  const afterDelete = await settled(() => !chat.screen().includes('👍'))
  check('2a: history search Del at the head removes the whole emoji', afterDelete, chat.screen())
  check('2b: …and the query is empty, not a lone surrogate', chat.screen().includes('输入以搜索…'), chat.screen())
  await chat.done()
}

// ── 3. Transcript search: ⌫ removes the whole emoji ────────────────
{
  const chat = await mountChat()
  await feed(chat.stdin, '\x0f') // Ctrl+O — transcript mode
  await feed(chat.stdin, '/') // open transcript search
  chat.stdin.write('👍')
  // The "no matches" marker is the proof the text landed in the SEARCH BAR
  // (an empty query shows no marker; the composer would swallow it silently).
  const inSearch = await settled(() => chat.screen().includes('无匹配'))
  check('3a: the transcript search bar takes the typed text', inSearch, chat.screen())
  await feed(chat.stdin, '\x7f') // Backspace
  const cleared = await settled(() => !chat.screen().includes('无匹配'))
  check('3b: transcript search ⌫ removes the whole emoji (query empty, no lone surrogate)', cleared, chat.screen())
  await chat.done()
}

console.log(results.join('\n'))
if (failures > 0) {
  console.log(`\n${failures} chat search editing check(s) FAILED`)
  process.exit(1)
}
console.log('\nChat search fields edit by code points')
process.exit(0)
