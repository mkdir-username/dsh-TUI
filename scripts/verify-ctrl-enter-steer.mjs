/**
 * Headless verification of the Ctrl+Enter wiring: renders the compiled
 * PromptInput with a stub channel and injects `\x1b[13;5u` (CSI 13;5u — the
 * Ctrl+Enter a modern terminal sends), asserting that a NON-EMPTY draft takes
 * the Enter main path (submit, no abort) while an EMPTY draft keeps the
 * interrupt role.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-ctrl-enter-steer.mjs
 */
import './lib/fake-home.mjs' // must stay first: DATA_DIR resolves at import time
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import { render } from '../lib/types/ui.js'
import { PromptInput } from '../lib/types/components/PromptInput.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStreams() {
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdout.frames.push(String(chunk))
      cb()
    },
  })
  stdout.columns = 100
  stdout.rows = 30
  stdout.isTTY = true
  stdout.frames = []
  const stderr = new Writable({ write(_c, _e, cb) { cb() } })
  stderr.isTTY = true
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.setEncoding = () => stdin
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  return { stdout, stderr, stdin }
}

function makeChannel() {
  const submitted = []
  const interrupts = []
  const notifications = []
  return {
    working: false,
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() { return Promise.resolve() },
    commandList: [],
    notifications,
    contextWindow: undefined,
    pending: [],
    notify(text, options) { notifications.push({ text, options }) },
    submit(text) { submitted.push(text) },
    steer() {},
    removePending: () => true,
    cancel() { interrupts.push('cancel') },
    cancelPending: false,
    interruptAndDeliver() { interrupts.push('interruptAndDeliver'); return 0 },
    listFiles: async () => [],
    submitted,
    interrupts,
  }
}

const renderInput = async (channel, streams) => render(
  React.createElement(PromptInput, {
    channel,
    helpOpen: false,
    onToggleHelp() {},
    onRunCommand: () => false,
    selectionActive: false,
  }),
  { stdout: streams.stdout, stderr: streams.stderr, stdin: streams.stdin, exitOnCtrlC: false, patchConsole: false },
)

// ── 1. a non-empty draft is the Enter main path: submit, never abort ───────
{
  const streams = makeStreams()
  const channel = makeChannel()
  const instance = await renderInput(channel, streams)
  await sleep(600) // fixed window: let the first frame settle before the keys
  streams.stdin.write('hello')
  await sleep(150) // fixed window: the draft must land in the editor first
  streams.stdin.write('\x1b[13;5u')
  await sleep(300) // fixed window: one Ctrl+Enter may only submit once
  check('Ctrl+Enter submits a non-empty draft', channel.submitted.length === 1, JSON.stringify(channel.submitted))
  check('Ctrl+Enter does not interrupt with a draft', channel.interrupts.length === 0, JSON.stringify(channel.interrupts))
  instance.unmount()
}

// ── 2. an empty draft keeps the interrupt role ─────────────────────────────
{
  const streams = makeStreams()
  const channel = makeChannel()
  const instance = await renderInput(channel, streams)
  await sleep(600) // fixed window: no draft at all, only the key
  streams.stdin.write('\x1b[13;5u')
  await sleep(300) // fixed window: the empty branch answers, it does not submit
  check('Ctrl+Enter on an empty draft does not submit', channel.submitted.length === 0, JSON.stringify(channel.submitted))
  check(
    'Ctrl+Enter on an empty draft answers as the interrupt path',
    channel.notifications.some(item => /empty|пуст/i.test(item.text)),
    JSON.stringify(channel.notifications.map(item => item.text)),
  )
  instance.unmount()
}

console.log(failed === 0 ? 'ctrl-enter-steer battery OK' : `ctrl-enter-steer battery FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
