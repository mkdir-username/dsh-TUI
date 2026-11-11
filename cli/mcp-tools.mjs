/**
 * MCP tool table over the automation CLI.
 *
 * Each tool is a thin argv builder: the server runs the SAME grammar a shell
 * user would (`cli/args.mjs` → `cli/engine.mjs`), so an operation is
 * implemented once and behaves identically in both surfaces. Tool results are
 * the `final.data` payload of the management protocol, serialized as text.
 */

function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

function requiredId(input, name) {
  const value = input.sessionId
  if (typeof value !== 'string' || value === '') throw coded('INVALID_ARGUMENT', `${name} requires a sessionId`)
  return value
}

function optionalLimit(input, fallback) {
  if (input.limit === undefined) return ['--limit', String(fallback)]
  if (!Number.isInteger(input.limit) || input.limit < 1) throw coded('INVALID_ARGUMENT', 'limit must be a positive integer')
  return ['--limit', String(input.limit)]
}

const sessionIdSchema = { type: 'string', minLength: 1, description: 'DSH session id, for example "session-1a2b…".' }

export const TOOLS = [
  {
    name: 'sessions_list',
    description: 'List DSH sessions in one working directory (newest first). Each row carries the session id, cwd, kind (root|fork|subagent), ownerPid of the live TUI that holds it, and optionally its title.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Directory whose sessions to list; defaults to the server working directory.' },
        all: { type: 'boolean', description: 'List every working directory instead of one cwd.' },
        titles: { type: 'boolean', description: 'Also read each title. Reads every listed session log, so it is slower.' },
        filter: { type: 'string', description: 'Keep only sessions whose title contains this text (case-insensitive). Titles are read for the whole list before the limit applies, so a match beyond the limit is still found.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum rows, default 50.' },
      },
      additionalProperties: false,
    },
    argv(input) {
      return [
        'session', 'list', '--json',
        ...(input.all === true ? ['--all'] : []),
        ...(input.titles === true ? ['--titles'] : []),
        ...(typeof input.filter === 'string' && input.filter !== '' ? ['--filter', input.filter] : []),
        ...(input.limit === undefined ? [] : optionalLimit(input, 50)),
      ]
    },
    cwd: input => (typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined),
  },
  {
    name: 'session_status',
    description: 'Describe one DSH session: title, cwd, kind, preset, inherited event count, event count, last event, whether a turn is running, and the pid of the live process holding it.',
    inputSchema: { type: 'object', properties: { sessionId: sessionIdSchema }, required: ['sessionId'], additionalProperties: false },
    argv(input) {
      return ['session', 'status', requiredId(input, 'session_status'), '--json']
    },
  },
  {
    name: 'session_tail',
    description: 'Return the most recent events of one DSH session with trimmed text (500 characters) and tool names. Use it to see what another session is doing without pulling its whole log.',
    inputSchema: {
      type: 'object',
      properties: { sessionId: sessionIdSchema, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Rows to return, default 20.' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    argv(input) {
      return ['session', 'tail', requiredId(input, 'session_tail'), '--json', ...optionalLimit(input, 20)]
    },
  },
  {
    name: 'session_prompt',
    description: 'Run one headless turn in an existing DSH session and return its answer. Refused when another process holds the session (SESSION_OCCUPIED) or when the session carries an agent preset the headless runner cannot compose (SESSION_PRESET_UNSUPPORTED); fork such a session and continue it in the TUI instead.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: sessionIdSchema,
        prompt: { type: 'string', minLength: 1, description: 'Task text for that session.' },
        cwd: { type: 'string', description: 'Defaults to the cwd recorded in the session header.' },
      },
      required: ['sessionId', 'prompt'],
      additionalProperties: false,
    },
    argv(input) {
      const prompt = input.prompt
      if (typeof prompt !== 'string' || prompt.trim() === '') throw coded('INVALID_ARGUMENT', 'session_prompt requires a prompt')
      return ['run', '--session-id', requiredId(input, 'session_prompt'), '--json', prompt]
    },
  },
  {
    name: 'session_fork',
    description: 'Copy a DSH session up to its last completed turn into a new session (parentSession = source). The source log is never modified. The child keeps the source agent preset, so it resumes in the TUI; it is not runnable by the headless runner.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: sessionIdSchema,
        title: { type: 'string', description: 'Child title; defaults to "Fork: <source title>".' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    argv(input) {
      const title = input.title
      if (title !== undefined && (typeof title !== 'string' || title === '')) throw coded('INVALID_ARGUMENT', 'title must be a non-empty string')
      return ['session', 'fork', requiredId(input, 'session_fork'), '--json', ...(title === undefined ? [] : ['--title', title])]
    },
  },
]

/** Resolve one tool by name. */
export function findTool(name) {
  const tool = TOOLS.find(entry => entry.name === name)
  if (tool === undefined) throw coded('UNKNOWN_TOOL', `Unknown tool "${name}"`)
  return tool
}
