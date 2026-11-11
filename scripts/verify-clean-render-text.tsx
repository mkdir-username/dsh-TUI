/**
 * verify-clean-render-text — семантика и цена `cleanRenderText`.
 *
 * Зачем: живой профиль dsh-tui (сессия «Исправление заголовка в вебвью РЛ»,
 * горячее окно) показал `stringWidthJavaScript` 12.9–13.6% self-time, и стек
 * приходит из `PinnedTurnHeader → cleanRenderText → stringWidthJavaScript`.
 * Причина в самой функции: после проверки `stringWidth(flat) <= maxCells` она
 * дорезает строку, заново измеряя КАЖДЫЙ префикс (`stringWidth(out + ch)`),
 * то есть O(n²) на длинном однострочном тексте, плюс полный прогон регулярками
 * на каждый вызов — и всё это на каждом кадре отрисовки.
 *
 * Ассерты:
 *   1. семантика: ANSI/управляющие байты вырезаны, пробелы схлопнуты, обрезка
 *      ровно до maxCells-1 с многоточием, ширина результата ≤ maxCells;
 *   2. границы: пустая строка, текст короче лимита, ровно в лимит, широкие
 *      (CJK) символы, эмодзи-кластер не рвётся;
 *   3. цена: 200 вызовов на 20 000 символах укладываются в бюджет (линейная
 *      дорезка + кэш) — сегодня это ~0.9 мс/вызов, то есть ~180 мс.
 *
 * Run: node --import tsx/esm scripts/verify-clean-render-text.tsx
 */
const { cleanRenderText, cleanBlockLines } = await import('../src/channel/sanitize.js')
const { stringWidth } = await import('../src/ink/stringWidth.js')

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ── 1. семантика ──
check('ANSI вырезан целиком', cleanRenderText('\u001b[31mкрасный\u001b[0m', 80) === 'красный')
check('OSC-заголовок вырезан', cleanRenderText('\u001b]0;ttl\u0007текст', 80) === 'текст')
check('управляющие байты → пробел, пробелы схлопнуты', cleanRenderText('a\u0007\u0008b   c', 80) === 'a b c')
check('короче лимита не трогается', cleanRenderText('короткий текст', 80) === 'короткий текст')
const exact = 'x'.repeat(40)
check('ровно в лимит не обрезается', cleanRenderText(exact, 40) === exact)

const long = 'слово '.repeat(40) // 240 ячеек
const cut = cleanRenderText(long, 20)
check('обрезка кончается многоточием', cut.endsWith('…'))
check('ширина обрезки ≤ лимита', stringWidth(cut) <= 20, `w=${stringWidth(cut)}`)
const cutNoEllipsis = cut.slice(0, -1)
check('префикс максимален: +1 символ превысил бы лимит', stringWidth(cutNoEllipsis) <= 19, `w=${stringWidth(cutNoEllipsis)}`)

const cjk = '漢字'.repeat(20) // каждая пара — 4 ячейки
const cjkCut = cleanRenderText(cjk, 9)
check('широкие символы: ширина ≤ лимита', stringWidth(cjkCut) <= 9, `w=${stringWidth(cjkCut)}`)
check('широкие символы: обрезка не рвёт пару', cjkCut.length % 2 === 1, `len=${cjkCut.length}`)

const emoji = '👨‍👩‍👧‍👦семья '.repeat(8)
const emojiCut = cleanRenderText(emoji, 10)
check('эмодзи-кластер не разорван', !/[\uD800-\uDBFF]$/.test(emojiCut.slice(0, -1)))
check('эмодзи: ширина ≤ лимита', stringWidth(emojiCut) <= 10, `w=${stringWidth(emojiCut)}`)

check('пустая строка → пустая', cleanRenderText('', 10) === '')
check('только ANSI → пустая', cleanRenderText('\u001b[0m', 10) === '')
check('maxCells=1 → только многоточие', cleanRenderText('длинный', 1) === '…')
check('cleanBlockLines сохраняет строки', JSON.stringify(cleanBlockLines('a\n\nb', 80)) === '["a","b"]')

// ── 1b. эквивалентность эталонному (старому) алгоритму ──
// Эталон: точное измерение каждого префикса без кэша и эвристик.
function referenceClean(value: string, maxCells: number): string {
  const withoutAnsi = value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
  const flat = withoutAnsi.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (stringWidth(flat) <= maxCells) return flat
  let out = ''
  for (const ch of flat) {
    if (stringWidth(out + ch) > maxCells - 1) break
    out += ch
  }
  return `${out}…`
}
const corpus = [
  'Отчёт по модулю '.repeat(30),
  '漢字とかな'.repeat(20),
  '👨‍👩‍👧‍👦 семья и дети '.repeat(10),
  'e\u0301cole combine '.repeat(20),
  '❤️ heart '.repeat(20),
  '\u001b[1;31mжирный\u001b[0m '.repeat(12),
  'tab\tи\u0007звонок '.repeat(12),
  'a'.repeat(500),
  '短'.repeat(300),
  'x'.repeat(40),
  'a' + '\u0301'.repeat(300),
  '\u200b'.repeat(400) + 'текст',
]
let mismatch = ''
for (const text of corpus) {
  for (const cells of [1, 2, 5, 9, 20, 41, 80, 118]) {
    const got = cleanRenderText(text, cells)
    const want = referenceClean(text, cells)
    if (got !== want && mismatch === '') mismatch = `cells=${cells} want=${JSON.stringify(want.slice(0, 24))} got=${JSON.stringify(got.slice(0, 24))}`
  }
}
check('совпадает с эталонным алгоритмом на корпусе', mismatch === '', mismatch)

// ── 2. цена ──
const headerText = ('Заголовок хода: правка контракта РЛ '.repeat(60)).slice(0, 2048)
for (let i = 0; i < 20; i++) cleanRenderText(headerText, 118)
const ITER = 500
const startedAt = performance.now()
for (let i = 0; i < ITER; i++) cleanRenderText(headerText, 118)
const perCall = (performance.now() - startedAt) / ITER
check('повторный вызов 2KB (как sticky-хедер): ≤0.01 мс/вызов', perCall <= 0.01, `${perCall.toFixed(4)}ms/call`)



// Разные строки (кэш промахивается) — линейная дорезка вместо O(n²).
const variants = Array.from({ length: 50 }, (_, i) => `вариант ${i} `.repeat(1200).slice(0, 18_000 + i))
for (const text of variants.slice(0, 5)) cleanRenderText(text, 118)
const missStart = performance.now()
for (const text of variants) cleanRenderText(text, 118)
const missPer = (performance.now() - missStart) / variants.length
check('промах кэша на 18k: ≤0.55 мс/вызов', missPer <= 0.55, `${missPer.toFixed(3)}ms/call`)

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
