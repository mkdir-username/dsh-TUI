/**
 * The terminal's own paste of an IMAGE reaches the composer as an EMPTY
 * bracketed paste (the pasteboard holds no text to deliver) — Ghostty's
 * `super+v=paste_from_clipboard` writes the marker pair and nothing between.
 * The composer must read the clipboard itself and stage the bitmap, while a
 * text paste stays exactly as the terminal delivered it (no second insert).
 *
 * macOS only: it drives the real pasteboard (saved and restored here) and the
 * `osascript` clipboard backend. Other hosts skip with exit 0.
 *
 * Run: node --import tsx/esm scripts/verify-empty-paste-image.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'en'
import './lib/fake-home.mjs' // must stay first: DATA_DIR resolves at import time
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Writable, PassThrough } from 'node:stream'
import React from 'react'
import xtermHeadless from '@xterm/headless'
import * as ui from '../src/ui.js'
import { PromptInput } from '../src/components/PromptInput.js'
import { sleep, viewportLines } from './lib/term-test.mjs'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

let passed = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail !== '' ? `\n      ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

if (process.platform !== 'darwin') {
  console.log('SKIP: the empty-paste clipboard branch is exercised on macOS only')
  process.exit(0)
}

const SOURCE_PNG = join(here, '..', 'assets', 'whale-girl', 'whale-girl.png')
const EMPTY_PASTE = '\x1b[200~\x1b[201~'

const { Terminal: XTerm } = xtermHeadless

interface StageRequest { mediaType: string; name: string; path: string }

function makeHarness(cols: number, rows: number, staged: StageRequest[]) {
  const term = new XTerm({ cols, rows, scrollback: 200, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      term.write(String(chunk), callback)
    }
  }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode(): this { return this }
    setEncoding(): this { return this }
    ref(): this { return this }
    unref(): this { return this }
  }
  const channel = {
    mode: { id: 'default', plan: false },
    modeIndex: 0,
    cycleMode() {},
    commandList: [],
    commandCompletions: () => [],
    notifications: [],
    pending: [],
    working: false,
    notify() {},
    submit() {},
    steer() {},
    cancel() {},
    interruptAndDock() { return 0 },
    interruptAndDeliver() { return 0 },
    removePending() { return false },
    stageImage() {},
    stagedImageGeneration: () => 1,
    stagedImageLimits: () => ({
      maxImageBytes: 8 * 1024 * 1024,
      maxImagesPerMessage: 4,
      maxImageDimension: 8192,
      maxImagePixels: 64_000_000,
    }),
    stageComposerImage: async (input: StageRequest) => {
      staged.push(input)
      return { stageId: `stage-${staged.length}` }
    },
    hasStagedImage: () => true,
    discardStagedImage() {},
    stagedImage: () => undefined,
    listFiles: async () => [],
  }
  return { term, stdout: new FakeStdout(), stdin: new FakeStdin(), channel, rows }
}

async function mountComposer(harness: ReturnType<typeof makeHarness>) {
  const instance = await ui.render(
    React.createElement(PromptInput, {
      channel: harness.channel as never,
      helpOpen: false,
      onToggleHelp() {},
      onRunCommand() { return false },
      onRewindRequest() {},
      selectionActive: false,
    }),
    {
      stdout: harness.stdout as never,
      stderr: harness.stdout as never,
      stdin: harness.stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  )
  await sleep(400)
  return instance
}

const screenOf = (harness: ReturnType<typeof makeHarness>): string => viewportLines(harness.term, harness.rows).join('\n')

async function copyImage(): Promise<void> {
  const escaped = SOURCE_PNG.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await run('osascript', ['-e', `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`])
}

async function copyText(text: string): Promise<void> {
  await new Promise<void>(resolve => {
    const child = spawn('pbcopy')
    child.on('close', () => resolve())
    child.on('error', () => resolve())
    child.stdin.end(text)
  })
}

const savedClipboard = await run('pbpaste').then(result => result.stdout, () => '')

try {
  // ── an image-only clipboard stages as an attachment ──────────────────
  await copyImage()
  const imageStaged: StageRequest[] = []
  const imageHarness = makeHarness(80, 24, imageStaged)
  const imageComposer = await mountComposer(imageHarness)
  imageHarness.stdin.write(EMPTY_PASTE)
  await sleep(1200)
  const imageScreen = screenOf(imageHarness)
  check(
    'an empty paste over an image clipboard stages one attachment',
    imageStaged.length === 1 && imageStaged[0]?.mediaType === 'image/png',
    `staged=${JSON.stringify(imageStaged)}`,
  )
  check(
    'and the composer shows its [Image #1] token',
    imageScreen.includes('[Image #1]'),
    imageScreen,
  )
  imageComposer.unmount()
  imageHarness.term.dispose()
  await sleep(40)

  // ── a text clipboard is left to the terminal's own paste ─────────────
  await copyText('clipboard text the terminal already delivered')
  const textStaged: StageRequest[] = []
  const textHarness = makeHarness(80, 24, textStaged)
  const textComposer = await mountComposer(textHarness)
  textHarness.stdin.write(EMPTY_PASTE)
  await sleep(1200)
  const textScreen = screenOf(textHarness)
  check(
    'an empty paste over a text clipboard stages nothing',
    textStaged.length === 0 && !textScreen.includes('clipboard text the terminal'),
    `staged=${JSON.stringify(textStaged)}\n${textScreen}`,
  )
  textComposer.unmount()
  textHarness.term.dispose()
  await sleep(40)
} finally {
  await new Promise<void>(resolve => {
    const child = spawn('pbcopy')
    child.on('close', () => resolve())
    child.on('error', () => resolve())
    child.stdin.end(savedClipboard)
  })
}

if (failures > 0) {
  console.error(`empty-paste image probe FAILED — ${passed} passed, ${failures} failed`)
  process.exit(1)
}
console.log(`empty-paste image probe passed — ${passed} checks`)
