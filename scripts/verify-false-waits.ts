/**
 * CI gate for the false-waits catalog: every blocking surface dsh can show the
 * user must have a row in `docs/false-waits.en.md` AND a live code anchor. The
 * anchor is what keeps the catalog honest — a core upgrade moves the string and
 * this gate fails, asking for a re-read instead of letting the document drift
 * away from the code it describes.
 *
 * Run via `node --import tsx/esm scripts/verify-false-waits.ts`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DOC = resolve(ROOT, 'docs/false-waits.en.md')
const HOME = homedir()
const DSH_PACKAGES = resolve(HOME, '.bun/install/global/node_modules/@deepseek-ai')

/** Surfaces whose call waits under the hood. The catalog is keyed by these ids. */
const SURFACES = [
  'job_output-wait',
  'bash-foreground',
  'delegate-wait',
  'heavy-slot',
  'workflow',
  'job_kill',
  'ask_user_question',
  'mcp-long-call',
] as const

type Surface = (typeof SURFACES)[number]

interface Anchor {
  readonly file: string
  readonly pattern: string
}

const ANCHORS: Record<Surface, Anchor> = {
  'job_output-wait': { file: resolve(DSH_PACKAGES, 'dsh-tool-jobs/lib/index.js'), pattern: 'releasedBy = "user steered"' },
  'bash-foreground': { file: resolve(DSH_PACKAGES, 'dsh-tool-bash/lib/index.js'), pattern: 'waitOnJob' },
  // The delegation plugin lives outside this repository (a personal dotfiles
  // plugin), so the anchor is the TUI half of the seam: the symbol the plugin
  // publishes and this package asks. A rename on either side fails here.
  'delegate-wait': { file: resolve(ROOT, 'src/dsh-adapter/tool-park.ts'), pattern: 'dsh.delegate-park' },
  'heavy-slot': { file: resolve(HOME, '.claude/bin/heavy-slot'), pattern: 'HEAVY_SLOT_TIMEOUT' },
  workflow: { file: resolve(DSH_PACKAGES, 'dsh-tool-workflow/lib/index.js'), pattern: 'jobs.start' },
  job_kill: { file: resolve(DSH_PACKAGES, 'dsh-tool-jobs/lib/index.js'), pattern: 'already-finished' },
  ask_user_question: { file: resolve(DSH_PACKAGES, 'dsh-tool-ask-user/lib/index.js'), pattern: 'pendingNotice' },
  'mcp-long-call': { file: resolve(HOME, '.dsh/cordis.patch.yml'), pattern: 'toolCallTimeouts' },
}

let failed = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

if (!existsSync(DOC)) {
  check('docs/false-waits.en.md exists', false, DOC)
} else {
  const catalog = readFileSync(DOC, 'utf8')
  for (const surface of SURFACES) {
    check(`catalog row: ${surface}`, catalog.includes(`| \`${surface}\``))
    const anchor = ANCHORS[surface]
    const source = existsSync(anchor.file) ? readFileSync(anchor.file, 'utf8') : ''
    check(`anchor: ${surface}`, source.includes(anchor.pattern), anchor.file)
  }
}

if (failed === 0) console.log('All false-waits checks passed.')
else console.log(`${failed} FAIL`)
process.exit(failed === 0 ? 0 : 1)
