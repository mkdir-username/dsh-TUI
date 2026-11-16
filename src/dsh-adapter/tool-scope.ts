/** Per-agent preset/team tool visibility on the 0.2.2 registry seam.
 * Older hosts retain the final assembly filters in plugin.ts instead.
 */
import type { Context } from '@deepseek-ai/cordis'
import * as scope from '@deepseek-ai/dsh-scope'
import { t } from '../i18n.js'
import { presetToolDeny, runningPresetOf } from './presets.js'
import { teamReplacedToolDeny } from './team-mode.js'

interface ToolDefinitionLike {
  readonly name: string
}

interface ToolsServiceLike {
  restrict?(filter: { readonly deny?: readonly string[] }): () => void
  definitions?(scope?: object): readonly ToolDefinitionLike[]
}

/** The agent shape the restriction needs; no driver implementation is owned here. */
export interface ScopedAgentLike {
  readonly ctx: Context
  readonly session: unknown
}

export interface ToolScope {
  /** Track an existing agent and refresh the composition's live scopes. */
  apply(agent: ScopedAgentLike): void
}

/** Channel-side transient notice; absent in headless compositions. */
export type ToolScopeNotice = (
  text: string,
  options?: { readonly color?: 'warning' | 'error'; readonly timeoutMs?: number },
) => unknown

// Scope ancestry and definitions arrived after the oldest supported hosts.
// Probe the public export by shape; the legacy assembly path needs neither.
const scopeParentOf = (scope as { readonly scopeParentOf?: (key: object) => object | undefined }).scopeParentOf

/**
 * Keep one exact restriction per live agent, including background/child agents
 * that never bind to the screen. Agent publication awaits agent/created, so its
 * restriction is installed before the factory releases any queued work.
 *
 * @param ctx - Composition context supplying the registry and lifecycle events.
 * @param own - Channel lifetime funnel; releases listeners and every owned mask.
 * @param currentAgent - Initial/borrowed foreground not necessarily in the registry.
 * @param notice - Channel notice seam: an uninstalled mask is user-visible drift.
 */
