/**
 * 登录赠金弹窗回归（`WhaleCouponPrompt`）：宽屏女仆娘、窄屏文案、
 * 展示后回执与 Esc 关闭。
 * 运行：node --import tsx/esm scripts/verify-coupon-prompt.tsx
 */
import React from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WhaleCouponStore } from '../src/dsh-adapter/oauth/bonus.js'

process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'
// HOME/USERPROFILE 指到空夹具目录：DATA_DIR（~/.dsh-tui）不碰真实数据。
const fixtureHome = mkdtempSync(join(tmpdir(), 'verify-coupon-prompt-'))
process.env.HOME = fixtureHome
process.env.USERPROFILE = fixtureHome

const [
  { PassThrough, Writable },
  { render, ThemeProvider, Box },
  { Chat },
  { createChannel },
  { QuestionStore },
  { LOCAL_COMMANDS },
  { WhaleCouponStore: CouponStore },
  { settle, settled, sleep },
] = await Promise.all([
  import('node:stream'),
  import('../src/ui.js'),
  import('../src/screens/Chat.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/questions.js'),
  import('../src/commands.js'),
  import('../src/dsh-adapter/oauth/bonus.js'),
  import('./lib/term-test.mjs'),
])

let failures = 0
let checks = 0
function check(name: string, ok: boolean, extra = ''): void {
  checks += 1
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failures++
    console.error(`  ✗ ${name}${extra ? `  (${extra})` : ''}`)
  }
}

class FakeStdout extends Writable {
  columns: number
  rows = 30
  isTTY = true
  frames: string[] = []
  constructor(columns: number) {
    super()
    this.columns = columns
  }
  _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    this.frames.push(String(chunk))
    callback()
  }
}

class FakeStderr extends Writable {
  isTTY = true
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void) {
    callback()
  }
}

class FakeStdin extends PassThrough {
  isTTY = true
  setRawMode() { return this }
  ref() { return this }
  unref() { return this }
}

const plainText = (frames: readonly string[]) => frames
  .join('')
  .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(Number(n)))
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\]9;[^\x07]*\x07/g, '')

// smoke.tsx 形状的 fake channel：Chat 只读它渲染要用的面。
function makeChatChannel() {
  return {
    version: 0,
    whaleIdle: false,
    rows: [],
    status: 'idle' as const,
    sessionTitle: 'probe',
    agentId: 'probe',
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    tokens: { input: 0, output: 0 },
    cwd: 'C:/code/demo-project',
    displayCwd: 'C:/code/demo-project',
    gitBranch: 'main',
    working: false,
    spinnerMode: 'requesting' as const,
    mode: { plan: false },
    responseChars: 0,
    activeToolCount: 0,
    turnStart: 0,
    lastUserText: '',
    pending: [],
    notifications: [],
    commandList: LOCAL_COMMANDS,
    contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 },
    subscribe: () => () => {},
    submit() {},
    steer() {},
    cancel() {},
    clear() {},
    notify() {},
    listModels: () => Promise.resolve([]),
    listSessions: () => [],
    setResumeTarget: () => {},
  }
}

interface ChatHandle {
  stdout: FakeStdout
  stdin: FakeStdin
  plain: () => string
  unmount: () => Promise<void>
}

async function mountChat(bonusNotices: WhaleCouponStore, columns: number): Promise<ChatHandle> {
  const stdout = new FakeStdout(columns)
  stdout.rows = 28
  const stdin = new FakeStdin()
  const instance = await render(
    // Chat 包在**视口大小**的盒子里：真实运行时是 alt-screen（根=整屏），
    // 而内联夹具的根只有内容高——弹窗卡片是 absolute 且贴根底，根太矮时
    // 卡片顶端会被裁掉（实测标题整行消失）。包一层即等价于真机的根。
    <Box width={columns} height={28} flexDirection="column">
      <Chat channel={makeChatChannel() as never} questionStore={new QuestionStore()}
        bonusNotices={bonusNotices} />
    </Box>,
    { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
  )
  return {
    stdout,
    stdin,
    plain: () => plainText(stdout.frames),
    unmount: async () => { await instance.unmount() },
  }
}

// 服务器确认的登录赠金：画出后才确认订单。
for (const columns of [100, 40]) {
  const coupons = new CouponStore()
  const acknowledgements: string[] = []
  const chat = await mountChat(coupons, columns)
  await coupons.refresh({
    getUnnotifiedBonuses: async () => ({ accountId: 'account-1' as never, bonuses: [{
      orderId: 'coupon-1' as never, campaign: 'dsh_login_bonus', amount: '6.00', currency: 'CNY',
      grantedAt: '2099-09-30T00:00:00Z', expiresAt: '2099-10-06T12:15:00Z', message: 'server copy',
    }] }),
    ackBonusNotified: async (_accountId, orderId) => { acknowledgements.push(orderId); return true },
  })
  check(`K${columns}: coupon modal uses the confirmed amount and Beijing expiry`,
    await settled(() => chat.plain().includes('DeepSeek 送你的') && chat.plain().includes('6 元')
      && chat.plain().includes('Deepy提醒') && chat.plain().includes('10 月 6 日 20:15'), { timeoutMs: 5000 }))
  check(`K${columns}: coupon notice is acknowledged once after display`,
    await settled(() => acknowledgements.length === 1))
  const art = chat.stdout.frames.join('')
  check(`K${columns}: the heart-pose maid fits only the wide modal`,
    (art.includes('253;162;169') || art.includes('244;119;167')) === (columns === 100))
  await sleep(150) // 固定窗:pacing 弹窗输入订阅晚于首次绘制
  chat.stdin.write('\u001b')
  check(`K${columns}: Esc dismisses the coupon modal`,
    await settled(() => coupons.getSnapshot() === null))
  await chat.unmount()
}

rmSync(fixtureHome, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\n${failures} of ${checks} coupon-prompt checks FAILED.`)
  process.exit(1)
}
console.log(`\nAll ${checks} coupon-prompt checks passed.`)
