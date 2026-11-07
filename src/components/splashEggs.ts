/**
 * 开屏的一个彩蛋——节日换词，只改**文字**，字体轮换、鲸鱼动画、窄终端阶梯
 * 一律照旧：本地日期命中断天窗口时，把下排词换成 `HAPPINESS` / `MERRY` /
 * `NEW YEAR`（上排仍是 `DEEPSEEK`）。字距由 `withTagline` 按新词重解，
 * 所以换词不会把两行搞成不等宽。
 */

/** 一个节日彩蛋：当天要用的上下两排词。 */
export interface SplashEgg {
  /** 稳定 id（回归按 id 命中）。 */
  readonly id: string
  /** 上排词。 */
  readonly top: string
  /** 下排词。 */
  readonly bottom: string
}

/** 上排词固定是品牌名；彩蛋换的是下排。 */
const EGG_TOP = 'DEEPSEEK'

interface DatedEgg extends SplashEgg {
  /** 本地日期：月（1-12）。 */
  readonly month: number
  /** 本地日期：日。 */
  readonly day: number
}

/**
 * 节日表（本地日期，整天窗口——与启动时刻无关）。三个词的字母在每款字体里
 * 都有字形（`verify-splash-eggs.tsx` 逐款钉死，缺一个就会画成空心方块）。
 */
const SPLASH_EGGS: readonly DatedEgg[] = [
  { id: 'april-fools', month: 4, day: 1, top: EGG_TOP, bottom: 'HAPPINESS' },
  { id: 'christmas', month: 12, day: 25, top: EGG_TOP, bottom: 'MERRY' },
  { id: 'new-year', month: 1, day: 1, top: EGG_TOP, bottom: 'NEW YEAR' },
]

/**
 * 当天是不是彩蛋日。
 * @param now - 注入的当前时间（测试缝；生产用 `new Date()`）。
 * @returns 命中的彩蛋（含当天要用的词对）；没命中返回 `null`（照常画 `HARNESS`）。
 */
export function pickSplashEgg(now: Date = new Date()): SplashEgg | null {
  const month = now.getMonth() + 1
  const day = now.getDate()
  return SPLASH_EGGS.find(egg => egg.month === month && egg.day === day) ?? null
}
