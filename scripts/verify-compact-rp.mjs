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
const diagnosticBody = source.match(/^ {4}async function diagnosticOfChild\([\s\S]*?\n {4}\}/m)?.[0]
if (diagnosticBody === undefined) {
  console.error('FAIL: diagnosticOfChild не найден в lib/types — сначала pnpm compile')
  process.exit(1)
}
const diagnosticOfChild = new Function(`${diagnosticBody}\nreturn diagnosticOfChild`)()
const childEvents = [
  { type: 'turn/start' },
  { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'no adapter registered for provider "deepseek-official"' } } } },
]
const reader = events => ({ get: name => name === 'sessionPersistence' ? { load: async () => ({ events }) } : undefined })
const childCtx = reader(childEvents)
const childDiagnostic = await diagnosticOfChild(childCtx, { childId: 'child-1' })
check(
  'child error reaches the diagnostic',
  String(childDiagnostic).includes('no adapter registered'),
  String(childDiagnostic),
)
check('missing child leaves no diagnostic', await diagnosticOfChild(reader([]), { childId: 'gone' }) === undefined)
check(
  'a completed child end yields no diagnostic',
  await diagnosticOfChild(reader([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }]), { childId: 'x' }) === undefined,
)

// ── 5. the abort phrase names the sender ──────────────────────────────────
const phraseBody = source.match(/^ {4}const abortPhrase = \(source, reason\) => \{[\s\S]*?\n {4}\};/m)?.[0]
if (phraseBody === undefined) {
  console.error('FAIL: abortPhrase не найден в lib/types — сначала pnpm compile')
  process.exit(1)
}
// No clock may cut a live fork: every bound tried so far (15 min, then 25) fired
// while the plan was still being written, so the test pins the absence.
check('the fork carries no wall-clock bound', !/RP_TIMEOUT_MS|AbortSignal\.timeout/.test(source), '')
check('no watchdog aborts a silent fork', !/RP_FIRST_OUTPUT_MS/.test(source), '')
const abortPhrase = new Function(`${phraseBody}\nreturn abortPhrase`)()
check('cancel names the user', abortPhrase('user', new Error('user cancelled compaction')) === 'отменён пользователем (Esc)', abortPhrase('user', new Error('x')))
check('settle names the switch', abortPhrase('switch', new Error('session switch')) === 'прерван сменой сессии', abortPhrase('switch', new Error('x')))
check('disposal names the closed agent', abortPhrase('disposed', new Error('agent disposed')) === 'прерван: агент закрыт', abortPhrase('disposed', new Error('x')))
check('an unknown abort keeps its reason', abortPhrase('signal', new Error('boom')) === 'boom')
check('a reasonless abort stays neutral', abortPhrase('signal', undefined) === 'отмена')

// ── 6. the fork's write surface ───────────────────────────────────────────
// A fork seeded with the parent's history drifts into finishing that history's
// unfinished work: on 2026-11-27 a live fork spent ten minutes editing hooks and
// tests while its own `.dev/` plan was never touched. The prompt owns the surface.
const prompt = source.match(/const RP_PROMPT = '([^']*)'/)?.[1] ?? ''
check('the fork is told it only documents', prompt.includes('только документация'), prompt.slice(0, 60))
check('the fork is told to leave code, tests and hooks alone', prompt.includes('Код, тесты, хуки'), '')
// Reading is the only part split out; the plan keeps one writer, or two
// children race on `.dev/<slug>/`. A single agent reading the whole history
// choked, so the split is a requirement, not a permission (2026-11-28).
check('the fork plans sections before reading', prompt.includes('4–6 разделов'), '')
check(
  'the fork runs read-only subagents in parallel',
  prompt.includes('2–4 суб-агента (subagent)') && prompt.includes('без права писать файлы'),
  '',
)
check('the fork takes the first ready child, not all', prompt.includes('первого готового'), '')
check('the fork writes the plan itself', prompt.includes('делаешь сам и только сам'), '')
check('the fork calls the skill first', prompt.includes('Первым делом вызови Skill restruct-plan'), '')
check('inherited notifications are not the fork\'s work', prompt.includes('не твоя работа'), '')

console.log(failed === 0 ? 'compact-rp battery OK' : `compact-rp battery FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
