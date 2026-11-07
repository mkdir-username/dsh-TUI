/**
 * 开屏彩蛋契约：节日换词（`splashEggs.ts` + `splashFonts.ts` 的彩蛋字母）与小概率
 * 求 star 标语。逐款字体、逐对词钉死：
 * ① 彩蛋词（HAPPINESS / MERRY / NEW YEAR）的每个字母在**每款**字体里都有自己的
 *    字形（缺了就画成 fallback 空心方块），行宽等于该款 `glyphWidth`；
 * ② 每个 (字体, 词对) 下两行画出来的列数相等、下排墨迹居中（左右留白差 ≤ 1 列）、
 *    `bigTextWidth` 与画面一致；解还得是**字距和最小**的那一个（画面最紧），只有
 *    带字距的解不存在时才允许零字距（8 列 `wide` × 9 字 `HAPPINESS` 就是这一档）。
 *    例外：声明了 `uniformKerning` 的字体（shadow）不进求解器——钉两行同字距；
 * ③ 日期表：三个彩蛋日命中（词对正确）、前后一天不命中、同一天内跨时刻恒定；
 * Run: node --import tsx/esm scripts/verify-splash-eggs.tsx
 */
// 终端能力必须在 supports-hyperlinks 之前钉死——它在模块初始化时读一次 env。
process.env.FORCE_HYPERLINK = '1'

const [
  React,
  { renderBigText, bigTextWidth, paintedWidth },
  { SPLASH_FONTS, splashFontById, withTagline },
  { pickSplashEgg },
  { stringWidth },
  { renderToScreen },
  { cellAt },
  { TerminalSizeContext },
  { LogoV2 },
  { COLUMN_GAP, WHALE_BOX_WIDTH },
  { settle },
] = await Promise.all([
  import('react'),
  import('../src/components/bigfont.js'),
  import('../src/components/splashFonts.js'),
  import('../src/components/splashEggs.js'),
  import('../src/ink/stringWidth.js'),
  import('../src/ink/render-to-screen.js'),
  import('../src/ink/screen.js'),
  import('../src/ink/components/TerminalSizeContext.js'),
  import('../src/components/LogoV2.js'),
  import('../src/components/splashLayout.js'),
  import('./lib/term-test.mjs'),
])

const ACCENT = { r: 63, g: 108, b: 196 }
const PALE = { r: 211, g: 225, b: 254 }
/** SGR only——大字用真彩前景色画；OSC 8 序列由下面的成对断言单独查。 */
const SGR = /\x1b\[[0-9;]*m/g
const strip = (row: string): string => row.replace(SGR, '')
const columns = (row: string): number => [...strip(row)].length
/** 彩蛋词：三个节日的下排词（上排仍是 `DEEPSEEK`）。 */
const EGG_WORDS: readonly string[] = ['HAPPINESS', 'MERRY', 'NEW YEAR']
/** 词对全表：正常词 + 三个彩蛋词。 */
const PAIRS: readonly (readonly [string, string])[] = [
  ['DEEPSEEK', 'HARNESS'],
  ...EGG_WORDS.map((word): readonly [string, string] => ['DEEPSEEK', word]),
]
/** 解字距时穷举的上限（与实现的 `MAX_KERNING` 同量级；它只用来判断"够不够紧"）。 */
const KERNING_CAP = 12
/** 鲸鱼 art 包围盒的中心列（`LogoV2.tsx` 的 `WHALE_CENTER`）。 */
const WHALE_CENTER = 18.5

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!ok) failed += 1
}

// ── ① 彩蛋字母：逐款字体都要有自己的字形 ──────────────────────────────────
const LETTERS = [...new Set(EGG_WORDS.join('').replaceAll(' ', ''))]
for (const font of SPLASH_FONTS) {
  const missing = LETTERS.filter(letter => (font.glyphs[letter] ?? []).length !== 5)
  check(`[${font.id}] 彩蛋字母 ${LETTERS.join('')} 都有字形`, missing.length === 0, missing.join(''))
  const degenerate = LETTERS.filter(letter =>
    JSON.stringify(font.glyphs[letter]) === JSON.stringify(font.fallback) ||
    !(font.glyphs[letter] ?? []).every(row => [...row].length === font.glyphWidth))
  check(
    `[${font.id}] 彩蛋字母都是真字形且 ${font.glyphWidth} 列宽（不是 fallback 空心方块）`,
    degenerate.length === 0,
    degenerate.join(''),
  )
}

