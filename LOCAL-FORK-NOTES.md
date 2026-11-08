# Локальный форк dsh-TUI — состояние на 2026-11-07

Форк клонирован, чтобы локальные патчи жили в git, а не в `sed` по собранному
`lib/types` установленного пакета. `~/zshrc`-обёртка `ds()` **всё ещё запускает
npm-пакет** `@deepseek-harness-tui/dsh-tui@0.19.0` из профиля `dsh-tui` — миграции
на форк не было.

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

TUI (`src/**`), 11 единиц:

1. Thinking остаётся раскрытым после хода — `MessageList.js` (сейчас `sed` в `patch-dsh-tui.sh`)
2. Баланс-гард через `127.0.0.1:8091` — `deepseekBalance.js`
3. Чип имени сессии без лимита 28 ячеек — `PromptInput.js`
4. `plan-mode`: Shift+Tab из плана после переключателя в последнем шаге — `dsh-adapter/channel/mode-actions.js`, `mode-permission-actions.js`
5. stdout EIO на мёртвом pty — `dsh-adapter/plugin.js`
6. pid-старт в mount-ledger — `sessionMounts.js` (апстрим #1770 закрыл только Linux TID; macOS-ветка `ps -o lstart` остаётся нашей)
7. macOS-хоткеи, кириллическая раскладка, copy-on-select — `PromptInput`, `ink/hooks/use-input`, `ink/parse-keypress`, `screens/Chat`, `utils/keymap`, `utils/modifiers`
8. Ghostty word/line jump — `screens/Chat`, `screens/Launchpad`
9. no-todo — `components/sidePanel/builtinPanels.js`, `channel/projection.js` (+ вырезание `tool-todo` из YAML пресетов, это ядро)
10. handoff-marker в чате — `channel/projection.js`, `dsh-adapter/backend/translate.js`
11. statusline: `$`-цена и цель сессии — `screens/StatusLine.tsx` + два новых модуля (`statuslineCost`, `sessionGoal`)

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

## Как переключить `ds()` на форк (после переноса всех патчей)

1. В `~/.dsh/profiles/dsh-tui/package.json` заменить версию пакета на `link:/Users/username/Docs/dsh-tui-spike/fork` и прогнать `pnpm install` в профиле
2. Из `/Users/username/.dsh/bin/patch-dsh-tui.sh` убрать шаги, которые уже в исходниках, оставить четыре ядровых
3. Проверить, что `/update` внутри TUI не тянет пакет из реестра и не затирает `link:`

Переключать раньше нельзя: в форке 3 патча из 12 TUI, живой TUI потеряет
статуслайн, хоткеи и очередь.

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
