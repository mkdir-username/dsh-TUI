/**
 * macOS end-to-end check for {@link readClipboard}'s image branch: whatever
 * image class the clipboard offers, the composer must receive a path its
 * attachment profile accepts (PNG/JPEG/WebP/GIF). A TIFF-only copy — Preview's
 * "Copy", several browsers — used to come back as `.tiff` and was refused as
 * an unsupported format even though macOS can convert it losslessly.
 *
 * Runs against the real pasteboard, so it saves what was there and puts it
 * back. Non-macOS hosts skip (exit 0): the platform branch under test does not
 * exist there.
 */

import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { imagePathMediaType } from '../src/utils/pastedImagePath.js'
import { readClipboard } from '../src/utils/clipboard.js'

const run = promisify(execFile)

if (process.platform !== 'darwin') {
  console.log('SKIP: readClipboard image branch is a macOS-only path')
  process.exit(0)
}

const here = dirname(fileURLToPath(import.meta.url))

/** A small PNG shipped with the package; converted to TIFF in the temp dir. */
const SOURCE_PNG = join(here, '..', 'assets', 'whale-girl', 'whale-girl.png')

let failures = 0

function check(label: string, problem: string | undefined): void {
  if (problem === undefined) {
    console.log(`PASS: ${label}`)
    return
  }
  failures += 1
  console.log(`FAIL: ${label} — ${problem}`)
}

/** Put an image FILE on the clipboard as the given pasteboard class. */
async function copyAs(path: string, appleClass: 'PNGf' | 'TIFF'): Promise<void> {
  const escaped = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await run('osascript', ['-e', `set the clipboard to (read (POSIX file "${escaped}") as «class ${appleClass}»)`])
}

/** Assert the clipboard read produced a stageable image of the expected type. */
async function expectStageableImage(label: string, mime: string): Promise<void> {
  const content = await readClipboard()
  if (content === null) {
    check(label, 'clipboard read returned null')
    return
  }
  if (content.kind !== 'image') {
    check(label, `expected an image offer, got "${content.kind}"`)
    return
  }
  const mediaType = imagePathMediaType(content.path)
  if (mediaType !== mime) {
    check(label, `staged "${content.path}" has media type ${String(mediaType)}, expected ${mime}`)
    return
  }
  const bytes = await readFile(content.path)
  const header = bytes.subarray(0, 4).toString('hex')
  if (mime === 'image/png' && header !== '89504e47') {
    check(label, `staged file is not a PNG (header ${header})`)
    return
  }
  check(label, undefined)
}

const savedText = await run('pbpaste').then(result => result.stdout, () => '')
const tiffPath = join(process.env.TMPDIR ?? '/tmp', `dsh-tui-clipboard-probe-${process.pid}.tiff`)

try {
  await run('sips', ['-s', 'format', 'tiff', SOURCE_PNG, '--out', tiffPath])

  await copyAs(SOURCE_PNG, 'PNGf')
  await expectStageableImage('a PNGf clipboard stages as a PNG image', 'image/png')

  await copyAs(tiffPath, 'TIFF')
  const tiffInfo = await run('osascript', ['-e', 'clipboard info']).then(result => result.stdout, () => '')
  if (/«class PNGf»/.test(tiffInfo)) {
    console.log(`SKIP: this host coerces the TIFF copy to PNGf (${tiffInfo.trim()})`)
  } else {
    await expectStageableImage('a TIFF-only clipboard stages as a PNG image', 'image/png')
  }
} finally {
  await new Promise<void>(resolve => {
    const child = spawn('pbcopy')
    child.on('close', () => resolve())
    child.on('error', () => resolve())
    child.stdin.end(savedText)
  })
}

if (failures > 0) {
  console.error(`clipboard darwin probe FAILED — ${failures} check(s)`)
  process.exit(1)
}
console.log('clipboard darwin probe passed')