// ── ② 逐款字体 × 逐对词：等宽 + 居中 + 最紧解 ─────────────────────────────
/** 画出来的列数（含末尾字距留白）——真渲染，不信算术。 */
const painted = (font: (typeof SPLASH_FONTS)[number], text: string, kerning: number): number =>
  columns(renderBigText(font, text, 0, ACCENT, ACCENT, PALE, 60, kerning)[0] ?? '')
/** 契约判据：等宽成立时返回下排缩进，否则 null。`ink` 用 `bigTextWidth`（不含末尾留白）。 */
const contractIndent = (
  font: (typeof SPLASH_FONTS)[number],
  top: string,
  topKerning: number,
  bottom: string,
  bottomKerning: number,
): number | null => {
  const indent = painted(font, top, topKerning) - painted(font, bottom, bottomKerning)
  if (indent < 0) return null
  const error = Math.abs(bigTextWidth(font, top, topKerning) - bigTextWidth(font, bottom, bottomKerning) - 2 * indent)
  return error <= 1 ? indent : null
}

for (const font of SPLASH_FONTS) {
  for (const [top, bottom] of PAIRS) {
    const title = withTagline(font, top, bottom)
    const { topKerning, bottomKerning, bottomIndent } = title.tagline
    const topRows = renderBigText(title, top, 0, ACCENT, ACCENT, PALE, 60, topKerning)
    const bottomRows = renderBigText(title, bottom, 0, ACCENT, PALE, PALE, 60, bottomKerning, bottomIndent)
    const topWidth = columns(topRows[0] ?? '')
    const bottomWidth = columns(bottomRows[0] ?? '')
    const inkTop = bigTextWidth(title, top, topKerning)
    const inkBottom = bigTextWidth(title, bottom, bottomKerning)

    // 固定字距档（shadow）：等宽契约在 10 列字身上解不出紧字距（最紧 5/7），
    // 这款两行同字距、渲染层半差居中——等宽/最紧解断言不适用，钉固定值。
    if (font.uniformKerning !== undefined) {
      check(
        `[${font.id}] ${top}/${bottom} 固定字距档：两行同字距、不垫缩进`,
        topKerning === font.uniformKerning && bottomKerning === font.uniformKerning && bottomIndent === 0,
        `tk=${topKerning} bk=${bottomKerning} indent=${bottomIndent}`,
      )
      check(
        `[${font.id}] ${top}/${bottom} bigTextWidth 与画面一致`,
        inkTop === topWidth - topKerning && inkBottom === bottomWidth - bottomIndent - bottomKerning,
      )
      continue
    }

    check(
      `[${font.id}] ${top}/${bottom} 两行画出来列数相等`,
      topWidth === bottomWidth && topRows.every((row, index) => columns(row) === columns(bottomRows[index] ?? '')),
      `${topWidth} vs ${bottomWidth}`,
    )
    // 契约无解的组合（见下方 feasible 穷举）走 closest 兜底，居中允许超差
    // ——等宽（上一条）仍是硬契约；有解的组合居中误差必须 ≤ 1。
    const feasibleExists = (() => {
      for (let tk = 0; tk <= KERNING_CAP; tk += 1) {
        for (let bk = 0; bk <= KERNING_CAP; bk += 1) {
          if (contractIndent(font, top, tk, bottom, bk) !== null) return true
        }
      }
      return false
    })()
    check(
      `[${font.id}] ${top}/${bottom} 下排墨迹居中（左右留白差 ≤ 1 列）`,
      Math.abs(inkTop - inkBottom - 2 * bottomIndent) <= 1 || !feasibleExists,
      `ink ${inkTop}/${inkBottom} indent ${bottomIndent}`,
    )
    check(
      `[${font.id}] ${top}/${bottom} bigTextWidth 与画面一致`,
      inkTop === topWidth - topKerning && inkBottom === bottomWidth - bottomIndent - bottomKerning,
    )

    // 独立穷举（用真渲染量宽，不复用实现里的算术）：实现必须落在可行解里，
    // 且字距和是所有可行解中最小的——挡"随便给一组能等宽的字距"这种退化。
    const feasible: Array<{ topKerning: number; bottomKerning: number; sum: number }> = []
    for (let tk = 0; tk <= KERNING_CAP; tk++) {
      for (let bk = 0; bk <= KERNING_CAP; bk++) {
        if (contractIndent(font, top, tk, bottom, bk) !== null) {
          feasible.push({ topKerning: tk, bottomKerning: bk, sum: tk + bk })
        }
      }
    }
    // 个别（字身宽 × 词长差）组合契约在字距上限内**数学无解**（如 shadow 的
    // 10 列字身 × DEEPSEEK/HAPPINESS：等宽方程推导出 indent 恒负）——那种
    // 组合只断言兜底路径（closest）：不抛错、两行仍等宽（indent 按 painted
    // 差求出），居中允许超差。
    if (feasible.length === 0) {
      const fallbackOk = topRows.every((row, index) => columns(row) === columns(bottomRows[index] ?? ''))
      check(`[${font.id}] ${top}/${bottom} 契约无解时兜底仍等宽不抛错`, fallbackOk)
      continue
    }
    const gapped = feasible.filter(candidate => candidate.topKerning >= 1 && candidate.bottomKerning >= 1)
    const pool = gapped.length > 0 ? gapped : feasible
    const tightest = Math.min(...pool.map(candidate => candidate.sum))
    check(
      `[${font.id}] ${top}/${bottom} 取最紧解（字距和 ${tightest}${gapped.length === 0 ? '，且这一档只解得出零字距' : ''}）`,
      topKerning + bottomKerning === tightest && contractIndent(font, top, topKerning, bottom, bottomKerning) !== null,
      `得到 tk=${topKerning} bk=${bottomKerning} 和 ${topKerning + bottomKerning}`,
    )
    check(
      `[${font.id}] ${top}/${bottom} 两行字距不超上限`,
      Math.max(topKerning, bottomKerning) <= KERNING_CAP && topKerning >= 1,
      `tk=${topKerning} bk=${bottomKerning}`,
    )
  }
}

