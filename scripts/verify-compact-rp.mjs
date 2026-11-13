/**
 * Headless check of the restruct-plan verdict that gates `/compact`: the marker
 * closing the fork may arrive human-shaped (`RP_SKIP: reason`, `**RP_DONE x**`,
 * a list item), while a marker that is not the last line or an abnormal fork
 * stop still blocks the compaction.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-compact-rp.mjs
 */
import { readFileSync } from 'node:fs'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const source = readFileSync(new URL('../lib/types/dsh-adapter/channel/compaction.js', import.meta.url), 'utf8')
const body = source.match(/^ {4}function restructPlanVerdict\([\s\S]*?\n {4}\}/m)?.[0]
if (body === undefined) {
  console.error('FAIL: restructPlanVerdict не найден в lib/types — сначала pnpm compile')
  process.exit(1)
}
const restructPlanVerdict = new Function(`${body}\nreturn restructPlanVerdict`)()

const verdict = (stopReason, text, diagnostic = undefined) => restructPlanVerdict({
  stopReason,
  output: [{ type: 'text', text }],
  ...(diagnostic === undefined ? {} : { diagnostic }),
})

// ── 1. every human shape of the marker passes ──────────────────────────────
for (const last of ['RP_DONE demo', 'RP_SKIP: нет .dev плана', '**RP_DONE demo**', '- RP_SKIP: плана нет', '`RP_DONE demo`', 'rp_done demo']) {
  const result = verdict('completed', `записал\n${last}`)
  check(`marker passes: ${last}`, result.ok === true, result.ok ? '' : result.reason)
}

// ── 2. the incident's own line ─────────────────────────────────────────────
const incident = verdict('completed', 'Проверил .dev\nRP_SKIP: каталога плана, относящегося к работе диалога, нет')
check('2026-11-07 incident line passes', incident.ok === true, incident.ok ? '' : incident.reason)

// ── 3. the gate still blocks what it is for ────────────────────────────────
const notLast = verdict('completed', 'RP_DONE demo\nчто-то после')
check('marker not on the last line blocks', notLast.ok === false, notLast.reason)
check('block reason names the missing marker', String(notLast.reason).includes('без маркера RP_DONE/RP_SKIP'), notLast.reason)

const noMarker = verdict('completed', 'готово')
check('no marker blocks', noMarker.ok === false, noMarker.reason)

const crashed = verdict('max-tokens', 'RP_DONE demo')
check('abnormal stop blocks even with a marker', crashed.ok === false, crashed.reason)
check('abnormal stop names the reason', String(crashed.reason).includes('аварийно (max-tokens)'), crashed.reason)

const diagnostic = verdict('error', '', 'model failed')
check('diagnostic reaches the reason', String(diagnostic.reason).includes('model failed'), diagnostic.reason)

// ── 4. the child's own error text reaches the notice ──────────────────────
const diagnosticBody = source.match(/^ {4}function diagnosticOfChild\([\s\S]*?\n {4}\}/m)?.[0]
if (diagnosticBody === undefined) {
  console.error('FAIL: diagnosticOfChild не найден в lib/types — сначала pnpm compile')
  process.exit(1)
}
const diagnosticOfChild = new Function(`${diagnosticBody}\nreturn diagnosticOfChild`)()
const childEvents = [
  { type: 'turn/start' },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'no adapter registered for provider "deepseek-official"' } } } },
]
const childCtx = { agents: { get: id => id === 'child-1' ? { session: { snapshotEvents: () => childEvents } } : undefined } }
check(
  'child error reaches the diagnostic',
  String(diagnosticOfChild(childCtx, { childId: 'child-1' })).includes('no adapter registered'),
  String(diagnosticOfChild(childCtx, { childId: 'child-1' })),
)
check('missing child leaves no diagnostic', diagnosticOfChild(childCtx, { childId: 'gone' }) === undefined)
check(
  'a completed child end yields no diagnostic',
  diagnosticOfChild({ agents: { get: () => ({ session: { snapshotEvents: () => [{ type: 'turn/end', data: { reason: { kind: 'completed' } } }] } }) } }, { childId: 'x' }) === undefined,
)

console.log(failed === 0 ? 'compact-rp battery OK' : `compact-rp battery FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
