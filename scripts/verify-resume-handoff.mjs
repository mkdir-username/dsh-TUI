/**
 * Headless regression for the two promises a restart makes to the user.
 *
 * 1. `resumeCommand` — the hint printed when a restart gives up must name a
 *    command that can actually serve the session. A launcher that names itself
 *    through `DSH_LAUNCHER` is replayed verbatim (it also carries the route's
 *    environment and patches); with no launcher, a session pinned to a route the
 *    bare composition does not mount says so instead of promising
 *    `dsh --config cordis.yml` (field evidence 2026-11-17: the resumed session
 *    died with `no adapter registered for provider "ollama"`).
 * 2. `handoffOwnerPid` — a replacement whose successor already owns the session
 *    performed the handoff. Its exit code must not be read as a spawn failure,
 *    which is what printed despair over a live TUI.
 *
 * Run after compile: node scripts/verify-resume-handoff.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LAUNCHER_ENV, resumeCommand } from '../lib/types/dsh-adapter/plugin.js'
import { handoffOwnerPid } from '../lib/types/update.js'

const SESSION = '7d4bda03-0ee7-4d56-a073-d7867083338a'
const OLLAMA = { provider: 'ollama', model: 'deepseek-v4.1-flash:1017-cloud' }
const DEEPSEEK = { provider: 'deepseek-official', model: 'deepseek-flash' }
const hadLauncher = process.env[LAUNCHER_ENV]
const restoreLauncher = () => {
  if (hadLauncher === undefined) delete process.env[LAUNCHER_ENV]
  else process.env[LAUNCHER_ENV] = hadLauncher
}

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

try {
  // 1. A named launcher is replayed whole — route flags and all.
  process.env[LAUNCHER_ENV] = 'ds --ollama'
  const replayed = resumeCommand(undefined, SESSION, OLLAMA)
  check(
    'named launcher is replayed verbatim',
    replayed === `DSH_TUI_RESUME_SESSION=${SESSION} ds --ollama`,
    replayed,
  )

  // 2. No launcher + a route the bare composition cannot mount: the hint keeps
  //    the composition but must say the route has to be supplied.
  delete process.env[LAUNCHER_ENV]
  const bare = resumeCommand(undefined, SESSION, OLLAMA)
  check('bare composition stays the fallback', bare.startsWith(`DSH_TUI_RESUME_SESSION=${SESSION} dsh --config cordis.yml`), bare)
  check('foreign route is called out by name', bare.includes('ollama'), bare)
  check('the user is told to reuse their own command', /same command/.test(bare), bare)

  // 3. A default-route preference keeps the hint short — no new noise.
  const plain = resumeCommand('dsh-tui', SESSION, DEEPSEEK)
  check(
    'default route adds no caution',
    plain === `DSH_TUI_RESUME_SESSION=${SESSION} dsh --profile dsh-tui`,
    plain,
  )

  // 4. Handoff detection: a live foreign owner is the successor.
  const owners = new Map([[SESSION, { pid: 76930, startedAt: 1, sessionIds: [SESSION] }]])
  check('successor owning the session is found', handoffOwnerPid(SESSION, [84432], owners) === 76930)
  check(
    'the exited child cannot vouch for itself',
    handoffOwnerPid(SESSION, [84432, 76930], owners) === undefined,
  )
  check('this process is never the successor', handoffOwnerPid(SESSION, [76930], owners) === undefined)
  check('no owner means no handoff', handoffOwnerPid('another-session', [84432], owners) === undefined)
  check('an empty session id looks nothing up', handoffOwnerPid('', [84432], owners) === undefined)

  // 5. Both resume entry points must resolve through the three-stage helper: a
  //    single fallback adopts the deployment route even when that route is the
  //    dead one the preference names. Source-level because driving a full
  //    context headlessly would test the fixture, not the wiring.
  const readers = {
    'channel/session-resume.ts': new URL('../src/dsh-adapter/channel/session-resume.ts', import.meta.url),
    'dsh-adapter/plugin.ts': new URL('../src/dsh-adapter/plugin.ts', import.meta.url),
  }
  for (const [name, url] of Object.entries(readers)) {
    const source = readFileSync(url, 'utf8')
    check(`${name} resolves routes through resumeModelRoute`, /resumeModelRoute\(llm,/.test(source))
  }
} finally {
  restoreLauncher()
}

if (failed > 0) {
  console.error(`\n${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll resume/handoff checks passed')