// ── ③ 日期表 ──────────────────────────────────────────────────────────────
const EGG_DAYS: readonly { year: number; month: number; day: number; id: string; bottom: string }[] = [
  { year: 2026, month: 4, day: 1, id: 'april-fools', bottom: 'HAPPINESS' },
  { year: 2026, month: 12, day: 25, id: 'christmas', bottom: 'MERRY' },
  { year: 2026, month: 1, day: 1, id: 'new-year', bottom: 'NEW YEAR' },
]
for (const { year, month, day, id, bottom } of EGG_DAYS) {
  const at = (h: number, m: number): ReturnType<typeof pickSplashEgg> =>
    pickSplashEgg(new Date(year, month - 1, day, h, m))
  const hit = at(9, 30)
  check(`${month}/${day} 命中 ${id}`, hit?.id === id && hit.top === 'DEEPSEEK' && hit.bottom === bottom, hit?.id ?? 'null')
  check(`${month}/${day} 同一天内跨时刻恒定`, at(0, 1)?.id === hit?.id && at(23, 59)?.id === hit?.id)
  check(`${month}/${day} 前一天不命中`, pickSplashEgg(new Date(year, month - 1, day - 1, 12, 0)) === null)
  check(`${month}/${day} 后一天不命中`, pickSplashEgg(new Date(year, month - 1, day + 1, 12, 0)) === null)
}
check('普通日子用正常词', pickSplashEgg(new Date(2026, 5, 15, 12, 0)) === null)
check(
  '未知词对不落 fallback：正常词在两款独立表里也齐全',
  SPLASH_FONTS.every(font => [...'DEEPSEEK' + 'HARNESS'].every(letter => (font.glyphs[letter] ?? []).length === 5)),
)

