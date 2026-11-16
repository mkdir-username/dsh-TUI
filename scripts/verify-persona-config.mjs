/**
 * The deployment persona reaches the effective system prompt of the installed
 * host cohort. `dsh-system-prompt` renamed its config slot at 0.1.3-alpha.2
 * (`persona` → `personaPrefix`); the composition supplies both keys because
 * each schema keeps the key it does not know. This gate proves the effect on
 * a real 0.2.2 AgentLoop request, and records the trap: the legacy key alone
 * is silently dropped, not rejected.
 *
 * No network, credentials or user state. Run after install:
 *   node --import tsx/esm scripts/verify-persona-config.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-persona-'))
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_TUI_LANG = 'en'

const [
  { Context }, { default: AgentRegistry }, { default: AgentLoop },
  { default: LlmRuntime, LlmAdapter, createUserMessage, ReasoningEffortId },
  { default: SessionStore, SessionId }, { default: SessionProjectionRegistry },
  JsonlModule, { default: SystemPrompt }, { default: ToolRuntime }, NativeExecutor,
] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-agent-loop'),
  import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-session-persistence-jsonl'), import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-tool-executor-native'),
])
const JsonlPersistence = 'default' in JsonlModule ? JsonlModule.default : JsonlModule
const PERSONA = 'PERSONA_MARKER_7b1c'

/** One real turn with the given system-prompt config; returns the model-facing prompt. */
async function promptFor(label, config) {
  const ctx = new Context()
  const requests = []
  class OfflineAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return {
        provider, id: model, name: model,
        context: { contextWindow: 32000 },
        reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'low' }] },
      }
    }
    async listModels(provider) { return [await this.resolveModel(provider, 'fixture')] }
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'ok' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, ToolRuntime, NativeExecutor, AgentRegistry]) await ctx.plugin(plugin)
  await ctx.plugin(SystemPrompt, config)
  await ctx.plugin(JsonlPersistence, { root: join(root, label, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['fixture'], new OfflineAdapter())
  const handle = await ctx.agents.create({
    sessionId: SessionId(`persona-${label}`),
    meta: { cwd: root },
    agentOptions: { provider: 'fixture', model: 'fixture' },
  })
  handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ping' }] }))
  await handle.agent.whenIdle()
  await ctx.fiber.dispose()
  assert.equal(requests.length, 1, `${label}: one offline request`)
  return requests[0].messages
    .filter(message => message.role === 'system')
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

let failures = 0
const check = async (name, run) => {
  try { await run(); console.log(`PASS ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error instanceof Error ? error.message : String(error)}`) }
}

await check('both keys put the persona into the effective prompt', async () => {
  const prompt = await promptFor('both', { personaPrefix: PERSONA, persona: PERSONA })
  assert.ok(prompt.includes(PERSONA), 'persona text missing from the model-facing system prompt')
})

await check('the current key alone still works', async () => {
  const prompt = await promptFor('prefix', { personaPrefix: PERSONA })
  assert.ok(prompt.includes(PERSONA))
})

await check('the legacy key alone is silently dropped by the installed schema', async () => {
  const prompt = await promptFor('legacy', { persona: PERSONA })
  assert.ok(!prompt.includes(PERSONA), 'legacy-only config unexpectedly reached the prompt; the dual-key composition may be unnecessary')
})

await check('the composition expression supplies both keys and preserves an empty override', () => {
  const url = new URL('../cordis.patch.yml', import.meta.url)
  const lines = readFileSync(url, 'utf8').split('\n')
  const row = lines.findIndex(line => line === '- id: system-prompt')
  assert.notEqual(row, -1, 'system-prompt row not found in cordis.patch.yml')
  const header = lines.findIndex((line, index) => index > row && line.trim() === 'config: !!js >-')
  assert.notEqual(header, -1, 'system-prompt config expression not found')
  const body = []
  for (const line of lines.slice(header + 1)) {
    if (!/^ {4}/u.test(line)) break
    body.push(line.slice(4))
  }
  const expression = body.join('\n').trim()
  const realProcess = process
  for (const [env, expected] of [[undefined, 'You are a coding agent.'], ['', ''], ['custom text', 'custom text']]) {
    const mocked = {
      env: env === undefined ? {} : { DSH_TUI_PERSONA: env },
      getBuiltinModule: name => realProcess.getBuiltinModule(name),
    }
    const value = new Function('process', 'ctx', `return (${expression})`)(mocked, { baseUrl: url.href })
    assert.equal(value.personaPrefix, expected, `personaPrefix for env=${JSON.stringify(env)}`)
    assert.equal(value.persona, expected, `persona for env=${JSON.stringify(env)}`)
  }
})

console.log(`persona-config: ${4 - failures}/4 checks passed`)
if (failures > 0) process.exitCode = 1
