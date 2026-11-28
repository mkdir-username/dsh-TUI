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
// The fork's clock is a wrap-up, not a kill. Every earlier bound (15 min, then
// 25) fired while the plan was still being written and cost work already done,
// so the budget asks the child to finish at the soft mark and only then stops
// it; a spent budget continues the compaction on the plan written so far.
const softBudget = /const RP_SOFT_BUDGET_MS = budgetMs\('DSH_TUI_RP_SOFT_BUDGET_MS', (\d+) \* 60_000\)/.exec(source)
const hardBudget = /const RP_HARD_BUDGET_MS = budgetMs\('DSH_TUI_RP_HARD_BUDGET_MS', (\d+) \* 60_000\)/.exec(source)
check('the fork has a soft budget', softBudget !== null, softBudget?.[1] ?? '')
check('the fork has a hard budget', hardBudget !== null, hardBudget?.[1] ?? '')
check(
  'the soft mark comes before the stop',
  Number(softBudget?.[1] ?? 0) > 0 && Number(hardBudget?.[1] ?? 0) > Number(softBudget?.[1] ?? 0),
  `${softBudget?.[1] ?? '?'}/${hardBudget?.[1] ?? '?'} min`,
)
check(
  'the budget steers before it stops',
  /requestWrapUp\(childId\)/.test(source) && /budget\.abort\(new Error\('restruct-plan budget spent'\)\)/.test(source),
  '',
)
check(
  'the stop rides its own controller, never the cycle signal',
  /const budget = new AbortController\(\)/.test(source) && /budget\.signal\.aborted/.test(source),
  '',
)
check(
  'a spent budget degrades instead of cancelling',
  /degraded: true/.test(source) && source.includes('сжатие продолжается'),
  '',
)
check('the caller continues on a degraded verdict', source.includes('verdict.degraded === true'), '')
const promptText = source.match(/const RP_PROMPT = '([^']*)'/)?.[1] ?? ''
check(
  'the prompt names the same budget the code sets',
  promptText.includes(`примерно через ${Number(softBudget?.[1])} минут`) && promptText.includes(`через ${Number(hardBudget?.[1])} он останавливается`),
  '',
)
check('no silent watchdog aborts a silent fork', !/RP_FIRST_OUTPUT_MS/.test(source) && !/RP_TIMEOUT_MS/.test(source), '')
check('no single-shot timeout races the budget', !/AbortSignal\.timeout/.test(source), '')
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
// The journal holds what past cycles already verified: re-reading it as facts
// is what keeps the fork from re-discovering its own history (J0029–J0036).
check('the fork reads the plan journal first', prompt.includes('Сначала прочитай journal.md'), '')
check('the fork answers the wrap-up without new reads', prompt.includes('на просьбу отвечай сразу'), '')
check('the fork calls the skill first', prompt.includes('Первым делом вызови Skill restruct-plan'), '')
check('inherited notifications are not the fork\'s work', prompt.includes('не твоя работа'), '')

console.log(failed === 0 ? 'compact-rp battery OK' : `compact-rp battery FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