// ── ④b 挂真实 LogoV2 读屏 ─────────────────────────────────────────────────
const WIDTH = 120
const TEXT_LEFT = WHALE_BOX_WIDTH + COLUMN_GAP
const baseProps = { model: 'deepseek-v3', cwd: '/tmp/probe', skipIntro: true, fontId: 'bold', drift: null, companionSkin: 'whale' } as const

const mount = (element: React.ReactElement): { rows: string[]; screen: ReturnType<typeof renderToScreen>['screen'] } => {
  const { screen, height } = renderToScreen(element, WIDTH)
  const rows = Array.from({ length: height }, (_, row) =>
    Array.from({ length: WIDTH }, (_, column) => cellAt(screen, column, row)?.char ?? '').join('').trimEnd(),
  )
  return { rows, screen }
}
/** 头部组件在真实终端尺寸上下文里挂载。 */
const view = (child: React.ReactElement): React.ReactElement => (
  <TerminalSizeContext.Provider value={{ columns: WIDTH, rows: 40 }}>{child}</TerminalSizeContext.Provider>
)
/** 最后一个有内容的行（底部欢迎语那一行）。 */
const bottomRow = (rows: string[]): number =>
  rows.reduce((last, row, index) => (row.trim() === '' ? last : index), -1)
/** 该行真正占用的列区间：宽字符的 spacer 也算（它就是那 2 列的第二列）。 */
const span = (screen: ReturnType<typeof renderToScreen>['screen'], row: number): { first: number; width: number } => {
  let first = -1
  let last = -1
  for (let column = 0; column < WIDTH; column++) {
    if ((cellAt(screen, column, row)?.char ?? ' ') === ' ') continue
    if (first < 0) first = column
    last = column
  }
  return { first, width: last - first + 1 }
}
/** 该行文字列（鲸鱼右边）的内容：短行先补到文字列再切，免得 whale-only 行被切空。 */
const textAt = (line: string): string => line.padEnd(TEXT_LEFT).slice(TEXT_LEFT).trimEnd()
const centeredPad = (visible: number): number => Math.max(0, Math.round(WHALE_CENTER - visible / 2))

{
  const { rows, screen } = mount(view(<LogoV2 {...baseProps} />))
  const row = bottomRow(rows)
  const { first, width } = span(screen, row)
  let linkCells = 0
  for (let column = 0; column < WIDTH; column++) {
    if (cellAt(screen, column, row)?.hyperlink !== undefined) linkCells += 1
  }
  const TAGLINES = ['探索未至之境！', 'Explore the uncharted!']
  check('欢迎语照常显示（无链接）',
    linkCells === 0 && TAGLINES.some(tagline => (rows[row] ?? '').includes(tagline)), rows[row] ?? '')
  check(
    '欢迎语缩进还是按 tagline 宽度算',
    first === centeredPad(width),
    `first=${first} width=${width} 期望 ${centeredPad(width)}`,
  )
}

{
  const eggFont = withTagline(splashFontById('bold'), 'DEEPSEEK', 'MERRY')
  const egg = { id: 'probe-christmas', top: 'DEEPSEEK', bottom: 'MERRY' }
  const { rows } = mount(view(<LogoV2 {...baseProps} egg={egg} />))
  const expected = [
    ...renderBigText(eggFont, 'DEEPSEEK', 0, ACCENT, ACCENT, PALE, 60, eggFont.tagline.topKerning),
    '',
    ...renderBigText(eggFont, 'MERRY', 0, ACCENT, PALE, PALE, 60, eggFont.tagline.bottomKerning, eggFont.tagline.bottomIndent),
  ].map(row => strip(row).trimEnd())
  const at = rows.findIndex((_, index) =>
    expected.every((want, offset) => textAt(rows[index + offset] ?? '') === want),
  )
  check('挂真实 LogoV2：彩蛋日画的是 DEEPSEEK / MERRY 两行（含中间空行）', at >= 0, at >= 0 ? `第 ${at} 行` : expected[0] ?? '')
}

