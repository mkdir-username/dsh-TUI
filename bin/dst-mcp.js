#!/usr/bin/env node
/**
 * `dsh-sessions` MCP server over stdio: one JSON-RPC message per line.
 * Tool calls go through the automation CLI, so this process needs no TUI.
 */
import { createInterface } from 'node:readline'
import { createServer } from '../cli/mcp-server.mjs'

const server = createServer()
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (line.trim() === '') continue
  const response = await server.handle(line)
  if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`)
}
