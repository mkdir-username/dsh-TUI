/**
 * Side-panel controller regression (Phase 1, keyboard): drives useSidePanel
 * through REAL stdin key injection (FakeStdin PassThrough + ink raw mode,
 * the repro-ctrlc pattern). A harness component forwards every parsed key
 * to sidePanel.handleKey — exactly Chat's call point — and renders the
 * controller state as a text line; when handleKey returns false the key is
 * counted as "received by chat" (the fall-through contract).
 *
 * Locked behavior:
 *  a. alt+o three-state at 120 cols: closed -> open+focus panel ->
 *     close+focus chat -> open+focus panel (panel-focus press closes);
 *     a fresh open session with chat focus -> panel focus (not close).
 *  b. panel-focused keys: arrows and [ ] cycle activePanelId, '2' jumps,
 *     z toggles zoom (chatColumns 81<->64), +/- resize by 4 columns each
 *     way, plain 'x' swallowed (no chat key), ctrl combos (ctrl+l) fall
 *     through to chat; global alt+z zooms from any focus.
 *  e. Esc: a real lone ESC arrives from this ink fork as
 *     {escape:true, meta:true}; the ctrl/meta fall-through guard exempts
 *     escape (meta && escape!==true), so Esc returns focus to chat, and
 *     alt+o afterwards re-focuses the panel (three-state intact).
 *  c. 90 cols (splitAvailable=false): alt+o returns false, no state move.
 *  d. editorOpen=true at 120 cols: alt+o likewise inert.
 * Run: node --import tsx/esm scripts/verify-side-panel-keys.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'

const [{ PassThrough, Writable }, React, { Terminal: XTerm }, ui, { useSidePanel }, prefs, termTest, { registerBuiltinPanels }, { panelStore }] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/sidePanel/useSidePanel.js'),
  import('../src/tuiDisplayPrefs.js'),
  import('./lib/term-test.mjs'),
  import('../src/components/sidePanel/builtinPanels.js'),
  import('../src/components/sidePanel/PanelStore.js'),
])
const { render, AlternateScreen, Box, Text, useInput } = ui
const { setKeymapOverrides } = await import('../src/utils/keymap.js')
// 侧栏热键默认不绑（Ctrl+B 归后台键）。本套件测的是控制器本身，所以显式
// 绑一个空闲组合：Alt+O 走真实 stdin 路径，和 Alt+Z 缩放同一层。
setKeymapOverrides({ sidePanel: 'alt+o' })
const { applySidePanelOpen, applySidePanelRatio, setTemporarySidePanelHidden } = prefs
const { settled, sleep, viewportLines } = termTest

// `sidePanel.panels` defaults to `*`, which derives the tab list from the
// registry: register the built-ins the way the app does before any mount
// (otherwise the controller legitimately has no enabled panel).
registerBuiltinPanels()

const COLS = 84
const ROWS = 6

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (extra ? '  (' + extra + ')' : ''))
  if (!ok) failed += 1
}

// Mutable probes the harness reports on its state line.
let chatKeyCount = 0
let lastHandled = -1 // -1 none yet, 1 handled by panel, 0 fell through
let exposedHandleKey: ((input: string, key: Record<string, boolean | undefined>) => boolean) | undefined
let exposedFocus = ''
let exposedOpen: ((id: string, opts?: { focus?: boolean }) => void) | undefined

function Harness({ columns, fullscreen, editorOpen }: { columns: number; fullscreen: boolean; editorOpen: boolean }): React.ReactNode {
  const sp = useSidePanel({ columns, fullscreen, editorOpen })
  const [, bump] = React.useState(0)
  exposedHandleKey = sp.handleKey
  exposedFocus = sp.focus
  exposedOpen = sp.openPanel
  useInput((input: string, key: { escape?: boolean; leftArrow?: boolean; rightArrow?: boolean; ctrl?: boolean; meta?: boolean }) => {
    // Chat's call point (v2.1 contract): sidePanel.handleKey first; only a
    // false return lets the key reach the chat surface.
    const handled = sp.handleKey(input, key)
    lastHandled = handled ? 1 : 0
    if (!handled) chatKeyCount += 1
    bump(t => t + 1)
  })
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{'SP split=' + (sp.split ? 1 : 0) + ' focus=' + sp.focus + ' zoom=' + (sp.zoom ? 1 : 0) + ' active=' + (sp.activePanelId ?? 'none') + ' chat=' + sp.chatColumns + ' avail=' + (sp.splitAvailable ? 1 : 0) + ' handled=' + lastHandled + ' chatKeys=' + chatKeyCount}</Text>
    </Box>
  )
}

class FakeStdout extends Writable {
  columns = COLS
  rows = ROWS
  isTTY = true
  term: import('@xterm/headless').Terminal
  constructor(term: import('@xterm/headless').Terminal) { super(); this.term = term }
  _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { this.term.write(String(chunk), cb) }
}
class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
class FakeStdin extends PassThrough { isTTY = true; setRawMode() { return this }; ref() { return this }; unref() { return this } }

interface Session {
  stdin: FakeStdin
  state(): string
  close(): Promise<void>
}

async function openSession(columns: number, fullscreen = true, editorOpen = false, preOpen = false): Promise<Session> {
  // Live stores are module-level: reset them so every scenario starts at
  // the default ratio (focus/zoom are component state, fresh per mount;
  // open/ratio persist across mounts within this process).
  applySidePanelOpen(preOpen)
  applySidePanelRatio(0.68)
  chatKeyCount = 0
  lastHandled = -1
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const stdout = new FakeStdout(term)
  const stdin = new FakeStdin()
  const app = await render(
    <AlternateScreen mouseTracking={false}>
      <Harness columns={columns} fullscreen={fullscreen} editorOpen={editorOpen} />
    </AlternateScreen>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  const session: Session = {
    stdin,
    state() { return viewportLines(term, ROWS).find(l => l.includes('SP ')) ?? '' },
    async close() { await app.unmount() },
  }
  await settled(() => session.state().includes('split='))
  return session
}

async function press(session: Session, bytes: string, expectState: string): Promise<string> {
  session.stdin.write(bytes)
  const ok = await settled(() => session.state().includes(expectState), { timeout: 4000 })
  const state = session.state()
  if (!ok) throw new Error('state never reached ' + JSON.stringify(expectState) + '; last: ' + JSON.stringify(state))
  return state
}

const activeOf = (state: string): string => /active=(\S+)/u.exec(state)?.[1] ?? ''

async function pressUntil(session: Session, bytes: string, ok: (state: string) => boolean, label: string): Promise<string> {
  session.stdin.write(bytes)
  const reached = await settled(() => ok(session.state()), { timeoutMs: 4000 })
  const state = session.state()
  if (!reached) throw new Error('state never satisfied ' + JSON.stringify(label) + '; last: ' + JSON.stringify(state))
  return state
}

// --- a. alt+o three-state at 120 columns --------------------------------
// 侧栏热键默认不绑（Ctrl+B 归后台键），本文件开头把它绑到 Alt+O，所以这里
// 驱动的是「绑了组合之后」的控制器，不是某个具体默认键。
{
  const s = await openSession(120)
  check('a: initial state is closed, chat focus, chat=120',
    s.state().includes('split=0 focus=chat zoom=0') && s.state().includes('chat=120 avail=1'), s.state())
  const first = activeOf(s.state())
  check('a: a default active panel is present', first !== '', s.state())
  await press(s, '\x1bo', 'split=1 focus=panel')
  check('a: alt+o #1 opens and focuses the panel (chat=81)',
    s.state().includes('split=1 focus=panel') && s.state().includes('chat=81 avail=1 handled=1'), s.state())
  await press(s, '\x1bo', 'split=0 focus=chat')
  check('a: alt+o #2 (panel focused) closes and returns to chat',
    s.state().includes('split=0 focus=chat') && s.state().includes('chat=120 avail=1 handled=1'), s.state())
  await press(s, '\x1bo', 'split=1 focus=panel')
  check('a: alt+o #3 re-opens with panel focus',
    s.state().includes('split=1 focus=panel') && s.state().includes('chat=81 avail=1 handled=1'), s.state())
  await s.close()
  // open + focus chat -> alt+o moves focus to the panel (not close).
  const s2 = await openSession(120, true, false, true)
  check('a: pre-opened session starts open with chat focus',
    s2.state().includes('split=1 focus=chat') && s2.state().includes('chat=81'), s2.state())
  await press(s2, '\x1bo', 'focus=panel')
  check('a: alt+o with open+chat-focus focuses the panel',
    s2.state().includes('split=1 focus=panel') && s2.state().includes('chat=81') && s2.state().includes('handled=1'), s2.state())
  await s2.close()
}

// --- b. panel-focused host keys -------------------------------------------
{
  const s = await openSession(120)
  await press(s, '\x1bo', 'split=1 focus=panel')
  const first = activeOf(s.state())
  await pressUntil(s, '\x1b[D', state => activeOf(state) !== first, 'leftArrow cycles away')
  check('b: leftArrow cycles to the previous panel (wrap)', activeOf(s.state()) !== first, s.state())
  await pressUntil(s, '\x1b[C', state => activeOf(state) === first, 'rightArrow cycles back')
  check('b: rightArrow cycles back', activeOf(s.state()) === first, s.state())
  await pressUntil(s, '[', state => activeOf(state) !== first, '[ cycles backwards')
  check('b: [ cycles backwards', activeOf(s.state()) !== first, s.state())
  await pressUntil(s, ']', state => activeOf(state) === first, '] cycles forwards')
  check('b: ] cycles forwards', activeOf(s.state()) === first, s.state())
  await pressUntil(s, '2', state => activeOf(state) !== first, '2 jumps')
  const second = activeOf(s.state())
  check('b: 2 jumps to the second enabled panel', second !== '' && second !== first, s.state())
  // Resize (ratio store, split stays): the panel-focused '+' WIDENS THE
  // PANEL (nudge -4 → chat 81->77); '-' gives the width back to chat.
  await press(s, '+', 'chat=77')
  check('b: + widens the panel (chat shrinks by 4)', s.state().includes('chat=77'), s.state())
  await press(s, '-', 'chat=81')
  check('b: - returns the width to the chat column', s.state().includes('chat=81'), s.state())
  // Zoom: chat pinned to CHAT_MIN (64) and back.
  await press(s, 'z', 'zoom=1')
  check('b: z zooms (chat=64)', s.state().includes('zoom=1') && s.state().includes('chat=64'), s.state())
  await press(s, 'z', 'zoom=0')
  check('b: z again restores the split (chat=81)', s.state().includes('zoom=0') && s.state().includes('chat=81'), s.state())
  // Plain letter swallowed: handled=1 and the chat counter does not move.
  const before = chatKeyCount
  s.stdin.write('x')
  // 固定窗:探针 面板吞键不改变状态行（handled 一直是 1），只能等一拍看 chatKeys。
  await sleep(150)
  check('b: plain x swallowed by the panel (no chat key)',
    s.state().includes('handled=1') && chatKeyCount === before, s.state() + ' chatKeys=' + chatKeyCount)
  // Ctrl combo falls through to Chat.
  await press(s, '\x0c', 'chatKeys=' + (before + 1))
  check('b: ctrl+l falls through to chat (handled=0, counted)',
    s.state().includes('handled=0') && chatKeyCount === before + 1, s.state())
  // Global alt+z zoom works from panel focus too (input 'z' + meta).
  await press(s, '\x1bz', 'zoom=1')
  check('b: alt+z (global) toggles zoom from panel focus', s.state().includes('zoom=1') && s.state().includes('chat=64'), s.state())
  await press(s, '\x1bz', 'zoom=0')
  check('b: alt+z toggles zoom back', s.state().includes('zoom=0') && s.state().includes('chat=81'), s.state())
  await s.close()
}

// --- f. a temporary panel's visibility is this run's state ------------------
// `/settings` hides one by moving the session set, never the stored value, so
// the bar's ONE derivation must drop it — and bring it back — on its own.
{
  const id = 'session:act777:scratch'
  const dispose = panelStore.register({ id, title: 'Scratch', icon: '◉', source: 'plugin', component: () => null }, { pluginId: 'session:act777' })
  const s = await openSession(120)
  await press(s, '\x1bo', 'split=1 focus=panel')
  exposedOpen?.(id, { focus: true })
  check('f: a registered temporary panel opens by id', await settled(() => activeOf(s.state()) === id, { timeoutMs: 4000 }), s.state())
  setTemporarySidePanelHidden(id, true)
  check('f: hiding it removes it from the bar', await settled(() => activeOf(s.state()) !== id, { timeoutMs: 4000 }), s.state())
  setTemporarySidePanelHidden(id, false)
  exposedOpen?.(id, { focus: true })
  check('f: unhiding brings it back without a stored id', await settled(() => activeOf(s.state()) === id, { timeoutMs: 4000 }), s.state())
  await s.close()
  dispose()
}

// --- e. Esc returns focus to chat (real key path) --------------------------
{
  const s = await openSession(120)
  await press(s, '\x1bo', 'split=1 focus=panel')
  // e.1 Programmatic: the escape branch itself handles {escape:true}.
  const handledEsc = exposedHandleKey?.('', { escape: true }) ?? null
  await settled(() => exposedFocus === 'chat')
  check('e: handleKey({escape:true}) returns to chat focus (branch works)',
    handledEsc === true && exposedFocus === 'chat', 'handled=' + String(handledEsc) + ' focus=' + exposedFocus)
  await press(s, '\x1bo', 'split=1 focus=panel')
  // e.2 Real lone ESC arrives as {escape:true, meta:true} from this ink
  //     fork; the ctrl/meta fall-through guard exempts escape, so the key
  //     is consumed here and focus returns to chat (split stays open).
  await press(s, '\x1b', 'split=1 focus=chat')
  check('e: real Esc key returns focus to chat (stays open, handled)',
    s.state().includes('split=1 focus=chat') && s.state().includes('avail=1 handled=1'), s.state())
  // e.3 Three-state intact: alt+o re-focuses the panel, next press closes.
  await press(s, '\x1bo', 'split=1 focus=panel')
  check('e: alt+o after Esc re-focuses the panel', s.state().includes('split=1 focus=panel'), s.state())
  await press(s, '\x1bo', 'split=0 focus=chat')
  check('e: alt+o from panel focus closes and returns to chat',
    s.state().includes('split=0 focus=chat') && s.state().includes('chat=120 avail=1 handled=1'), s.state())
  await s.close()
}

// --- c. 90 columns: split unavailable, alt+o inert -----------------------
{
  const s = await openSession(90)
  check('c: 90 cols -> splitAvailable=false', s.state().includes('split=0 focus=chat zoom=0') && s.state().includes('chat=90 avail=0'), s.state())
  await press(s, '\x1bo', 'handled=0')
  check('c: alt+o returns false (chat would process it)', s.state().includes('handled=0') && chatKeyCount === 1, s.state())
  check('c: state unchanged (still closed, chat focus, chat=90)',
    s.state().includes('split=0 focus=chat zoom=0') && s.state().includes('chat=90'), s.state())
  await s.close()
}

// --- d. editorOpen=true: alt+o inert -------------------------------------
{
  const s = await openSession(120, true, true)
  check('d: editorOpen -> splitAvailable=false at 120 cols', s.state().includes('avail=0'), s.state())
  await press(s, '\x1bo', 'handled=0')
  check('d: alt+o returns false with the editor open', s.state().includes('handled=0') && chatKeyCount === 1, s.state())
  check('d: state unchanged', s.state().includes('split=0 focus=chat zoom=0') && s.state().includes('chat=120 avail=0'), s.state())
  await s.close()
}

if (failed > 0) {
  console.error('FAILED: ' + failed + ' check(s).')
  process.exit(1)
}
console.log('OK: side-panel keys all checks passed.')
process.exit(0)
