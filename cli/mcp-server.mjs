/**
 * Minimal MCP server (JSON-RPC 2.0 over stdio) exposing the session API.
 *
 * Deliberately thin: every tool call becomes an argv array and travels through
 * the SAME `parse` → `execute` path the `dst` binary uses, so tool semantics,
 * exit codes and error codes cannot drift from the CLI. stdout carries protocol
 * frames only; diagnostics belong to stderr.
 */
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { parse } from './args.mjs'
import { execute } from './engine.mjs'
import { createDshAdapter } from './adapters/dsh/index.mjs'
import { findTool, TOOLS } from './mcp-tools.mjs'

const SERVER_NAME = 'dsh-sessions'
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const DEFAULT_TIMEOUT_MS = 120_000

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
})()

function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Collected stdout/stderr of one CLI invocation. */
function sink() {
  let text = ''
  return {
    write(chunk, callback) {
      text += chunk
      callback?.()
      return true
    },
    text: () => text,
  }
}

/**
 * Run one CLI request in-process and return its parsed `result` envelope.
 * @param argv - CLI argv for the request.
 * @param cwd - working directory the grammar resolves against.
 * @param signal - cancellation for the whole invocation.
 */
export async function runArgv(argv, cwd, signal) {
  const request = { ...parse(argv, cwd), output: 'json' }
  const stdout = sink()
  const stderr = sink()
  await execute(request, createDshAdapter(), { stdin: Readable.from([]), stdout, stderr }, signal ?? new AbortController().signal)
  const text = stdout.text().trim()
  if (text === '') throw coded('EMPTY_RESULT', stderr.text().trim() || 'dst produced no result')
  return JSON.parse(text)
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function toolResult(id, text, isError) {
  return ok(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) })
}

function negotiate(params) {
  const requested = params?.protocolVersion
  return typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]
}

/**
 * Build the server. `run` is injectable so protocol tests need no subprocess.
 * @param options.run - `(argv, cwd, signal) => Promise<parsed result>`.
 * @param options.cwd - default working directory for tools.
 * @param options.timeoutMs - per-call deadline.
 */
export function createServer({ run = runArgv, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function callTool(message) {
    const id = message.id ?? null
    const params = message.params ?? {}
    let tool
    try {
      tool = findTool(params.name)
    } catch (error) {
      return failure(id, -32602, error.message)
    }
    let argv
    let toolCwd
    try {
      argv = tool.argv(params.arguments ?? {})
      toolCwd = tool.cwd?.(params.arguments ?? {}) ?? cwd
    } catch (error) {
      return toolResult(id, `${error.code ?? 'INVALID_ARGUMENT'}: ${error.message}`, true)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(coded('TIMEOUT', `tool "${tool.name}" exceeded ${timeoutMs} ms`)), timeoutMs)
    try {
      const payload = await run(argv, toolCwd, controller.signal)
      if (payload?.ok === false) return toolResult(id, `${payload.error?.code ?? 'OPERATION_FAILED'}: ${payload.error?.message ?? 'operation failed'}`, true)
      const data = payload?.data === undefined ? payload : payload.data
      return toolResult(id, JSON.stringify(data), false)
    } catch (error) {
      return toolResult(id, `${error.code ?? 'TOOL_FAILED'}: ${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * Answer one protocol line.
     * @param line - one JSON-RPC message.
     * @returns the response object, or `null` for a notification.
     */
    async handle(line) {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return failure(null, -32700, 'Parse error')
      }
      const id = message?.id ?? null
      try {
        switch (message?.method) {
          case 'initialize':
            return ok(id, {
              protocolVersion: negotiate(message.params),
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: SERVER_NAME, version: VERSION },
            })
          case 'notifications/initialized':
          case 'notifications/cancelled':
            return null
          case 'ping':
            return ok(id, {})
          case 'tools/list':
            return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
          case 'tools/call':
            return await callTool(message)
          default:
            return failure(id, -32601, `Unknown method ${String(message?.method)}`)
        }
      } catch (error) {
        return failure(id, -32603, error instanceof Error ? error.message : String(error))
      }
    },
  }
}
