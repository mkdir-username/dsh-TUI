/**
 * `/` 命令补全的两处体验缺口回归。
 *
 *   1. 缩写要能命中：`/toti` → `to-tickets`（跳过 `-` 的前缀），`/cmp` →
 *      `compact`（子序列），`/tt` → `to-tickets`；精确与普通前缀仍排在模糊
 *      之前（`/t` 先给 `to-tickets`、`tree`），空查询保持目录原序。
 *   2. 补全按**光标所在的 `/…` run** 触发，不再要求 `/` 在草稿开头：
 *      `please summarize /toti` 也弹菜单；Tab/Enter 只替换那一段 run，前后
 *      散文原样保留；Esc 只收菜单、不清草稿；行首 `Enter` 仍直接执行命令。
 *
 * 命中口径（`matchCompletionName`）与候选过滤（`completeCommands`）共用一套
 * 分级，提亮段也由它返回：`to-tickets` 命中 `toti` 时提亮 `to-ti`，`compact`
 * 命中 `cmp` 时逐段提亮 `c`、`mp`，嵌套路径 `model deepseek-chat` 命中 `de`
 * 时只亮末段（不误亮 model 里的 d/e）。
 *
 * 运行：node --import tsx/esm scripts/verify-command-completion.tsx
 */
import './lib/fake-home.mjs' // must stay first: DATA_DIR resolves at import time

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
process.env.DSH_TUI_THEME = 'dark'

const [
  { PassThrough, Writable },
  React,
  { Terminal: XTerm },
  { render, AlternateScreen, Box },
  { PromptInput },
  { completeCommands, commandCompletionAt, commandPathResolver, matchCompletionName },
  { settled, sleep, viewportLines },
  instances,
] = await Promise.all([
  import('node:stream'),
  import('react'),
  import('@xterm/headless'),
  import('../src/ui.js'),
  import('../src/components/PromptInput.js'),
  import('../src/commands.js'),
  import('./lib/term-test.mjs'),
  import('../src/ink/instances.js').then(module => module.default),
])

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const ROWS = 30
const COMMANDS = [
  { name: 'new', description: 'Start a new conversation' },
  { name: 'compact', description: 'Summarize earlier turns' },
  { name: 'model', description: 'Show the active model' },
  { name: 'to-tickets', description: 'Break a plan into tickets' },
  { name: 'tree', description: 'Browse the session family tree' },
]

const names = (input: string): string[] => completeCommands(input, COMMANDS).map(command => command.name)
const spans = (name: string, query: string) => matchCompletionName(name, query)?.segments

// ── 1. 模糊/缩写命中与排序 ────────────────────────────────────────────────
check('/toti 命中 to-tickets', names('/toti').join() === 'to-tickets', JSON.stringify(names('/toti')))
check('/cmp 子序列命中 compact', names('/cmp').join() === 'compact', JSON.stringify(names('/cmp')))
check('普通的 `/t` 仍先给前缀命中（目录序），模糊行排在其后',
  names('/t').slice(0, 2).join() === 'to-tickets,tree',
  JSON.stringify(names('/t')))
check('空查询保持目录原序', names('/').join() === COMMANDS.map(command => command.name).join(),
  JSON.stringify(names('/')))
check('参数位候选不受影响（/model dee）',
  completeCommands('/model dee', COMMANDS, () => [{ name: 'deepseek-chat', description: 'm' }])
    .map(command => command.name).join() === 'model deepseek-chat')
check('参数目录不做子序列模糊（/model dsk 不出候选，spec 列表不被拖进来）',
  completeCommands('/model dsk', COMMANDS, () => [{ name: 'deepseek-chat', description: 'm' }]).length === 0)
check('参数目录不做分隔符折叠（/model deepseekchat 不出候选）',
  completeCommands('/model deepseekchat', COMMANDS, () => [{ name: 'deepseek-chat', description: 'm' }]).length === 0)
check('参数目录按候选开头匹配，末段 `/` 不生效（/model pa 不匹配 @scope/package）',
  completeCommands('/model pa', COMMANDS, () => [{ name: '@scope/package@1.2.3', description: 'p' }]).length === 0,
  JSON.stringify(completeCommands('/model pa', COMMANDS, () => [{ name: '@scope/package@1.2.3', description: 'p' }])))
check('单字符查询不做子序列匹配（不把整张目录倒出来）',
  names('/z').length === 0, JSON.stringify(names('/z')))

