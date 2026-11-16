/** Real tool/scope/AgentLoop regression for preset and team visibility.
 * No model transport or network; temporary HOME is installed before source imports.
 * Run: node --import tsx/esm scripts/verify-tool-scope.ts
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createToolScope, type ScopedAgentLike } from '../src/dsh-adapter/tool-scope.js'
import * as presets from '../src/dsh-adapter/presets.js'
import * as teams from '../src/dsh-adapter/team-mode.js'

const definition = (name: string): ToolDefinition => ({
  name, description: name, parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'object', properties: {} }, render: () => [] },
  async execute() { return {} },
})
const names = (root: Context, scope?: object): string[] => root.tools.definitions(scope).map(tool => tool.name).sort()
const owner = () => {
  const releases: Array<() => void> = []
  return {
    own(dispose: () => void) { releases.push(dispose) },
    dispose() { for (const release of releases.splice(0).reverse()) release() },
  }
}
async function toolsRoot(): Promise<Context> {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolsService)
  return root
}
let failures = 0
async function check(label: string, run: () => Promise<void> | void): Promise<void> {
  try { await run(); console.log(`PASS ${label}`) }
  catch (error) { failures++; console.error(`FAIL ${label}`, error) }
}

await check('synchronous restriction notifications converge and preset switches remove the exact mask', async () => {
  const root = await toolsRoot()
  const lifetime = owner()
  let scoped: Scope | undefined
  let stopGuard: (() => void) | undefined
  try {
    root.tools.register(definition('ask_user_question'))
    const agent = { session: { header: { agentPreset: 'minimal' }, events: [] as Array<{ type: string; data: { agentPreset: string } }> } } as ScopedAgentLike & {
      session: { header: { agentPreset: string }; events: Array<{ type: string; data: { agentPreset: string } }> }
    }
    scoped = createScope(root, agent)
    Object.assign(agent, { ctx: scoped.ctx })
    let changes = 0
    const warnings: unknown[] = []
    // Bound the broken implementation independently: fail deterministically,
    // without exhausting the process stack or depending on a timing window.
    stopGuard = root.on('tools/change', () => {
      changes++
      if (changes > 24) throw new Error('restriction change avalanche')
    })
    const host = { on: root.on.bind(root), get: root.get.bind(root), logger: { warn: (...args: unknown[]) => warnings.push(args) } } as unknown as Context
    const scope = createToolScope(host, lifetime.own, () => agent)
    scope.apply(agent)
    assert.equal(warnings.length, 0, 'a valid restriction never fails or recursively retries')
    assert.ok(changes <= 2, `one installation emitted ${changes} changes`)
    assert.deepEqual(names(root, agent), [])
    for (let repeat = 0; repeat < 5; repeat++) scope.apply(agent)
    assert.ok(changes <= 2, 'unchanged apply does not reinstall the mask')
    agent.session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
    scope.apply(agent)
    assert.deepEqual(names(root, agent), ['ask_user_question'], 'leaving Minimal restores the tool')
    agent.session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'minimal' } })
    scope.apply(agent)
    lifetime.dispose()
    assert.deepEqual(names(root, agent), ['ask_user_question'], 'channel release lifts its mask from a borrowed live agent')
  } finally {
    stopGuard?.()
    lifetime.dispose()
    await scoped?.dispose()
    await root.fiber.dispose()
  }
})

await check('a failed restriction is logged and announced once per failure signature', async () => {
  const root = await toolsRoot()
  const lifetime = owner()
  const errors: unknown[][] = []
  const notices: Array<{ text: string; options: unknown }> = []
  // The registry throws on the installation itself: the mask never exists, so
  // the user must hear about it instead of meeting an over-privileged agent.
  const fakeTools = {
    definitions: () => [{ name: 'ask_user_question' }],
    restrict: () => { throw new Error('agent scope is no longer live') },
  }
  const host = {
    on: root.on.bind(root),
    get: (key: string) => (key === 'tools' ? fakeTools : undefined),
    logger: { error: (...args: unknown[]) => errors.push(args) },
  } as unknown as Context
  const agent = { ctx: host, session: { header: { agentPreset: 'minimal' }, events: [] } } as unknown as ScopedAgentLike
  const scope = createToolScope(host, lifetime.own, () => undefined, (text, options) => { notices.push({ text, options }) })
  try {
    scope.apply(agent)
    assert.equal(errors.length, 1, 'the failure is logged at error level')
    assert.equal(notices.length, 1, 'the user sees one marker for the uninstalled mask')
    assert.match(notices[0]!.text, /minimal/u, 'the marker names the preset')
    assert.match(notices[0]!.text, /agent scope is no longer live/u, 'the marker carries the reason')
    assert.deepEqual(notices[0]!.options, { color: 'error', timeoutMs: 12_000 })
    scope.apply(agent)
    assert.equal(notices.length, 1, 'a repeated failure does not repeat the marker')
    assert.equal(errors.length, 1, 'the same wanted filter is not retried until it changes')
  } finally {
    lifetime.dispose()
    await root.fiber.dispose()
  }
})

type Restrictable = { restrict(filter: { readonly deny?: readonly string[] }): () => void }

await check('a refused installation leaves the previous mask in force', async () => {
  const root = await toolsRoot()
  const lifetime = owner()
  const notices: Array<{ text: string; options: unknown }> = []
  root.tools.register(definition('ask_user_question'))
  root.tools.register(definition('create_worktree'))
  const agent = { session: { header: { agentPreset: 'minimal' }, events: [] as Array<{ type: string; data: { agentPreset: string } }> } } as unknown as ScopedAgentLike & { session: { header: { agentPreset: string }; events: Array<{ type: string; data: { agentPreset: string } }> } }
  const scoped = createScope(root, agent)
  Object.assign(agent, { ctx: scoped.ctx })
  const service = scoped.ctx.get('tools') as unknown as Restrictable
  const original = service.restrict.bind(service)
  let failNext = false
  service.restrict = filter => {
    if (failNext) throw new Error('registry refused the filter')
    return original(filter)
  }
  try {
    const scope = createToolScope(root, lifetime.own, () => undefined, (text, options) => { notices.push({ text, options }) })
    scope.apply(agent)
    assert.deepEqual(names(root, agent), [], 'the minimal mask is installed')
    failNext = true
    agent.session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'liangshen' } })
    assert.doesNotThrow(() => scope.apply(agent), 'a refused refresh never throws')
    assert.deepEqual(names(root, agent), [], 'the mask in force still hides the same tools')
    assert.equal(notices.length, 1, 'the refusal is announced once')
    failNext = false
    agent.session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
    scope.apply(agent)
    assert.deepEqual(names(root, agent), ['ask_user_question', 'create_worktree'], 'no leaked mask after the refused replacement')
  } finally {
    lifetime.dispose()
    await scoped.dispose()
    await root.fiber.dispose()
  }
})

await check('a failing disposal rolls the replacement back instead of leaving two masks', async () => {
  const root = await toolsRoot()
  const lifetime = owner()
  const notices: Array<{ text: string; options: unknown }> = []
  root.tools.register(definition('ask_user_question'))
  root.tools.register(definition('create_worktree'))
  const agent = { session: { header: { agentPreset: 'minimal' }, events: [] as Array<{ type: string; data: { agentPreset: string } }> } } as unknown as ScopedAgentLike & { session: { header: { agentPreset: string }; events: Array<{ type: string; data: { agentPreset: string } }> } }
  const scoped = createScope(root, agent)
  Object.assign(agent, { ctx: scoped.ctx })
  const service = scoped.ctx.get('tools') as unknown as Restrictable
  const original = service.restrict.bind(service)
  let failDisposeOnce = false
  let live = 0
  service.restrict = filter => {
    const dispose = original(filter)
    live += 1
    return () => {
      if (failDisposeOnce) {
        failDisposeOnce = false
        throw new Error('scope already released')
      }
      live -= 1
      dispose()
    }
  }
  try {
    const scope = createToolScope(root, lifetime.own, () => undefined, (text, options) => { notices.push({ text, options }) })
    scope.apply(agent)
    assert.equal(live, 1, 'one mask before the switch')
    failDisposeOnce = true
    agent.session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'liangshen' } })
    assert.doesNotThrow(() => scope.apply(agent), 'a failing disposal never throws out of the refresh')
    assert.deepEqual(names(root, agent), [], 'the mask that was in force still hides the tools')
    assert.equal(live, 1, 'the replacement was rolled back: exactly one mask remains')
    assert.equal(notices.length, 1, 'the disposal failure is announced once')
    agent.session.events.push({ type: 'agent-preset/selected', data: { agentPreset: 'standard' } })
    scope.apply(agent)
    assert.deepEqual(names(root, agent), ['ask_user_question', 'create_worktree'], 'the rolled-back replacement left nothing behind')
    assert.equal(live, 0, 'no mask survives the empty preset')
  } finally {
    lifetime.dispose()
    await scoped.dispose()
    await root.fiber.dispose()
  }
})

await check('publication refuses an agent whose mask cannot be installed', async () => {
  const root = new Context()
  const lifetime = owner()
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolsService, AgentRegistry]) await root.plugin(plugin)
    await root.plugin(AgentLoop, { agents: [] })
    root.tools.register(definition('create_worktree'))
    root.tools.restrict = (() => { throw new Error('registry unavailable') }) as typeof root.tools.restrict
    createToolScope(root, lifetime.own, () => undefined, () => undefined)
    await assert.rejects(
      () => root.agents.create({
        sessionId: SessionId('scope-refused'),
        meta: { agentPreset: 'liangshen' },
        agentOptions: { provider: 'fixture', model: 'fixture' },
      }),
      /registry unavailable/u,
      'an agent is not published without its mask',
    )
  } finally {
    lifetime.dispose()
    await root.fiber.dispose()
  }
})

await check('team discovery uses the agent view and inherited masks remain stable across refresh', async () => {
  const root = await toolsRoot()
  const lifetime = owner()
  const preset = {}
  const presetScope = createScope(root, preset)
  const agent = { session: { header: { agentPreset: 'standard' }, events: [] } } as unknown as ScopedAgentLike
  const scoped = createScope(root, agent, { parent: preset })
  Object.assign(agent, { ctx: scoped.ctx })
  try {
    presetScope.ctx.get('tools').register(definition('subagent'))
    presetScope.ctx.get('tools').register(definition('subagent_fork'))
    const removeTeam = scoped.ctx.get('tools').register(definition('spawn_teammate'))
    assert.deepEqual(names(root), [], 'the production registration shape is entirely scoped')
    const scope = createToolScope(root, lifetime.own, () => agent)
    scope.apply(agent)
    assert.deepEqual(names(root, agent), ['spawn_teammate'])
    root.tools.register(definition('unrelated'))
    assert.deepEqual(names(root, agent), ['spawn_teammate', 'unrelated'], 'refresh does not forget already-hidden inherited names')
    removeTeam()
    assert.deepEqual(names(root, agent), ['subagent', 'subagent_fork', 'unrelated'], 'team removal restores the preset spawners')
  } finally {
    lifetime.dispose()
    await scoped.dispose()
    await presetScope.dispose()
    await root.fiber.dispose()
  }
})

await check('real created, child, background and parked agents receive restrictions before work', async () => {
  const root = new Context()
  const lifetime = owner()
  try {
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolsService, AgentRegistry]) await root.plugin(plugin)
    await root.plugin(AgentLoop, { agents: [] })
    root.tools.register(definition('create_worktree'))
    let current: ScopedAgentLike | undefined
    createToolScope(root, lifetime.own, () => current)
    const published = new Map<string, string[]>()
    root.on('agent/created', ({ agent }) => { published.set(String(agent.id), names(root, agent)) })
    const create = (id: string, preset: string, parentAgent?: import('@deepseek-ai/dsh-agent').Agent) => root.agents.create({
      sessionId: SessionId(id), meta: { agentPreset: preset },
      agentOptions: { provider: 'fixture', model: 'fixture' },
      ...(parentAgent === undefined ? {} : { parentAgent }),
    })
    const parent = await create('scope-parent', 'liangshen')
    current = parent.agent
    const child = await create('scope-child', 'liangshen', parent.agent)
    const background = await create('scope-background', 'minimal')
    const standard = await create('scope-standard', 'standard')
    current = standard.agent
    for (const id of ['scope-parent', 'scope-child', 'scope-background']) assert.deepEqual(published.get(id), [], `${id} is restricted during publication, before work is released`)
    assert.deepEqual(names(root, parent.agent), [], 'initial publication is restricted without a foreground bind')
    assert.deepEqual(names(root, child.agent), [], 'runtime child ownership does not imply scope inheritance')
    assert.deepEqual(names(root, background.agent), [], 'background dispatch needs no bind to be restricted')
    root.tools.register(definition('ask_user_question'))
    assert.deepEqual(names(root, background.agent), [], 'a late tool remains hidden while Minimal is parked')
    assert.deepEqual(names(root, standard.agent), ['ask_user_question', 'create_worktree'], 'an unrelated preset stays unchanged')
    background.agent.session.append('agent-preset/selected', { agentPreset: 'standard' })
    assert.deepEqual(names(root, background.agent), ['ask_user_question', 'create_worktree'], 'recorded recomposition refreshes a parked agent')
    await child.dispose()
    root.tools.register(definition('another_tool'))
    lifetime.dispose()
    assert.deepEqual(names(root, parent.agent), ['another_tool', 'ask_user_question', 'create_worktree'], 'owner cleanup lifts all live masks')
  } finally {
    lifetime.dispose()
    await root.fiber.dispose()
  }
})

await check('legacy assembly filtering preserves sections, tool safety and unrelated fields', () => {
  type Assembly = { sections: { name: string }[]; tools: { name: string }[]; marker: object }
  const filterPreset = (presets as unknown as { filterMinimalPresetTools?: (assembly: Assembly, preset: string) => Assembly }).filterMinimalPresetTools
  const filterTeam = (teams as unknown as { filterTeamReplacedTools?: (assembly: Assembly) => Assembly }).filterTeamReplacedTools
  assert.equal(typeof filterPreset, 'function', 'old hosts retain the final assembly tool seam')
  assert.equal(typeof filterTeam, 'function', 'old team assemblies retain their own seam')
  let legacyListeners = 0
  const oldHost = {
    get: () => ({ restrict() { throw new Error('old registry must retain the assembly path') } }),
    on() { legacyListeners++; return () => undefined },
  } as unknown as Context
  const lifetime = owner()
  const legacyScope = createToolScope(oldHost, lifetime.own, () => undefined)
  legacyScope.apply({ ctx: oldHost, session: {} })
  assert.equal(legacyListeners, 0, 'a legacy registry installs no modern lifecycle listeners')
  lifetime.dispose()
  const marker = {}
  const assembly: Assembly = {
    sections: [{ name: 'tool:bash' }, { name: 'tool:session-query' }], marker,
    tools: ['bash', 'ask_user_question', 'create_worktree', 'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read'].map(name => ({ name })),
  }
  const minimal = filterPreset!(assembly, 'minimal')
  assert.deepEqual(minimal.tools.map(tool => tool.name), ['bash'])
  assert.deepEqual(minimal.sections, [{ name: 'tool:bash' }])
  assert.equal(minimal.marker, marker)
  assert.equal(assembly.tools.length, 8, 'the source assembly is not mutated')
  assert.equal(filterPreset!(assembly, 'standard'), assembly)
  assert.deepEqual(filterPreset!(assembly, 'liangshen').tools.map(tool => tool.name), assembly.tools.map(tool => tool.name).filter(name => name !== 'create_worktree'))
  const teamAssembly = { ...assembly, tools: ['bash', 'subagent', 'subagent_fork', 'spawn_teammate'].map(name => ({ name })) }
  assert.deepEqual(filterTeam!(teamAssembly).tools.map(tool => tool.name), ['bash', 'spawn_teammate'])
})

if (failures > 0) process.exitCode = 1
console.log(`tool-scope: ${8 - failures}/8 scenarios passed`)
