/**
 * Кто гоняет ре-рендер живого dsh-tui: брейкпоинт на рендере MessageList и
 * стек вызывающих. Работает по уже открытому инспектору (порт 9229), сигналы
 * не нужны, app не мутирует — только пауза/резюм на миллисекунды.
 *
 * usage: node /tmp/probe-live-driver.mjs <samples> <seconds> [line0]
 */
import fs from 'node:fs'

const SAMPLES = Number(process.argv[2] ?? 8)
const SECONDS = Number(process.argv[3] ?? 30)
const LINE0 = Number(process.argv[4] ?? 308)
const OUT = process.env.OUT ?? '/tmp/dsh-freeze/driver-stacks.json'
const URLREGEX = process.env.URLREGEX ?? 'components/MessageList\\.js$'

const list = await (await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(2000) })).json()
if (!Array.isArray(list) || list.length === 0) {
  console.error('no inspector target')
  process.exit(2)
}
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const listeners = new Map()
await new Promise((res, rej) => {
  ws.addEventListener('open', () => res())
  ws.addEventListener('error', () => rej(new Error('ws error')))
})
ws.addEventListener('message', event => {
  const msg = JSON.parse(String(event.data))
  if (msg.id === undefined) {
    const hook = listeners.get(msg.method)
    if (hook) hook(msg.params)
    return
  }
  const waiter = pending.get(msg.id)
  if (!waiter) return
  pending.delete(msg.id)
  msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const once = method => new Promise(resolve => {
  const hook = params => { listeners.delete(method); resolve(params) }
  listeners.set(method, hook)
})

const frameOf = frame => {
  const url = String(frame.url ?? '')
  const short = url === '' ? '(native)' : url.split('/').slice(-2).join('/')
  return `${frame.functionName || '(anon)'} @ ${short}:${(frame.location?.lineNumber ?? 0) + 1}`
}

await send('Debugger.enable')
await send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 })
const bp = await send('Debugger.setBreakpointByUrl', {
  lineNumber: LINE0,
  urlRegex: URLREGEX,
})
console.log('breakpoint', JSON.stringify(bp.locations ?? bp.breakpointId))

const startedAt = Date.now()
const hits = []
while (hits.length < SAMPLES && Date.now() - startedAt < SECONDS * 1000) {
  const paused = await Promise.race([
    once('Debugger.paused'),
    new Promise(resolve => setTimeout(() => resolve(null), Math.max(500, (SECONDS * 1000 - (Date.now() - startedAt))))),
  ])
  if (!paused) break
  const frames = (paused.callFrames ?? []).slice(0, 18).map(frameOf)
  const asyncFrames = []
  for (let level = paused.asyncStackTrace; level && asyncFrames.length < 12; level = level.parent) {
    for (const frame of level.callFrames ?? []) asyncFrames.push(frameOf(frame))
  }
  hits.push({ at: new Date().toISOString(), reason: paused.reason, data: paused.data ?? null, frames, asyncFrames })
  await send('Debugger.resume').catch(() => null)
}
await send('Debugger.removeBreakpoint', { breakpointId: bp.breakpointId }).catch(() => null)
await send('Debugger.disable').catch(() => null)
fs.writeFileSync(OUT, JSON.stringify(hits, null, 2))
console.log(`hits=${hits.length} → ${OUT}`)
for (const [index, hit] of hits.entries()) {
  console.log(`--- hit ${index + 1} (${hit.reason}) ---\n  ${hit.frames.join('\n  ')}`)
  if (hit.asyncFrames.length > 0) console.log(`  · · · async parent: ${hit.asyncFrames.join(' <- ')}`)
}
ws.close()