// 提亮段与候选过滤共用一套分级。
check('`toti` 的提亮覆盖到最后一个命中字符（to-ti）',
  JSON.stringify(spans('to-tickets', 'toti')) === JSON.stringify([{ start: 0, length: 5 }]),
  JSON.stringify(spans('to-tickets', 'toti')))
check('`cmp` 逐段提亮 compact', JSON.stringify(spans('compact', 'cmp')) === JSON.stringify([
  { start: 0, length: 1 }, { start: 2, length: 2 },
]), JSON.stringify(spans('compact', 'cmp')))
check('嵌套路径按末段命中，不误亮 model 里的 d/e',
  JSON.stringify(spans('model deepseek-chat', 'de')) === JSON.stringify([{ start: 6, length: 2 }]),
  JSON.stringify(spans('model deepseek-chat', 'de')))
check('前缀命中仍从头提亮', JSON.stringify(spans('to-tickets', 'to-ti')) === JSON.stringify([{ start: 0, length: 5 }]))

// ── 2. 光标处的命令 run ───────────────────────────────────────────────────
const resolverFor = (
  roots: typeof COMMANDS,
  children: (path: readonly string[]) => readonly { name: string; description?: string }[] = () => [],
) => commandPathResolver(input => completeCommands(input, roots, children))
const at = (value: string, cursor: number, resolves = resolverFor(COMMANDS)) =>
  commandCompletionAt(value, cursor, resolves)
check('消息中间的 /toti 有补全位置',
  JSON.stringify(at('please /toti', 12)) === JSON.stringify({ start: 7, end: 12, input: '/toti' }),
  JSON.stringify(at('please /toti', 12)))
check('光标在参数里时 run 从 `/` 开始',
  JSON.stringify(at('see /model de', 13)) === JSON.stringify({ start: 4, end: 13, input: '/model de' }),
  JSON.stringify(at('see /model de', 13)))
check('多行草稿里光标所在行的命令也有补全位置',
  JSON.stringify(at('line one\nrun /toti', 18)) === JSON.stringify({ start: 13, end: 18, input: '/toti' }),
  JSON.stringify(at('line one\nrun /toti', 18)))
check('多行草稿只取光标所在行，不跨行拼接',
  JSON.stringify(at('/model\nrest /toti', 17)) === JSON.stringify({ start: 12, end: 17, input: '/toti' }),
  JSON.stringify(at('/model\nrest /toti', 17)))
check('散文里的前一个 `/` 不挡后一个命令（/help then /model）',
  JSON.stringify(at('first /help then /model', 23)) === JSON.stringify({ start: 17, end: 23, input: '/model' }),
  JSON.stringify(at('first /help then /model', 23)))
check('路径形状的 token 不挡后面的命令（/usr/bin … /toti）',
  JSON.stringify(at('see /usr/bin and /toti', 22)) === JSON.stringify({ start: 17, end: 22, input: '/toti' }),
  JSON.stringify(at('see /usr/bin and /toti', 22)))
check('token 中间的 `/` 不触发（foo/bar）', at('see foo/bar', 10) === undefined)
check('光标在 `/` 之前的散文里不触发', at('please /toti', 3) === undefined)
const proseSite = commandCompletionAt('see /model de now', 17)
check('run 之后的散文不产生候选',
  proseSite !== undefined && completeCommands(proseSite.input, COMMANDS).length === 0)
const pathSite = commandCompletionAt('see /usr/bin', 12)
check('路径形状的 token 没有命令候选',
  pathSite !== undefined && completeCommands(pathSite.input, COMMANDS).length === 0)
const pluginRoots = [{ name: 'plugin', description: 'p' }]
const pluginChildren = (path: readonly string[]) =>
  path.length === 1 && path[0] === 'plugin' ? [{ name: 'info' }, { name: 'install' }] : []
const pluginResolve = resolverFor(pluginRoots, pluginChildren)
const specSite = commandCompletionAt('/plugin info /p', 15, pluginResolve)!
check('参数里的 `/` 不另起命令 run（/plugin info /p）',
  JSON.stringify(specSite) === JSON.stringify({ start: 0, end: 15, input: '/plugin info /p' }),
  JSON.stringify(specSite))
check('参数里的 `/p` 不会被当成根命令补全',
  completeCommands(specSite.input, pluginRoots, pluginChildren).length === 0,
  JSON.stringify(completeCommands(specSite.input, pluginRoots, pluginChildren)))

