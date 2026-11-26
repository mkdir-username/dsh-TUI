# Documentation index

The root README lists what ships; the details live here. Every page is English
and carries the `.en.md` suffix. The user-facing manual is also bundled with the
package as the `dsh-tui-guide` skill (`guide/dsh-tui-guide/<name>.en.md`, a
byte-identical copy of the sources below).

## User manual

These eleven pages ship inside the package.

| Page | What it covers |
| --- | --- |
| [getting-started.en.md](getting-started.en.md) | Install, first run, the update path |
| [user-guide.en.md](user-guide.en.md) | Day-to-day use: sessions, slash commands, settings |
| [interaction.en.md](interaction.en.md) | Keys, approval and question prompts, composer modes, side panel |
| [configuration.en.md](configuration.en.md) | `settings.json`, environment variables, per-option behaviour |
| [claude-backend.en.md](claude-backend.en.md) | Driving Claude Code through the experimental backend |
| [codex-backend.en.md](codex-backend.en.md) | Driving a local Codex app-server |
| [themes.en.md](themes.en.md) | Built-in themes, plugin themes, color keys |
| [migrate.en.md](migrate.en.md) | Importing history from other coding agents |
| [cli.en.md](cli.en.md) | The `dst` automation CLI and its MCP surface |
| [vscode.en.md](vscode.en.md) | Running inside the VS Code terminal |
| [plugins.en.md](plugins.en.md) | Authoring a plugin; defers to the profile's admission guide |

## Implementation and maintenance

| Page | What it covers |
| --- | --- |
| [architecture.en.md](architecture.en.md) | Layers, runtime flow, limitations |
| [contributing.en.md](contributing.en.md) | The shared development contract: layout, gates, verification |
| [session-mount-runtime.en.md](session-mount-runtime.en.md) | How a session is mounted and torn down |
| [agent-session-api.en.md](agent-session-api.en.md) | The stdio MCP server behind `dst session` |
| [onboarding-provider-setup.en.md](onboarding-provider-setup.en.md) | Accounts and models in first-run onboarding |
| [agent-navigation.en.md](agent-navigation.en.md) | Routing user phrases to the right source |
| [references.en.md](references.en.md) | The pinned upstream reference map |
| [roadmap.en.md](roadmap.en.md) | Direction and open work |
| [false-waits.en.md](false-waits.en.md) | Catalog of blocking waits that must stay parkable |

## Community

| Page | What it covers |
| --- | --- |
| [community-management.en.md](community-management.en.md) | Issue, review and release conventions for contributors |

Upstream boundaries and the adapter contract live in [ADAPTER.md](../ADAPTER.md);
the repository map and editing rules live in [AGENTS.md](../AGENTS.md).
