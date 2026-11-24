/**
 * Static gate for the i18n dictionary (part of verify:build): the six classes
 * of silent failure the type system cannot express.
 *
 *   1. Completeness: every non-`cmd-desc-*` entry must carry `en` (the source
 *      of truth). `zh` is optional translated data — no entry is required to
 *      duplicate its copy into a second language (the `cmd-desc-*` family
 *      takes its en text from the command registry, see the `tOr` note in
 *      i18n.ts).
 *   2. Placeholders: a single-brace `{name}` is a typo for `{{name}}`, which
 *      `t()` leaves on screen. When both languages carry `{{name}}` sets, one
 *      being a subset of the other is treated as a rename drift (deliberately
 *      dropping a placeholder on one side is legitimate localization, e.g. an
 *      English singular sentence without `{{n}}`, so only "present on both
 *      sides but names disagree" fails).
 *   3. Dead keys: an entry with no literal reference in `src/` or `scripts/`
 *      and no runtime-concatenated prefix family. Concatenated families
 *      (`tOr(\`cmd-desc-${name}\`)` and friends) pass by prefix.
 *   4. English copy literals: sentence-level UI English is allowed only in the
 *      dictionary; any other `src/` file fails (issue #980's leak shape — the
 *      key exists while a component bypasses `t()`). Fixture assertions of en
 *      output inside `scripts/` are legitimate and are not scanned.
 *   5. Backend-authored copy (B-3/B-5): a registered backend dictionary is
 *      checked for completeness and placeholders by the same rules.
 *   6. Cross-dictionary consistency: platform copy shared with the backends
 *      has one source (`src/backends/shared/platform-text.ts`) — the host
 *      dictionary and both backends expand it and are compared verbatim; a
 *      different inline copy written back on either side (a same-named key
 *      would shadow the source after expansion) fails. This is what stops the
 *      copy from being reintroduced.
 *
 * Run: node --import tsx/esm scripts/verify-i18n.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { i18nDict, type I18nText } from '../src/i18n.js'
import { claudeTexts } from '../src/backends/claude/text.js'
import { codexTexts } from '../src/backends/codex/text.js'
import { PLATFORM_TEXT, type PlatformTextKey } from '../src/backends/shared/platform-text.js'
import { SPINNER_VERBS } from '../src/terminal-utils/spinnerVerbs.js'

/** Dictionaries a backend carries itself (B-3, B-5), audited with the same
 *  rules minus the dead-key one (see the section at the end). */
const BACKEND_TEXT_MODULES: readonly { readonly module: string; readonly dict: Readonly<Record<string, { readonly zh?: I18nText; readonly en?: I18nText }>> }[] = [
  { module: 'src/backends/claude/text.ts', dict: claudeTexts },
  { module: 'src/backends/codex/text.ts', dict: codexTexts },
]

/** 与后端共用的平台文案真源（C-2）：宿主字典与两个内置后端都从这里展开。 */
const PLATFORM_TEXT_SOURCE = 'src/backends/shared/platform-text.ts'

// 运行时拼接的 key 前缀（新增拼接家族时在此登记，并附拼接点）：
//   cmd-desc-*    src/commands.ts        tOr(`cmd-desc-${command.name}`)
//   traj-sort-*   src/screens/TrajectoryScene.tsx  t(`traj-sort-${sort}`)
//   traj-proj-*   src/screens/TrajectoryScene.tsx  t(`traj-proj-${projection}`)
//   logo-drift-*  src/components/LogoV2.tsx        tOr(`logo-drift-${kind}`)
//   spinner-verb-* src/components/WorkingSpinner.tsx tOr(`spinner-verb-${verb}`)
//   tree-filter-* src/screens/SessionTree.tsx      t(`tree-filter-${filter}`)
//   tree-kind-*   src/screens/SessionTree.tsx      t(`tree-kind-${entry.kind}`)
//   preset-name-* / preset-desc-*   src/dsh-adapter/channel/model-actions.ts   tOr(`preset-name-${presetDisplayId(preset.id)}`) — built-in preset display text
const DYNAMIC_PREFIXES = ['cmd-desc-', 'traj-sort-', 'traj-proj-', 'logo-drift-', 'spinner-verb-', 'tree-filter-', 'tree-kind-', 'preset-name-', 'preset-desc-', 'agent-message-delivery-', 'agent-message-via-', 'team-status-']

let failures = 0
function fail(msg: string) {
  failures++
  console.error(`  ✗ ${msg}`)
}

for (const verb of SPINNER_VERBS) {
  const key = `spinner-verb-${verb.toLowerCase()}`
  if (i18nDict[key] === undefined) fail(`${key}: spinner verb 缺少中英文映射`)
}