export function createToolScope(
  ctx: Context,
  own: (dispose: () => void) => void,
  currentAgent: () => ScopedAgentLike | undefined,
  notice?: ToolScopeNotice,
): ToolScope {
  const tools = (ctx as unknown as { get?(key: string): ToolsServiceLike | undefined }).get?.('tools')
  // No registry-side work is needed on legacy hosts (or a rosterless fixture).
  // Their assembly filter is still authoritative, with its original lifecycle.
  if (typeof tools?.restrict !== 'function' || typeof tools.definitions !== 'function' || scopeParentOf === undefined) return { apply: () => undefined }
  const tracked = new Set<ScopedAgentLike>()
  const retired = new WeakSet<object>()
  const applied = new Map<ScopedAgentLike, { readonly signature: string; readonly dispose: () => void }>()
  const listeners: Array<() => void> = []
  let closed = false
  let refreshing = false
  let refreshQueued = false
  // A mask transition emits `tools/change` synchronously. A refresh re-entering
  // between the install and the bookkeeping would install a second mask for the
  // same agent, so the transition owns the registry until it is recorded.
  let mutating = false
  // One visible marker per failure signature: a refresh storm must not own
  // the notice area, while a new failure mode still reaches the user.
  const reported = new Set<string>()
  // Install and disposal both emit tools/change, so a target that keeps
  // failing would re-arm itself on every pass. Retry only when the wanted
  // filter actually changed.
  const failed = new WeakMap<ScopedAgentLike, string>()

  const release = (agent: ScopedAgentLike): void => {
    const previous = applied.get(agent)
    applied.delete(agent)
    previous?.dispose()
  }
  own(() => {
    closed = true
    const failures: unknown[] = []
    for (const dispose of [...listeners.splice(0), ...[...applied.values()].map(entry => entry.dispose)]) {
      try { dispose() } catch (error) { failures.push(error) }
    }
    applied.clear()
    tracked.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'dsh-tui: tool scope cleanup failed')
  })

  const applyOne = (agent: ScopedAgentLike, strict = false): void => {
    const scoped = agent.ctx as unknown as { get?(key: string): ToolsServiceLike | undefined } | undefined
    const service = scoped?.get?.('tools')
    if (typeof service?.restrict !== 'function' || typeof service.definitions !== 'function' || scopeParentOf === undefined) return
    let preset = 'unknown'
    let signature: string | undefined
    try {
      preset = runningPresetOf(agent.session) ?? 'unknown'
      // The parent view contains inherited/restrictable names before OUR mask.
      // The exact-agent view also contains own-scope Team tools. Using the
      // latter alone would forget already-hidden spawners on the next refresh;
      // using the global view would never see preset or Team registrations.
      const inherited = new Set(service.definitions(scopeParentOf(agent)).map(tool => tool.name))
      const visible = new Set(service.definitions(agent).map(tool => tool.name))
      const deny = [...new Set([
        ...presetToolDeny(preset),
        ...teamReplacedToolDeny(new Set([...inherited, ...visible])),
      ])].filter(name => inherited.has(name)).sort()
      signature = deny.join('\n')
      const previous = applied.get(agent)
      if (previous?.signature === signature) return
      if (failed.get(agent) === signature) return
      mutating = true
      try {
        // Install the replacement before dropping the mask in force: a registry
        // that refuses the new filter must leave the agent as restricted as it
        // already was, never less.
        // Empty filters are rejected upstream and carry no opinion here.
        const dispose = deny.length > 0 ? service.restrict({ deny }) : undefined
        try {
          previous?.dispose()
        } catch (error) {
          // The replacement is rolled back so the agent never carries two masks;
          // the mask that was in force stays.
          try { dispose?.() } catch { /* already failing: report the first error */ }
          throw error
        }
        if (dispose === undefined) applied.delete(agent)
        else applied.set(agent, { signature, dispose })
        failed.delete(agent)
      } finally {
        mutating = false
      }
    } catch (error) {
      failed.set(agent, signature ?? '*')
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.error?.('dsh-tui: could not restrict tools for the agent', error)
      const failureKey = `${preset}\u0000${message}`
      if (!reported.has(failureKey)) {
        reported.add(failureKey)
        notice?.(t('tool-scope-restrict-failed', { preset, err: message }), { color: 'error', timeoutMs: 12_000 })
      }
      // Publication is the one moment the mask must exist: refuse the agent
      // rather than release work into an unrestricted session. Every other
      // refresh retries and reports without taking the TUI down.
      if (strict) throw error
    } finally {
      // Drain the notifications the transition swallowed, without recursing
      // through an outer refresh loop.
      if (!refreshing && refreshQueued) refresh()
    }
  }
  const refresh = (): void => {
    if (closed) return
    // Both install AND disposal synchronously emit tools/change. Finish the
    // atomic refresh first, then coalesce those events into one stable pass.
    refreshQueued = true
    if (refreshing || mutating) return
    refreshing = true
    try {
      do {
        refreshQueued = false
        const registry = (ctx as unknown as { get?(key: string): { list?(): readonly ScopedAgentLike[] } | undefined }).get?.('agents')
        const foreground = currentAgent()
        for (const agent of registry?.list?.() ?? []) if (!retired.has(agent)) tracked.add(agent)
        if (foreground !== undefined && !retired.has(foreground)) tracked.add(foreground)
        for (const agent of tracked) applyOne(agent)
      } while (refreshQueued && !closed)
    } finally {
      refreshing = false
    }
  }
  const apply = (agent: ScopedAgentLike): void => {
    if (closed || retired.has(agent)) return
    tracked.add(agent)
    refresh()
  }
  listeners.push(ctx.on('tools/change' as never, refresh as never))
  listeners.push(ctx.on('agent/created', ({ agent }) => {
    if (closed || retired.has(agent)) return undefined
    tracked.add(agent)
    applyOne(agent, true)
    return undefined
  }))
  listeners.push(ctx.on('agent/disposed', ({ agent }) => {
    retired.add(agent)
    tracked.delete(agent)
    release(agent)
  }))
  listeners.push(ctx.on('session/event', (_session, event) => {
    if ((event as { type: string }).type === 'agent-preset/selected') refresh()
  }))
  refresh()
  return { apply }
}
