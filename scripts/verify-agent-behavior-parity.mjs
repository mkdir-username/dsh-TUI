/**
 * Keyless differential tests: the pinned official loop versus the same loop
 * through the TUI's production preset, scope, and request adapters. The model
 * is scripted; the registry, executor, policy waterfall, and session are real.
 * This checks integration behavior, not live-model task-solving quality.
 * Run: node --import tsx/esm scripts/verify-agent-behavior-parity.mjs
 * Optional: --json <path> writes the measured scenario results.
 * Upstream sources and the exact runtime cohort: upstream-behavior-baseline.json.
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolsService from '@deepseek-ai/dsh-tools'
import { registerModelInputValidation } from '../src/dsh-adapter/model-input-validation.js'
import { composePreset, filterMinimalPresetTools, runningPresetOf } from '../src/dsh-adapter/presets.js'
import { filterTeamReplacedTools } from '../src/dsh-adapter/team-mode.js'
import { createToolScope } from '../src/dsh-adapter/tool-scope.js'

const require = createRequire(import.meta.url)
const baseline = JSON.parse(readFileSync(new URL('./upstream-behavior-baseline.json', import.meta.url), 'utf8'))
for (const name of baseline.packages) {
  assert.equal(require(`${name}/package.json`).version, baseline.version,
    `${name}: behavior oracle changed; review the source pin and fixtures before updating it`)
}
if (process.env.DSH_HARNESS_SOURCE_ROOT) {
  for (const [path, expected] of Object.entries(baseline.sources)) {
    assert.equal(createHash('sha256').update(readFileSync(resolve(process.env.DSH_HARNESS_SOURCE_ROOT, path))).digest('hex'), expected,
      `${path}: upstream source changed; review the behavior baseline before updating it`)
  }
}

const hash = value => createHash('sha256').update(value).digest('hex')
const textBlocks = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('')
const toolsIn = request => request.messages.filter(message => message.role === 'tool')
const promptIn = request => request.messages.filter(message => message.role === 'system').map(message => textBlocks(message.content)).join('\n\n')
const call = (name, args = {}) => ({ name, args })
const scenarios = [
  { id: 'read-edit-verify', steps: [[call('inspect_file')], [call('apply_edit')], [call('run_tests')]], final: 'verified', changed: true },
  { id: 'parallel-reads-write-barrier', steps: [[call('inspect_file', { label: 'a' }), call('inspect_file', { label: 'b' }), call('apply_edit')], [call('run_tests')]], final: 'verified', changed: true },
  { id: 'tool-error-recovery', steps: [[call('inspect_file', { fail: true })], [call('inspect_file')]], final: 'recovered', changed: false, errors: 1 },
  { id: 'permission-denial', steps: [[call('apply_edit')]], final: 'denied', changed: false, errors: 1, deny: true },
]

function response(calls, step, final) {
  if (calls === undefined) return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: final },
    { type: 'block-end', index: 0, block: { type: 'text', text: final } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return [
    ...calls.flatMap(({ name, args }, index) => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(`call-${step}-${index}`), name, arguments: JSON.stringify(args) } },
    ]),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScenarioAdapter extends LlmAdapter {
  requests = []
  constructor(scenario) { super(); this.scenario = scenario }
  async *stream(request) {
    const step = this.requests.length
    assert.ok(step <= this.scenario.steps.length, 'no unplanned retries or extra model steps')
    assert.equal(request.provider, 'custom-fixture', 'custom provider route survives composition')
    assert.equal(request.model, 'custom-model', 'custom model id survives composition')
    assert.ok(Object.isFrozen(request), 'the upstream loop still freezes its request')
    assert.equal(toolsIn(request).length, this.scenario.steps.slice(0, step).flat().length,
      'the next request contains every previous tool result exactly once')
    if (step === this.scenario.steps.length) {
      assert.equal(toolsIn(request).filter(message => message.isError).length, this.scenario.errors ?? 0)
      if (this.scenario.changed) assert.match(textBlocks(toolsIn(request).at(-1).content), /tests passed/u)
    }
    for (const item of this.scenario.steps[step] ?? []) {
      assert.ok(request.tools.some(tool => tool.name === item.name), 'the requested tool is actually advertised')
    }
    this.requests.push(request)
    yield* response(this.scenario.steps[step], step, this.scenario.final)
  }
}

function modelInput(request) {
  return {
    provider: request.provider, model: request.model, system: request.system,
    tools: request.tools,
    messages: request.messages.map(({ role, content, toolCallId, isError }) => ({ role, content, toolCallId, isError })),
  }
}

async function runScenario(scenario, adapted, reversed = false) {
  const ctx = new Context()
  const adapter = new ScenarioAdapter(scenario)
  let file = 'before'
  let agent
  const timeline = []
  const readsReady = Promise.withResolvers()
  let readers = 0
  try {
    await ctx.plugin(Loader)
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry]) await ctx.plugin(plugin)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
    for (const plugin of [ToolsService, NativeToolExecutor, AgentRegistry]) await ctx.plugin(plugin)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresetRegistry, { default: 'parity' })
    ctx.llm.registerAdapter(['custom-fixture'], adapter)

    const definitions = [
      ['inspect_file', async (args, execution) => {
        if (args.fail) throw new Error('fixture read failed')
        const label = args.label ?? 'read'
        timeline.push(`start:${label}`)
        if (scenario.id === 'parallel-reads-write-barrier') {
          if (++readers === 2) readsReady.resolve()
          await new Promise((resolve, reject) => {
            const abort = () => reject(execution.signal.reason)
            execution.signal.addEventListener('abort', abort, { once: true })
            readsReady.promise.then(() => { execution.signal.removeEventListener('abort', abort); resolve() })
            if (execution.signal.aborted) abort()
          })
        }
        timeline.push(`end:${label}`)
        return { text: file }
      }, true],
      ['apply_edit', async () => { timeline.push('write'); file = 'after'; return { text: 'edited' } }, false],
      ['run_tests', async () => ({ text: file === 'after' ? 'tests passed' : 'tests failed' }), false],
    ]
    const rows = [
      { name: 'instruction:zeta', order: 10, text: 'Use tools to inspect {{project}}.' },
      { name: 'instruction:alpha', order: 10, text: 'Verify edits before answering.' },
    ]
    ctx.loader.builtins['parity-contributions'] = {
      inject: ['systemPrompt', 'tools'],
      apply(owner) {
        owner.effect(() => owner.systemPrompt.variable('project', () => 'the fixture'))
        for (const section of reversed ? [...rows].reverse() : rows) {
          owner.effect(() => owner.systemPrompt.section(section))
        }
        for (const [name, execute, parallel] of reversed ? [...definitions].reverse() : definitions) {
          owner.effect(() => owner.tools.register({
            name, description: name, parameters: { type: 'object', properties: { label: { type: 'string' }, fail: { type: 'boolean' } } },
            output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, result) => [{ type: 'text', text: result.text }] },
            execute,
            ...(parallel ? { isConcurrencySafe: () => true } : {}),
          }))
        }
      },
    }
    const unregister = await ctx.agentPresets.register({ id: 'parity', plugins: [{ id: 'contributions', name: 'cordis:parity-contributions' }] })
    ctx.effect(() => unregister)
    if (scenario.deny) ctx.on('tools/pre-execute', (execution, next) => execution.name === 'apply_edit'
      ? { kind: 'deny', reason: 'fixture permission denied' } : next())
    if (adapted) {
      registerModelInputValidation(ctx)
      createToolScope(ctx, release => ctx.effect(() => release), () => agent)
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next()
        return filterMinimalPresetTools(filterTeamReplacedTools(assembled),
          context.agent === undefined ? undefined : runningPresetOf(context.agent.session))
      })
    }
    const resolved = adapted ? await composePreset(ctx, 'parity') : {
      agentPreset: (await ctx.agentPresets.resolve('parity')).id,
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'parity') },
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(`parity-${scenario.id}`),
      meta: { agentPreset: resolved.agentPreset }, setup: resolved.setup,
      agentOptions: { provider: 'custom-fixture', model: 'custom-model' },
    })
    agent = handle.agent
    let timeout
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: scenario.id }], source: { kind: 'user' } }))
      await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`scenario timed out: ${scenario.id}`)), 10000) }),
      ])
    } finally { clearTimeout(timeout) }
    const events = agent.session.snapshotEvents()
    assert.equal(events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'completed')
    assert.equal(file, scenario.changed ? 'after' : 'before')
    assert.equal(textBlocks(agent.session.deriveMessages().filter(message => message.role === 'assistant').at(-1).content), scenario.final)
    assert.equal(adapter.requests.length, scenario.steps.length + 1)
    assert.equal(events.filter(event => event.type === 'tool/call').length, scenario.steps.flat().length)
    assert.equal(events.filter(event => event.type === 'tool/result').length, scenario.steps.flat().length)
    const prompts = new Set(adapter.requests.map(promptIn))
    assert.equal(prompts.size, 1, 'fixed instructions produce one stable prompt across all steps')
    assert.ok(promptIn(adapter.requests[0]).indexOf('Verify edits') < promptIn(adapter.requests[0]).indexOf('Use tools'))
    if (scenario.id === 'parallel-reads-write-barrier') {
      assert.ok(timeline.indexOf('start:b') < timeline.indexOf('end:a'), 'parallel-safe reads overlap')
      assert.ok(timeline.indexOf('write') > timeline.indexOf('end:b'), 'exclusive write waits for reads')
    }
    return {
      input: adapter.requests.map(modelInput),
      metrics: { requests: adapter.requests.length, toolCalls: scenario.steps.flat().length, steps: events.filter(event => event.type === 'step/start').length, promptSha256: hash([...prompts][0]) },
    }
  } finally { await ctx.fiber.dispose() }
}

const measurements = []
for (const scenario of scenarios) {
  const reference = await runScenario(scenario, false)
  const fork = await runScenario(scenario, true)
  const permuted = await runScenario(scenario, true, true)
  assert.deepEqual(fork.input, reference.input, `${scenario.id}: model-visible trajectory matches the pinned official runtime`)
  assert.deepEqual(permuted.input, fork.input, `${scenario.id}: provider registration order cannot change the trajectory`)
  assert.deepEqual(fork.metrics, reference.metrics)
  measurements.push({ scenario: scenario.id, success: true, upstream: reference.metrics, fork: fork.metrics, extraSteps: fork.metrics.steps - reference.metrics.steps })
  console.log(`PASS ${scenario.id}: ${fork.metrics.requests} requests, ${fork.metrics.toolCalls} tool calls, 0 extra steps; prompt stable`)
}

// Real upstream prompt registries must keep their fail-loud semantics.
const promptRoot = new Context()
try {
  await promptRoot.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  promptRoot.systemPrompt.section({ name: 'unique', order: 1, text: 'hello' })
  assert.throws(() => promptRoot.systemPrompt.section({ name: 'unique', order: 1, text: 'conflict' }), /already registered/u)
  promptRoot.systemPrompt.variable('project', () => 'one')
  assert.throws(() => promptRoot.systemPrompt.variable('project', () => 'two'), /already registered/u)
  const removeUnknown = promptRoot.systemPrompt.section({ name: 'unknown', order: 2, text: '{{missing}}' })
  const unknown = await promptRoot.systemPrompt.assemble()
  assert.throws(() => renderPrompt(unknown), /unknown prompt variable/u)
  removeUnknown()
  const completeA = promptRoot.systemPrompt.section({ name: 'complete-a', order: 3, text: 'A', complete: true })
  const completeB = promptRoot.systemPrompt.section({ name: 'complete-b', order: 4, text: 'B', complete: true })
  await assert.rejects(promptRoot.systemPrompt.assemble(), /multiple complete prompt sections/u)
  completeA(); completeB()
  console.log('PASS upstream prompt conflicts: sections, variables, unknown interpolation, complete prompts')
} finally { await promptRoot.fiber.dispose() }

// Upstream permits duplicate schemas from independent prompt providers. The
// adapter deliberately strengthens that boundary before a provider is called.
const requestRoot = new Context()
try {
  await requestRoot.plugin(LlmRuntime)
  await requestRoot.plugin(SystemPrompt)
  let dispatched = 0
  class CountingAdapter extends LlmAdapter {
    async *stream() { dispatched++; yield* response(undefined, 0, 'ok') }
  }
  requestRoot.llm.registerAdapter(['custom-fixture'], new CountingAdapter())
  const schema = { name: 'ambiguous_tool', description: 'first', parameters: { type: 'object', properties: {} } }
  requestRoot.systemPrompt.tools(() => ({ schemas: [schema] }))
  requestRoot.systemPrompt.tools(() => ({ schemas: [{ ...schema, description: 'second' }] }))
  const assembly = await requestRoot.systemPrompt.assemble()
  assert.equal(assembly.tools.length, 2, 'fixture reaches the upstream ambiguity, not the tools registry duplicate guard')
  registerModelInputValidation(requestRoot)
  await assert.rejects(async () => {
    for await (const _chunk of requestRoot.llm.stream({ provider: 'custom-fixture', model: 'custom-model', messages: [], tools: assembly.tools })) { /* must not dispatch */ }
  }, /duplicate model-facing tool name "ambiguous_tool"/u)
  assert.equal(dispatched, 0)
  for await (const _chunk of requestRoot.llm.stream({ provider: 'custom-fixture', model: 'custom-model', messages: [], tools: [schema] })) { /* drain success */ }
  assert.equal(dispatched, 1, 'valid custom providers remain supported')
  console.log('PASS duplicate provider schemas rejected before dispatch; unique custom route preserved')
} finally { await requestRoot.fiber.dispose() }

const output = process.argv.indexOf('--json')
if (output !== -1) {
  assert.ok(process.argv[output + 1], '--json requires an output path')
  writeFileSync(process.argv[output + 1], `${JSON.stringify({ baseline, mode: 'scripted-model-real-runtime', measurements }, null, 2)}\n`)
}
console.log(`agent behavior parity OK (${measurements.length} scenarios × reference/adapted/permuted, pinned ${baseline.version})`)
