/** MCP surface: stdio framing plus argv mapping through the automation CLI. */
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const bin = join(root, 'bin', 'dst-mcp.js')
const fixture = fileURLToPath(new URL('./fixtures/dsh.mjs', import.meta.url))
const sandbox = await mkdtemp(join(tmpdir(), 'dst-mcp-'))
const runtime = join(sandbox, 'dsh', 'bin.mjs')
await mkdir(join(sandbox, 'dsh'))
await copyFile(fixture, runtime)
await writeFile(join(sandbox, 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', type: 'module', bin: { dsh: './bin.mjs' } }))
after(() => rm(sandbox, { recursive: true, force: true, maxRetries: 3 }))

async function session(messages) {
  const child = spawn(process.execPath, [bin], {
    cwd: root,
    env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, DSH_HOME: join(sandbox, 'home'), DSH_TUI_CLI_DSH_BIN: runtime },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdin.end(messages.map(message => JSON.stringify(message)).join('\n') + '\n')
  const exit = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve(code))
  })
  const text = stdout.trim()
  return { exit, stderr, responses: text === '' ? [] : text.split('\n').map(line => JSON.parse(line)) }
}

test('initialize and tools/list answer over stdio', async () => {
  const { exit, responses, stderr } = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ])
  assert.equal(exit, 0, stderr)
  assert.equal(responses[0].result.protocolVersion, '2025-06-18')
  assert.equal(responses[0].result.serverInfo.name, 'dsh-sessions')
  assert.deepEqual(responses[1].result.tools.map(tool => tool.name).sort(), ['session_fork', 'session_status', 'session_tail', 'sessions_list'])
})

test('tool calls return the management payload as JSON text', async () => {
  const { responses, stderr } = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sessions_list', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_fork', arguments: { sessionId: 'existing' } } },
  ])
  assert.equal(responses[1].result.isError, undefined, stderr)
  assert.match(responses[1].result.content[0].text, /existing/u)
  assert.equal(JSON.parse(responses[2].result.content[0].text).sessionId, 'session-child')
})

test('unknown methods are protocol errors, unknown tools are parameter errors', async () => {
  const { responses } = await session([
    { jsonrpc: '2.0', id: 1, method: 'nope' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'session_status', arguments: {} } },
  ])
  assert.equal(responses[0].error.code, -32601)
  assert.equal(responses[1].error.code, -32602)
  assert.equal(responses[2].result.isError, true)
  assert.match(responses[2].result.content[0].text, /INVALID_ARGUMENT/u)
})

test('a notification produces no response line', async () => {
  const { responses } = await session([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 7, method: 'ping' },
  ])
  assert.equal(responses.length, 1)
  assert.equal(responses[0].id, 7)
})
