/**
 * Session-spend chip in the footer, quoted in USD.
 *
 * The vendored estimator (`deepseekPricing.ts`) prices a session in CNY, so the
 * chip has to convert instead of swapping the currency glyph. The rate comes
 * from `fx.json`, written daily by `~/.dsh/bin/fx-cny-usd.sh` from the CBR
 * daily file (RUB per USD over RUB per CNY). A rate that is missing or broken
 * hides the chip: a wrong number on the footer is worse than no number.
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FX_PATH = join(homedir(), '.dsh-tui', 'fx.json')

export interface FxInfo {
  /** CNY per USD. */
  readonly rate: number
  /** CBR file date the rate was taken from, when the writer recorded it. */
  readonly asOf: string | undefined
}

/** The estimator's shape this module needs; the rest of it is not its business. */
export interface CostEstimate {
  readonly total: number
}

let cachedPath: string | undefined
let cachedMtimeMs = -1
let cachedInfo: FxInfo | undefined

/** The CNY-per-USD cross plus the CBR date from an `fx.json` body, or nothing for junk. */
export function parseFxInfo(text: string): FxInfo | undefined {
  try {
    const parsed = JSON.parse(text) as { cnyPerUsd?: unknown; asOf?: unknown }
    const rate = parsed?.cnyPerUsd
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return undefined
    return { rate, asOf: typeof parsed?.asOf === 'string' ? parsed.asOf : undefined }
  } catch {
    return undefined
  }
}

/** Same read rules as the settings reader: every failure means "no rate". */
export function loadFxInfo(path: string = FX_PATH): FxInfo | undefined {
  try {
    const { mtimeMs } = statSync(path)
    if (path === cachedPath && mtimeMs === cachedMtimeMs) return cachedInfo
    const info = parseFxInfo(readFileSync(path, 'utf8'))
    cachedPath = path
    cachedMtimeMs = mtimeMs
    cachedInfo = info
    return info
  } catch {
    cachedPath = path
    cachedMtimeMs = -1
    cachedInfo = undefined
    return undefined
  }
}

/** The rate alone, for the footer chip. */
export function loadFxRate(path: string = FX_PATH): number | undefined {
  return loadFxInfo(path)?.rate
}

/** One USD figure for the footer: hundredths are the only precision it shows. */
export function formatUsd(amount: number, rate: number): string {
  return `$${(amount / rate).toFixed(2)}`
}

/**
 * `$0.01` while it costs cents, `$1.50` once it costs dollars — hundredths are
 * the footer's resolution, so the chip stays one short token. `null` for an
 * empty session or without a trustworthy rate. Peak hours do not gate the chip:
 * the estimator already prices peak and idle tokens apart, and hiding the spend
 * for most of the day left the footer without any figure.
 */
export function formatCostChip(estimate: CostEstimate | undefined, rate: number | undefined): string | null {
  const total = estimate?.total
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
  return formatUsd(total, rate)
}
