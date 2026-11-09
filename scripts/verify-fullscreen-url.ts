/**
 * verify-fullscreen-url — Cmd+Click URL detection on the rendered screen.
 *
 * Fullscreen mode owns the mouse, so the terminal's own URL hinting never
 * runs: `findPlainTextUrlAt` scans the cell row instead. A backslash starts a
 * shell escape, not part of a literal URL — a run that swallowed it handed
 * the opener a broken target (`https://x.example/y\`).
 *
 * Run: node --import tsx/esm scripts/verify-fullscreen-url.ts
 */
import React from 'react'
import { renderToScreen } from '../src/ink/render-to-screen.js'
import { findPlainTextUrlAt } from '../src/ink/selection.js'
import { Text } from '../src/ui.js'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
  if (!ok) failures += 1
}

const WIDTH = 60
const cases: ReadonlyArray<readonly [string, string, string]> = [
  ['shell escape ends the URL', 'see https://x.example/y\\ z', 'https://x.example/y'],
  ['plain URL keeps its path', 'see https://x.example/y z', 'https://x.example/y'],
  ['backslash before the path stays out', 'run https://x.example\\y z', 'https://x.example'],
]

for (const [name, line, expected] of cases) {
  const { screen } = renderToScreen(React.createElement(Text, null, line), WIDTH)
  const col = line.indexOf('https://') + 'https://'.length
  const url = findPlainTextUrlAt(screen, col, 0)
  check(name, url === expected, JSON.stringify({ url, expected }))
}

if (failures > 0) {
  console.error(`verify-fullscreen-url: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-fullscreen-url: all checks passed')
