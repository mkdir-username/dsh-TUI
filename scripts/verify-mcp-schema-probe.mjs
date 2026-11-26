/**
 * Can a long MCP call be moved to the background by returning a synthetic
 * early ack? The bridge adapts an upstream tool into the tool runtime
 * (`createMcpToolDefinition` in @deepseek-ai/dsh-mcp-client): the call is
 * awaited inline, and the runtime then validates the returned value against
 * `tool.output.schema` (`dsh-tools/lib/pipeline.js`, `createSuccessResult`).
 * When the server declares an `outputSchema`, that wrapper requires
 * `structuredContent` to satisfy it — an ack has no such result to show.
 *
 * This probe runs the real validator from the validated host line on the exact
 * wrapper shape the bridge builds, so the verdict is about behaviour, not about
 * a hand-written imitation of it.
 *
 * Run: node --import tsx/esm scripts/verify-mcp-schema-probe.mjs
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const tools = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href)

/** The wrapper `createOutput(rawName, structuredSchema)` builds in the bridge. */
function mcpOutputSchema(declared) {
  return {
    type: 'object',
    properties: {
      content: { type: 'array', items: {} },
      structuredContent: declared ?? {},
    },
    required: declared === undefined ? ['content'] : ['content', 'structuredContent'],
    additionalProperties: false,
  }
}

/** What a parked call would have to return: the ack, and nothing that answers the call. */
const earlyAck = {
  content: [{ type: 'text', text: 'moved to the background; the result arrives with the completion notice' }],
  structuredContent: { status: 'backgrounded' },
}

const declared = {
  type: 'object',
  properties: { result: { type: 'string' } },
  required: ['result'],
  additionalProperties: false,
}

const withSchema = tools.validateJsonSchemaValue(mcpOutputSchema(declared), earlyAck, 'value')
const withoutSchema = tools.validateJsonSchemaValue(mcpOutputSchema(undefined), earlyAck, 'value')

console.log(withSchema.length === 0 ? 'SCHEMA_ACCEPTS_EARLY_ACK' : 'SCHEMA_REJECTS_EARLY_ACK')
console.log(`  declared outputSchema, ack without the result: ${withSchema.length} violation(s)`)
for (const violation of withSchema) console.log(`    - ${violation}`)
console.log(`  no outputSchema, ack with content only: ${withoutSchema.length} violation(s)`)
for (const violation of withoutSchema) console.log(`    - ${violation}`)

assert.equal(withSchema.length > 0, true, 'a declared outputSchema must not accept an ack that omits its result')
assert.equal(withoutSchema.length, 0, 'without an outputSchema the envelope itself accepts a content-only value')
console.log('\nAll MCP schema probe checks passed.')