{
  // shadow 固定字距（用户反馈「字与字间隔太宽」）：真机读屏钉死——两行同
  // 字距后不再等宽，下排按半差居中成金字塔（与品牌 uniform 档同一路径）。
  // 「字距」按相邻字形之间的**最近**空白量（行内 min）：字形内部空腔（P
  // 的右下、E 的中段）不算——那本来就是字母形状，不是间距。
  const shadow = splashFontById('shadow')
  const { topKerning, bottomKerning } = shadow.tagline
  const topInk = paintedWidth(shadow, shadow.tagline.top, topKerning)
  const bottomInk = paintedWidth(shadow, shadow.tagline.bottom, bottomKerning)
  const expected = [
    ...renderBigText(shadow, shadow.tagline.top, 0, ACCENT, ACCENT, PALE, 60, topKerning, Math.max(0, Math.round((bottomInk - topInk) / 2))),
    '',
    ...renderBigText(shadow, shadow.tagline.bottom, 0, ACCENT, PALE, PALE, 60, bottomKerning, Math.max(0, Math.round((topInk - bottomInk) / 2))),
  ].map(row => strip(row).trimEnd())
  // shadow 的块（88 列）比基准款宽，默认 120 列挂载屏装不下会截行——加宽挂载。
  const WIDE = TEXT_LEFT + 8 * (shadow.glyphWidth + topKerning) + 2
  const wideView = (child: React.ReactElement): React.ReactElement => (
    <TerminalSizeContext.Provider value={{ columns: WIDE, rows: 40 }}>{child}</TerminalSizeContext.Provider>
  )
  const wideMount = (element: React.ReactElement): { rows: string[] } => {
    const { screen, height } = renderToScreen(element, WIDE)
    return {
      rows: Array.from({ length: height }, (_, row) =>
        Array.from({ length: WIDE }, (_, column) => cellAt(screen, column, row)?.char ?? '').join('').trimEnd(),
      ),
    }
  }
  const { rows } = wideMount(wideView(<LogoV2 {...baseProps} fontId="shadow" egg={null} />))
  const at = rows.findIndex((_, index) =>
    expected.every((want, offset) => textAt(rows[index + offset] ?? '') === want),
  )
  check('挂真实 LogoV2：shadow 固定字距 + 下排半差居中（金字塔）', at >= 0, at >= 0 ? `第 ${at} 行` : expected[0] ?? '')
  const boundaryGap = (glyphA: readonly string[], glyphB: readonly string[], kerning: number): number => {
    let min = Infinity
    for (let row = 0; row < glyphA.length; row++) {
      const a = [...(glyphA[row] ?? '')]
      const b = [...(glyphB[row] ?? '')]
      let lastA = -1
      for (let i = a.length - 1; i >= 0; i--)
        if (a[i] !== '·') {
          lastA = i
          break
        }
      let firstB = -1
      for (let i = 0; i < b.length; i++)
        if (b[i] !== '·') {
          firstB = i
          break
        }
      if (lastA < 0 || firstB < 0) continue
      min = Math.min(min, a.length - 1 - lastA + kerning + firstB)
    }
    return min
  }
  const letters = [...shadow.tagline.top]
  const widestPair = Math.max(...letters.slice(0, -1).map((ch, index) =>
    boundaryGap(shadow.glyphs[ch] ?? shadow.fallback, shadow.glyphs[letters[index + 1] ?? ''] ?? shadow.fallback, topKerning)))
  check('shadow 相邻字形最近空白 ≤ 5 列（修前 ≥ 7 列）', widestPair <= 5, `最宽一对 ${widestPair} 列`)
}

{
  const { rows } = mount(view(<LogoV2 {...baseProps} egg={null} />))
  const normal = withTagline(splashFontById('bold'), 'DEEPSEEK', 'HARNESS')
  const expected = strip(
    renderBigText(normal, 'HARNESS', 0, ACCENT, PALE, PALE, 60, normal.tagline.bottomKerning, normal.tagline.bottomIndent)[2] ?? '',
  ).trimEnd()
  check('挂真实 LogoV2：正常日画的是 HARNESS 那一行', rows.some(line => textAt(line) === expected))
}


if (failed > 0) {
  console.error(`verify-splash-eggs: ${failed} check(s) failed`)
  process.exit(1)
}
console.log(`verify-splash-eggs OK (${SPLASH_FONTS.length} 款字体 × ${PAIRS.length} 对词)`)