function forms(text: I18nText | undefined): string[] {
  if (text === undefined) return []
  return typeof text === 'string' ? [text] : [text.one, text.other]
}

function placeholders(text: I18nText | undefined): Set<string> {
  const names = new Set<string>()
  for (const form of forms(text)) {
    for (const m of form.matchAll(/\{\{(\w+)\}\}/g)) names.add(m[1]!)
  }
  return names
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false
  return true
}

// ── 1+2: per-entry completeness and placeholders ────────────────────────
const singleBrace = /(?<!\{)\{(\w+)\}(?!\})/
for (const [key, entry] of Object.entries(i18nDict)) {
  // `en` is the source of truth; `zh` is optional translated data, so no entry
  // is required to duplicate its copy into a second language.
  if (entry.en === undefined && !key.startsWith('cmd-desc-')) fail(`${key}: missing en`)
  // Only a language the entry actually carries is scanned; a single-language
  // entry cannot have a cross-language placeholder drift.
  for (const lang of ['zh', 'en'] as const) {
    for (const form of forms(entry[lang])) {
      const m = singleBrace.exec(form)
      if (m) fail(`${key}.${lang}: single brace {${m[1]}} — t() does not substitute it, use {{${m[1]}}}`)
    }
  }
  const zh = placeholders(entry.zh)
  const en = placeholders(entry.en)
  if (entry.en !== undefined && entry.zh !== undefined && !isSubset(zh, en) && !isSubset(en, zh)) {
    fail(`${key}: placeholder names disagree zh={{${[...zh].join(',')}}} en={{${[...en].join(',')}}}`)
  }
}

// ── 3：死 key（src/ 与 scripts/ 全量字面扫描 + 拼接前缀放行）──────────
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src', 'scripts'], { encoding: 'utf8' })
  .split('\0'))]
  .filter(f => /\.(ts|tsx|mjs|cjs|js)$/.test(f))
  .filter(f => existsSync(f))
  // 字典文件自身不算"使用"：条目就定义在里面，否则任何死 key 都能被自己的
  // 定义救活。平台文案真源（C-2）同理——它里面的键是定义，消费点在宿主字典
  // 与两个后端（各以字面量引用，见 §6）。
  .filter(f => f !== 'src/i18n.ts' && f !== 'scripts/verify-i18n.ts' && f !== PLATFORM_TEXT_SOURCE)
let corpus = ''
for (const f of files) {
  // Worktrees may have deleted tracked files before a later commit; a missing
  // source file cannot contribute dead-key corpus and should not fail this gate.
  if (!existsSync(f)) continue
  corpus += readFileSync(f, 'utf8')
}
for (const key of Object.keys(i18nDict)) {
  if (DYNAMIC_PREFIXES.some(p => key.startsWith(p))) continue
  if (!corpus.includes(`'${key}'`) && !corpus.includes(`"${key}"`) && !corpus.includes(`\`${key}\``)) {
    fail(`${key}: 死 key——src/ 与 scripts/ 无引用（运行时拼接的 key 请登记 DYNAMIC_PREFIXES）`)
  }
}

// ── 4：英文文案字面量 tripwire（issue #980）─────────────────────────
// 整句级 UI 英文只允许活在字典里。src/（字典自身除外）出现这些字节 = 有
// 组件绕过 t() 硬编码（或注释整句引用了文案——注释请引用键名）。
// 收录标准：句级特异性（不会撞注释/标识符的完整英文句子），一次一族。
const FORBIDDEN_LITERALS = ['ctrl+o to expand', 'Killed by signal']
for (const f of files.filter(f => f.startsWith('src'))) {
  const content = readFileSync(f, 'utf8')
  for (const literal of FORBIDDEN_LITERALS) {
    if (content.includes(literal)) {
      fail(`${f}: 硬编码英文文案 "${literal}"——组件文案请走 t()（i18n.ts 字典）；注释请引用键名而非整句文案`)
    }
  }
}

// ── 5：后端自带文案（B-3）───────────────────────────────────────────
// A backend writes its own copy (D2: the host dictionary is not readable from
// a backend), so the two silent-failure classes above apply there too — a
// missing `en` would show zh to an English user, and `{name}` would go on
// screen unfilled. Registered modules are audited through the read-only view
// each exports. The dead-key rule does NOT apply here: a backend's entries are
// consumed by `claudeText` / `claudeTemplate` calls inside its own package, a
// typo is already a compile error (`ClaudeTextKey`), and an unused entry is
// dead weight rather than a silent failure.
for (const { module, dict } of BACKEND_TEXT_MODULES) {
  for (const [key, entry] of Object.entries(dict)) {
    if (entry.zh === undefined) fail(`${module}: ${key}: 缺 zh`)
    if (entry.en === undefined) fail(`${module}: ${key}: 缺 en`)
    for (const lang of ['zh', 'en'] as const) {
      for (const form of forms(entry[lang])) {
        const m = singleBrace.exec(form)
        if (m) fail(`${module}: ${key}.${lang}: 单花括号 {${m[1]}}——模板只替换 {{${m[1]}}}`)
      }
    }
    const zh = placeholders(entry.zh)
    const en = placeholders(entry.en)
    if (entry.en !== undefined && !isSubset(zh, en) && !isSubset(en, zh)) {
      fail(`${module}: ${key}: 占位符名不一致 zh={{${[...zh].join(',')}}} en={{${[...en].join(',')}}}`)
    }
  }
}

