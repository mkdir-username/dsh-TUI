# Локальный форк dsh-TUI — состояние на 2026-11-08 (миграция завершена)

**`ds()` запускает форк.** Профиль `~/.dsh/profiles/dsh-tui` держит зависимость
`"@deepseek-harness-tui/dsh-tui": "link:/Users/username/Docs/dsh-tui-spike/fork"`,
поэтому TUI приезжает из этого дерева (`pnpm compile` → `lib/types`), а
`~/.dsh/bin/patch-dsh-tui.sh` работает в режиме форка: ставит только ядровые
патчи (`bin.js`, env-guard, transport-cause, ядровая часть plan-mode) и гоняет
гейт паритета `~/.dsh/bin/verify-fork-parity.mjs` (14/14). TUI-правки в скрипте
отключены — они уже в `src/**`. Откат на реестр: вернуть `package.json` из
`package.json.bak-registry` в профиле и `pnpm install`.

Маршрут модели: по умолчанию OpenCode Go (`opencode-go/deepseek-v4.1-flash`) по
ключу `OPENCODE_API_KEY`; без ключа профиль уходит на прямой
`deepseek-official/deepseek-flash` через барьер `:8091`. `web_search` и `/balance`
всегда идут прямым DeepSeek через тот же барьер (в подписку OpenCode поиск не
входит). Выбор — `/model` внутри TUI или `DSH_LLM_ROUTE=deepseek ds`.

Форк клонирован, чтобы локальные патчи жили в git, а не в `sed` по собранному
`lib/types` установленного пакета.

- Клон: `/Users/username/Docs/dsh-tui-spike/fork` (upstream `ccch1mneyyy/dsh-TUI`, 0.19.0)
- Ремоуты: `mine` = `mkdir-username/dsh-TUI` (личный, private) — пушим туда, ветка
  `main` отслеживает `mine/main`; `origin` = upstream, только fetch/merge
- Ветка одна, коммит порта: `25a15d4` («портированы локальные патчи ctrl-enter,
  очереди /compact и restruct-plan»), 17 файлов, +581/−43
- Источник патчей, которые ещё переносятся: `/Users/username/.dsh/bin/patch-dsh-tui.sh`
  и соседние `patch-dsh-*.mjs`, `statusline-patch/apply.sh`

## Что уже в исходниках форка

| Патч | Файлы | Проверка |
|---|---|---|
| Ctrl+Enter без аборта | `src/components/PromptInput.tsx`, `src/tips.ts`, `src/i18n.ts`, `README*.md` | `pnpm verify:ctrl-enter-steer` (4 PASS) |
| Очередь ввода на время `/compact` | `src/dsh-adapter/channel/compact-hold.ts` (новый), `input-delivery.ts`, `input-actions.ts`, `PromptInput.tsx`, `channel-view.ts` | `pnpm verify:compact-queue` (20 PASS) |
| restruct-plan перед сжатием | `src/dsh-adapter/channel/compaction.ts`, `action-readiness.ts`, `extensions.ts`, `channel-ui.ts`, `screens/Chat.tsx` | `pnpm verify:compact-rp` (13 PASS) + `pnpm typecheck` + гейты |

Все `verify-*` пробы зарегистрированы в `package.json`. `verify:ctrl-enter-steer` и
`verify:compact-queue` написаны по образцу апстримного `scripts/verify-shift-tab-mode.mjs`
(headless-рендер композера + инъекция escape-последовательностей); `verify:compact-rp`
проверяет вердикт маркера на собранном `lib/types`.

## Что осталось перенести

TUI (`src/**`), перенесено 7 из 11 (коммиты `49609576`, `3912f31c`): thinking,
баланс-гард, чип сессии, `plan-intent` для Shift+Tab, pid-старт в mount-ledger,
no-todo, маркер контролёра.

Осталось:

5. stdout EIO на мёртвом pty — `dsh-adapter/plugin.js` (гард опирается на
   `appendCrashLog`, в форке он есть; ставится верхним блоком при импорте)
7. macOS-хоткеи, кириллическая раскладка, copy-on-select — `PromptInput`,
   `ink/hooks/use-input`, `ink/parse-keypress`, `screens/Chat`, `utils/keymap`,
   `utils/modifiers`
8. Ghostty word/line jump — `screens/Chat`, `screens/Launchpad`
11. statusline: `$`-цена и цель сессии — `screens/StatusLine.tsx` + два новых модуля (`statuslineCost`, `sessionGoal`)

Пункты 7 и 8 ждут `src/screens/Chat.tsx`: в нём идёт чужая правка (star → coupon),
и коммит по этому пути утащил бы её целиком. Пункт 11 по заметке ведёт отдельная
сессия — свериться, чтобы не портировать дважды.

Ядро (остаётся `sed`-ом, fork его не забирает):

- `@deepseek-ai/dsh/lib/bin.js` — снятый `import.meta.main`-гард
- `dsh-app-boot` — защита от `NODE_TLS_REJECT_UNAUTHORIZED`
- `dsh-llm-deepseek` — причина в тексте TRANSPORT-ошибки
- `dsh-plan-mode` — план-режим (ядровая часть патча)
- строка `tool-ralph` в `cordis.patch.yml` профиля

**Статуслайн не портируй дважды**: его ведёт сессия `230f53f6` («Remove cache from
statusline dsh»), ей отправлено указание править `src/` этого клона. В живом патче
2026-11-07 уже: чип `cache NN%` выключен (`statusBar.cache: false` в
`~/.dsh-tui/settings.json`), а `$`-цена показывается круглые сутки — peak-гейт снят в
`statusline-patch/statuslineCost.js`. Порт в `src/` должен повторить оба решения, иначе
форк вернёт старое поведение.

