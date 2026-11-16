/** Reject ambiguous model-facing declarations before provider dispatch. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Tool registry names are unique within a scope, but independent prompt tool
 * providers can contribute the same name. Reject that composition instead of
 * relying on a provider's first/last-wins behavior. Does not rewrite requests,
 * reorder tools, or restrict custom provider/model routes.
 *
 * @param ctx - DSH runtime context; Cordis owns the listener lifetime.
 */
export function registerModelInputValidation(ctx: Context): void {
  ctx.on('llm/stream', (request, next) => {
    const names = new Set<string>()
    for (const tool of request.tools ?? []) {
      if (names.has(tool.name)) {
        throw new LlmError(
          `dsh-tui: duplicate model-facing tool name ${JSON.stringify(tool.name)}; ` +
          'remove the conflicting tool or prompt provider before retrying',
          'INVALID_REQUEST',
        )
      }
      names.add(tool.name)
    }
    return next()
  })
}