// ── 6：跨字典一致性（平台文案只有一处真源）──────────────────────────────
// 宿主与内置后端渲染的是同一批平台字符串，值只写在 PLATFORM_TEXT_SOURCE 一处：
// 宿主字典 `...PLATFORM_TEXT` 展开，两个后端 `pickPlatformText([...])` 各取自己
// 渲染的那几条。这条门禁的内容就是"逐字相等"——键存在不算通过，只有值与真源
// 相等才算，所以任何一侧把一份内联副本写回来（同名键在展开之后会覆盖真源）
// 都会红。性质：防的是"副本被重新引入"，不是防键缺失（缺键由存在性检查兜住）。
const PLATFORM_TEXT_CONSUMERS: readonly {
  readonly module: string
  readonly dict: Readonly<Record<string, { readonly zh?: I18nText; readonly en?: I18nText }>>
  readonly keys: readonly PlatformTextKey[]
}[] = [
  {
    module: 'src/backends/claude/text.ts',
    dict: claudeTexts,
    keys: ['doctor-unknown', 'rewind-first-message', 'rename-failed', 'rename-usage', 'status-rate-limit-five-hour', 'status-rate-limit-seven-day'],
  },
  {
    module: 'src/backends/codex/text.ts',
    dict: codexTexts,
    keys: ['capability-failed', 'status-rate-limit-five-hour', 'status-rate-limit-seven-day', 'doctor-unknown', 'effort-invalid', 'tool-name-bash', 'tool-name-edit'],
  },
]

const platformKeys = Object.keys(PLATFORM_TEXT) as PlatformTextKey[]
for (const key of platformKeys) {
  const entry = i18nDict[key]
  if (entry === undefined) {
    fail(`i18nDict: ${key}: 平台文案没有展开——${PLATFORM_TEXT_SOURCE} 的每个键都必须出现在宿主字典里`)
    continue
  }
  for (const lang of ['zh', 'en'] as const) {
    if (entry[lang] !== PLATFORM_TEXT[key][lang]) {
      fail(`i18nDict: ${key}.${lang}: 与 ${PLATFORM_TEXT_SOURCE} 不一致（宿主字典不得另存一份副本）${JSON.stringify(entry[lang])} ≠ ${JSON.stringify(PLATFORM_TEXT[key][lang])}`)
    }
  }
}

for (const { module, dict, keys } of PLATFORM_TEXT_CONSUMERS) {
  // 登记清单必须恰好等于该后端实际携带的平台键：少一条＝展开被删（消费点
  // 悄悄没了文案），多一条＝有人把它写成内联副本、或新共用了文案，都要在这里
  // 过目后才放行。
  const carried = platformKeys.filter(key => dict[key] !== undefined).sort()
  const pinned = [...keys].sort()
  if (carried.join(' ') !== pinned.join(' ')) {
    fail(`${module}: 携带的平台键与登记清单不一致——实际 ${carried.join(',') || '（无）'}，登记 ${pinned.join(',')}`)
  }
  for (const key of keys) {
    const entry = dict[key]
    if (entry === undefined) continue // 集合比对已报过；这里只比字面值
    for (const lang of ['zh', 'en'] as const) {
      if (entry[lang] !== PLATFORM_TEXT[key][lang]) {
        fail(`${module}: ${key}.${lang}: 与 ${PLATFORM_TEXT_SOURCE} 不一致（不得另写副本）${JSON.stringify(entry[lang])} ≠ ${JSON.stringify(PLATFORM_TEXT[key][lang])}`)
      }
    }
  }
}

const total = Object.keys(i18nDict).length
const backendTotal = BACKEND_TEXT_MODULES.reduce((sum, module) => sum + Object.keys(module.dict).length, 0)
if (failures > 0) {
  console.error(`verify-i18n: ${total} 条目（+ 后端自带 ${backendTotal}），${failures} 处失败`)
  process.exit(1)
}
console.log(`✓ verify-i18n: ${total} 条目（+ 后端自带 ${backendTotal}）——语言完整、占位符一致、无死 key、平台文案跨字典一致（${Object.keys(PLATFORM_TEXT).length} 条）`)