// ── 3. 真实 composer：菜单、Tab 拼接、Esc、Enter ─────────────────────────
function makeChannel() {
  const runs: string[] = []
  const submitted: string[] = []
  return {
    working: false,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: COMMANDS,
    commandCompletions: (input: string) => completeCommands(input, COMMANDS, path =>
      path[0] === 'model' ? [{ name: 'deepseek-chat', description: 'm' }] : []),
    notifications: [],
    pending: [],
    contextWindow: undefined,
    ready: true,
    notify() {},
    submit(text: string) { submitted.push(text) },
    steer(text: string) { submitted.push(text) },
    removePending() { return false },
    cancel() {},
    interruptAndDeliver() { return 0 },
    listFiles: async () => [],
    runs,
    submitted,
  }
}

async function boot(cols: number) {
  const term = new XTerm({ cols, rows: ROWS, scrollback: 0, allowProposedApi: true })
  const frames: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      frames.push(String(chunk))
      term.write(String(chunk), callback)
    },
  })
  stdout.columns = cols
  stdout.rows = ROWS
  stdout.isTTY = true
  const stderr = new Writable({ write(_c, _e, callback) { callback() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const channel = makeChannel()
  // 浮窗向上生长（OverlayAbove bottom:'100%'）：把输入框撑到屏幕底部，
  // 否则裸渲染会贴着顶边、浮窗被裁光（沿用 verify-command-hold-overlay）。
  const tree = React.createElement(
    AlternateScreen,
    null,
    React.createElement(
      Box,
      { flexDirection: 'column', height: '100%' },
      React.createElement(Box, { flexGrow: 1 }),
      React.createElement(PromptInput, {
        channel,
        helpOpen: false,
        onToggleHelp() {},
        onRunCommand: (name: string) => { channel.runs.push(name); return true },
        selectionActive: false,
      }),
    ),
  )
  const instance = await render(tree, { stdout, stderr, stdin, exitOnCtrlC: false, patchConsole: false })
  const ink = instances.get(stdout)
  instances.set(process.stdout, ink)
  instance.rerender(tree)
  ink?.setAltScreenActive(true, true)
  return { stdin, channel, instance, lines: () => viewportLines(term) }
}

/** 卡片内的命令行行号：`│` 边框 + 名字紧跟留白/指针。 */
function rowOf(lines: readonly string[], name: string): number {
  return lines.findIndex(line => new RegExp(`^│\\s+(?:❯ )?${name}(?:\\s|$)`).test(line))
}

/**
 * 草稿行是否包含 text。同一进程里第二个及以后的实例，输入行会落在上一帧
 * 顶边框的那一行上（headless 里 alt-screen 首帧与 rerender 的竞态），空白
 * 格保留边框的 `─` 填充；断言只关心文本，所以先把填充读回空格。
 */
function draftHas(lines: readonly string[], text: string): boolean {
  return lines.some(line => line.replace(/─/gu, ' ').includes(text))
}

async function run(): Promise<void> {
  // 消息中间触发 + Tab 只替换 run。
  const mid = await boot(100)
  mid.stdin.write('please summarize /toti')
  check('消息中间输入 /toti 也弹出命令菜单',
    await settled(() => rowOf(mid.lines(), 'to-tickets') >= 0),
    JSON.stringify(mid.lines().filter(line => line.includes('to-tickets'))))
  mid.stdin.write('\t')
  check('Tab 只替换命令 run，前后散文原样保留',
    await settled(() => mid.lines().some(line => line.includes('please summarize /to-tickets'))),
    JSON.stringify(mid.lines().filter(line => line.includes('please'))))
  check('接受后浮窗关闭',
    await settled(() => rowOf(mid.lines(), 'to-tickets') < 0))
  mid.instance.unmount()

  // 多行草稿：光标所在行的命令也弹菜单；Tab 只替换那一段，Enter 发送正文。
  const multiline = await boot(100)
  multiline.stdin.write('line one\x1b[13;2u')
  multiline.stdin.write('run /toti')
  check('多行草稿中光标行的 /toti 也弹出命令菜单',
    await settled(() => rowOf(multiline.lines(), 'to-tickets') >= 0),
    JSON.stringify(multiline.lines().filter(line => line.includes('to-tickets'))))
  multiline.stdin.write('\t')
  check('多行草稿 Tab 只替换命令 run，前后正文保留',
    await settled(() => draftHas(multiline.lines(), 'line one')
      && draftHas(multiline.lines(), 'run /to-tickets')),
    JSON.stringify(multiline.lines().filter(line => line.includes('line') || line.includes('run'))))
  multiline.stdin.write('\r')
  check('多行草稿补全后的 Enter 发送正文，不派发命令',
    await settled(() => multiline.channel.runs.length === 0
      && multiline.channel.submitted.length === 1
      && multiline.channel.submitted[0]?.includes('run /to-tickets')),
    JSON.stringify({ runs: multiline.channel.runs, submitted: multiline.channel.submitted }))
  multiline.instance.unmount()

  // 同一行先有一个命令/路径时，后一个 `/` 仍按光标所在 run 补全。
  const second = await boot(100)
  second.stdin.write('first /help then /model')
  check('散文里的前一个命令不挡后一个命令的菜单',
    await settled(() => rowOf(second.lines(), 'model') >= 0),
    JSON.stringify(second.lines().filter(line => line.includes('model'))))
  second.stdin.write('\t')
  check('Tab 只替换后一个命令，前文原样保留',
    await settled(() => draftHas(second.lines(), 'first /help then /model')),
    JSON.stringify(second.lines().filter(line => line.includes('first'))))
  second.instance.unmount()

  // Esc 只收菜单，草稿不动。
  const esc = await boot(100)
  esc.stdin.write('please /toti')
  await settled(() => rowOf(esc.lines(), 'to-tickets') >= 0)
  esc.stdin.write('\x1b')
  check('Esc 只收菜单，不清消息',
    await settled(() => rowOf(esc.lines(), 'to-tickets') < 0
      && draftHas(esc.lines(), 'please /toti')),
    JSON.stringify(esc.lines().filter(line => line.includes('please'))))
  esc.instance.unmount()

  // 行首 Enter 仍是「执行选中的命令」。
  const start = await boot(100)
  start.stdin.write('/toti')
  await settled(() => rowOf(start.lines(), 'to-tickets') >= 0)
  start.stdin.write('\r')
  check('行首 Enter 仍直接执行命令',
    await settled(() => start.channel.runs.at(-1) === 'to-tickets'),
    JSON.stringify(start.channel.runs))
  start.instance.unmount()

  // 消息里的 Enter 只补全，第二次 Enter 才发送。
  const enter = await boot(100)
  enter.stdin.write('send this /toti')
  await settled(() => rowOf(enter.lines(), 'to-tickets') >= 0)
  enter.stdin.write('\r')
  check('消息里的 Enter 只补全、不派发命令',
    await settled(() => enter.channel.runs.length === 0
      && draftHas(enter.lines(), 'send this /to-tickets')),
    JSON.stringify({ runs: enter.channel.runs, submitted: enter.channel.submitted }))
  // 固定窗:墙钟 Enter 的 80ms 去抖窗口本身是被测语义——等它过期再按第二次。
  await sleep(120)
  enter.stdin.write('\r')
  check('补全后的第二次 Enter 正常发送',
    await settled(() => enter.channel.submitted.includes('send this /to-tickets')),
    JSON.stringify(enter.channel.submitted))
  enter.instance.unmount()

  // 命令片段没覆盖整份草稿时，Enter 只补全，不执行、也不丢尾文。
  const tail = await boot(100)
  tail.stdin.write('/model de keep this')
  await settled(() => draftHas(tail.lines(), 'keep this'))
  // 光标移到 `de` 之后（10 个左键），让菜单停在命令 run 上。
  tail.stdin.write('\x1b[D'.repeat(10))
  await settled(() => rowOf(tail.lines(), 'deepseek-chat') >= 0)
  tail.stdin.write('\r')
  check('命令后面还有正文时，Enter 只补全不执行',
    await settled(() => tail.channel.runs.length === 0
      && draftHas(tail.lines(), 'keep this')
      && draftHas(tail.lines(), 'deepseek-chat')),
    JSON.stringify({ runs: tail.channel.runs, submitted: tail.channel.submitted }))
  tail.instance.unmount()

  // 同一批 stdin 里先改了草稿，Tab 不得接受上一帧的候选。
  const stale = await boot(100)
  stale.stdin.write('/mo')
  await settled(() => rowOf(stale.lines(), 'model') >= 0)
  stale.stdin.write('x\t')
  check('编辑后 Tab 不接受过期候选',
    await settled(() => draftHas(stale.lines(), '/mox')),
    JSON.stringify(stale.lines().filter(line => line.includes('mo'))))
  stale.instance.unmount()

  console.log(failed === 0 ? 'verify-command-completion OK' : `verify-command-completion: ${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

await run()