## 2026-11-08: star-механика вырезана, tps включён по умолчанию

- Удалены `src/components/StarPrompt.tsx`, `src/starAction.ts`, `src/usageStats.ts`;
  из `Chat.tsx` ушли seam `starPrompt`, `/star`, `Alt+S` и авто-модалка, из
  `commands.ts` / `utils/keymap.ts` / `settings/definitions.ts` / `i18n.ts` —
  команда, биндинг, описание шортката и все `star-*` строки.
- Купонный поп-ап (login bonus) вынесен в `src/components/WhaleCouponPrompt.tsx`
  вместе с пузырьками и константами карточки; регрессия — `scripts/verify-coupon-prompt.tsx`.
  Старые `verify-star-action.mjs`, `verify-usage-stats.mjs`, `verify-whale-girl.tsx`
  удалены, `scripts/run-ci-group.mjs` обновлён.
- `statusBar.tps` теперь `true` по умолчанию (`src/tuiDisplayPrefs.ts`); в живом
  TUI включено `"tps": true` в `~/.dsh-tui/settings.json`. Чип рисуется как
  `▕████▏ 42 tps` во время ответа и держит последний замер между ходами.
- В живом npm-пакете правка пока живёт зеркалом (до переключения профиля на форк):
  `usageStats.dueStarModal` возвращает null, чип star на launchpad и строка в
  сплэше отключены, `/star` убран из списка команд. Действует после перезапуска TUI.

## Сборка и проверки

```bash
cd /Users/username/Docs/dsh-tui-spike/fork
pnpm install --frozen-lockfile     # ~54 с, prepare сразу компилит; нужен pnpm 11.21 и сабмодуль vendor/dsh-std
pnpm compile                       # ~13 с — src/ → lib/types/, после каждой правки
pnpm typecheck                     # ~10 с
pnpm verify:ctrl-enter-steer
pnpm verify:compact-queue
pnpm verify:compact-rp
pnpm smoke                         # прочие гейты: boundary, source-hygiene, channel-ui, settings, patch-surface
```

Замеры на чистом клоне: `git clone --recurse-submodules` 8 с, `pnpm install` 54 с,
`pnpm build` 110 с. Гейтов 103, зелёных 102: `verify:cli` падает на Node 22.22.3
из-за CommonJS-импорта `x` из `tar@7.5.22` в тесте standalone-распаковки — это
апстримная проблема версии Node, не нашего порта.

## Правила правки форка

- Правим `src/**`, `lib/types/**` — только сборка, руками не трогать (правило репозитория)
- После правки `src/` обязан пройти `pnpm compile` и `pnpm typecheck`
- Импорт `@deepseek-ai/*` — только из `src/dsh-adapter/` (гейт `verify:boundary`)
- README.md и README_ZH.md синхронно по хоткеям/поведению
- Ничего не пушить: у клона нет remote `upstream`, а origin — чужой репозиторий

## Профиль уже смотрит в форк (2026-11-08)

`~/.dsh/profiles/dsh-tui/package.json` → `link:/Users/username/Docs/dsh-tui-spike/fork`,
`pnpm-lock.yaml` закрепляет тот же link; `node_modules/@deepseek-harness-tui/dsh-tui`
— симлинк на клон. Проверки:

- `bash ~/.dsh/bin/patch-dsh-tui.sh` — режим fork: ядровые патчи + `паритет форка: 14/14`;
  скрипт сам отказывается запускать TUI, если `src/**` новее сборки.
- `node --input-type=module -e "console.log(import.meta.resolve('@deepseek-harness-tui/dsh-tui'))"`
  из каталога профиля → `file:///Users/username/Docs/dsh-tui-spike/fork/lib/types/index.js`.

Откат на реестровый пакет (обратимо): вернуть
`/Users/username/.dsh/profiles/dsh-tui/package.json.bak-20261108-1730-registry`,
`pnpm install` в профиле, перезапустить TUI.

Что осталось проверить вручную: `/update` внутри TUI — он может поставить пакет из
реестра и переписать `link:`; после него сверить `package.json` и при необходимости
повторить `pnpm install`.

## Грабли текущего окружения

- Живой модельный ход в изолированном профиле недоступен: `connect ECONNREFUSED 127.0.0.1:9480`
  (локальный прокси DeepSeek Messages). TUI при этом стартует и рисуется.
- Изолированный профиль для опытов: `/tmp/dsh-spike-home` (`DSH_HOME`), зависимость
  `link:` на клон. Профиль `~/.dsh/profiles/dsh-tui` не трогали.
- Мусор: пустой каркас `/Users/username/.dsh/profiles/dsh-tui-spike` — агентский гейт
  критических правок не дал его удалить, снести руками.
- `restart_session` работает: сервис `dshRestart` монтируется плагином
  `~/.claude/dotfiles/dsh/plugins/dsh-session-restart`; в процессе, запущенном до
  появления плагина, вызов падает с «dshRestart service is missing» — нужен один
  человеческий `/restart`, дальше перезапуски агент делает сам.

## Известная краснота гейтов (не наша)

- `scripts/verify-todo-side-panel.tsx`: 43 проверки красные и на этом же дереве без правок
  (`git show HEAD:src/components/GoalTodoPanel.tsx` → 43 фейла: секции `copy:` и
  `status:` — пустой выделенный текст / не находится строка статуса). С правкой goal-строки
  набор фейлов совпадает построчно. Разбирать отдельно: место правки — копирование через
  `noSelect`-забор панели, не хром.
