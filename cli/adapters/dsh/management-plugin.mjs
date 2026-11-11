/** DSH-only read adapter, mounted by the official profile loader (no UI). */
import { createSessionFork, latestTitle, titleText } from './fork.mjs'
import { ownerOf, readSessionOwners } from './mounts.mjs'

export const name = 'dst-cli-management'

const TAIL_DEFAULT = 20
const TAIL_MAX = 200
const TAIL_TEXT_MAX = 500

function service(ctx, key) {
  const value = ctx.get(key)
  if (value === undefined) throw Object.assign(new Error(`Missing service ${key}`), { code: 'CAPABILITY_UNAVAILABLE' })
  return value
}

function headerDto(record, owners) {
  const h = record.header
  const owner = ownerOf(owners, h.id)
  return {
    sessionId: h.id, cwd: h.cwd ?? null, createdAt: h.createdAt,
    ...(h.parentSession === undefined ? {} : { parentSession: h.parentSession }),
    ...(h.agentPreset === undefined ? {} : { agentPreset: h.agentPreset }),
    kind: sessionKind(h),
    ownerPid: owner === undefined ? null : owner.pid,
    persisted: record.persisted, live: record.live,
  }
}

/** One title batch over the listed page; a failing fold degrades to null titles. */
async function withTitles(query, page) {
  const titles = new Map()
  try {
    const results = await query.readTitleSnapshots(page.map(row => row.sessionId))
    for (const result of results) {
      if (result.status === 'fulfilled') titles.set(result.sessionId, titleText(result.value))
    }
  } catch {
    // Titles are a convenience: an unavailable fold must not fail the listing.
  }
  return page.map(row => ({ ...row, title: titles.get(row.sessionId) ?? null }))
}

function sessionKind(header) {
  if (header.origin === 'subagent') return 'subagent'
  if (header.isSeeded === true && header.parentSession !== undefined) return 'fork'
  return 'root'
}

function trimmedText(event) {
  // A user message carries its blocks in `content`, an assistant one in `message.content`.
  const content = event.data?.content ?? event.data?.message?.content
  if (!Array.isArray(content)) return undefined
  const text = content.filter(block => block?.type === 'text').map(block => block.text).join('')
  if (text === '') return undefined
  return text.length > TAIL_TEXT_MAX ? `${text.slice(0, TAIL_TEXT_MAX)}…` : text
}

async function describe(ctx, request) {
  const query = service(ctx, 'sessionQuery')
  const snapshot = await query.readSession(request.sessionId)
  const header = snapshot.session
  const events = snapshot.events ?? []
  const last = events.at(-1)
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  const lastTurnStart = events.findLast(event => event.type === 'turn/start')
  const owner = ownerOf(readSessionOwners(), request.sessionId)
  return {
    sessionId: header.id,
    title: await latestTitle(query, request.sessionId),
    cwd: header.cwd ?? null,
    createdAt: header.createdAt,
    parentSession: header.parentSession ?? null,
    agentPreset: header.agentPreset ?? null,
    kind: sessionKind(header),
    inheritedEventCount: snapshot.inheritedEventCount ?? 0,
    eventCount: events.length,
    lastSeq: last?.seq ?? null,
    lastEventType: last?.type ?? null,
    // Trailing events after a closed turn (title, fork marker, compaction) are
    // not work in progress: a turn is open only when its start has no end yet.
    working: lastTurnStart !== undefined && (lastTurnEnd === undefined || lastTurnStart.seq > lastTurnEnd.seq),
    lastTurnEndSeq: lastTurnEnd?.seq ?? null,
    ownerPid: owner === undefined ? null : owner.pid,
    persisted: true,
  }
}

async function tail(ctx, request) {
  const query = service(ctx, 'sessionQuery')
  const snapshot = await query.readSession(request.sessionId)
  const events = snapshot.events ?? []
  const limit = Math.min(TAIL_MAX, request.limit ?? TAIL_DEFAULT)
  const rows = events.slice(-limit).map(event => {
    const row = { seq: event.seq, type: event.type, time: event.time }
    const text = trimmedText(event)
    if (text !== undefined) row.text = text
    if (event.type === 'tool/call') row.tool = event.data?.name ?? null
    return row
  })
  return { sessionId: snapshot.session.id, cursor: events.at(-1)?.seq ?? null, returned: rows.length, rows }
}

function compatible(snapshot, cwd) {
  const h = snapshot.session
  return h.cwd === cwd && h.origin !== 'subagent' && h.parentSession === undefined
    && h.agentPreset === undefined
    && !snapshot.events.some(event => event.type === 'agent-preset/selected')
}

function markdown(snapshot) {
  const lines = [`# Session ${snapshot.session.id}`, '']
  for (const event of snapshot.events) {
    if (!['user/message', 'assistant/message'].includes(event.type)) continue
    const message = event.data?.message
    const text = message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (text) lines.push(`## ${event.type === 'user/message' ? 'User' : 'Assistant'}`, '', text, '')
  }
  return lines.join('\n')
}

/** Public service calls only. No file scanning, private format or credential values. */
export async function manage(ctx, request) {
  if (request.kind === 'session') {
    const query = service(ctx, 'sessionQuery')
    if (request.action === 'status') return describe(ctx, request)
    if (request.action === 'fork') {
      return createSessionFork({
        query,
        persistence: service(ctx, 'sessionPersistence'),
        sourceId: request.sessionId,
        title: request.title,
      })
    }
    if (request.action === 'tail') return tail(ctx, request)
    if (request.action === 'show') return query.readSession(request.sessionId)
    if (request.action === 'export') return markdown(await query.readSurface(request.sessionId))
    const rows = (await query.listSessions()).filter(row => request.all || row.header.cwd === request.cwd)
    if (request.action === 'list') {
      const owners = readSessionOwners()
      const filter = typeof request.filter === 'string' && request.filter !== '' ? request.filter.toLowerCase() : undefined
      const page = rows.map(row => headerDto(row, owners))
      const limited = request.limit ?? 50
      if (filter === undefined) {
        const sliced = page.slice(0, limited)
        return request.titles === true ? await withTitles(query, sliced) : sliced
      }
      // Отбор по названию идёт до обрезки страницы: иначе совпадение за пределами лимита
      // не найдётся, а название нужно прочитать у каждой строки списка.
      const titled = await withTitles(query, page)
      return titled.filter(row => (row.title ?? '').toLowerCase().includes(filter)).slice(0, limited)
    }
    if (request.action === 'continue') {
      // listSessions is newest-first by header; choose by latest validated activity.
      let latest
      for (const row of rows) {
        if (!row.persisted || row.live || row.header.origin === 'subagent' || row.header.parentSession !== undefined || row.header.agentPreset !== undefined) continue
        const snapshot = await query.readSession(row.header.id)
        if (!compatible(snapshot, request.cwd)) continue
        const time = snapshot.events.at(-1)?.time ?? snapshot.session.createdAt
        if (latest === undefined || time > latest.time) latest = { sessionId: row.header.id, time }
      }
      if (latest === undefined) throw Object.assign(new Error('No compatible session'), { code: 'SESSION_NOT_FOUND' })
      return { sessionId: latest.sessionId }
    }
  }
  if (request.kind === 'models') {
    const llm = service(ctx, 'llm')
    const providers = llm.listProviders().filter(provider => !request.provider || provider.id === request.provider)
    if (request.provider && providers.length === 0) throw Object.assign(new Error('Unknown provider'), { code: 'PROVIDER_NOT_FOUND' })
    const result = []
    for (const provider of providers) {
      const models = await llm.listModels(provider.id)
      result.push({ provider: provider.id, models: models.map(model => ({ id: model.id, name: model.name })) })
    }
    return result
  }
  if (request.kind === 'skills') {
    return (await service(ctx, 'skills').list({ cwd: request.cwd })).map(skill => ({
      name: skill.name, description: skill.description, source: skill.source,
      provider: skill.provider, invocation: skill.invocation,
    }))
  }
  if (request.kind === 'mcp') {
    const names = service(ctx, 'tools').schemas().map(tool => tool.name).filter(name => name.startsWith('mcp__'))
    const servers = new Map()
    for (const name of names) {
      const server = name.split('__')[1]
      const tools = servers.get(server) ?? []
      tools.push(name)
      servers.set(server, tools)
    }
    return { observation: 'registered-tools', connectionHealth: 'unavailable', servers: [...servers].map(([name, tools]) => ({ name, tools })) }
  }
  if (request.kind === 'auth') {
    const info = await service(ctx, 'credentials').describe('DEEPSEEK_API_KEY')
    return { credentialRef: 'DEEPSEEK_API_KEY', configured: info.configured === true, writable: info.writable === true, ...(typeof info.source === 'string' ? { source: info.source } : {}) }
  }
  throw Object.assign(new Error('Unsupported management action'), { code: 'CAPABILITY_UNAVAILABLE' })
}

/** Do not await loader settlement from apply: that would wait on this fiber. */
export function apply(ctx, config) {
  const run = async () => {
    await ctx.get('loader')?.await()
    const exit = service(ctx, 'appExit')
    try {
      const data = await manage(ctx, config.request)
      await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'final', data })}\n`, error => error ? reject(error) : resolve()))
      exit(0)
    } catch (error) {
      const code = error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'SESSION_NOT_FOUND'
        : ['SESSION_NOT_FOUND', 'PROVIDER_NOT_FOUND', 'CAPABILITY_UNAVAILABLE', 'SESSION_FORK_UNAVAILABLE'].includes(error.code) ? error.code : 'MANAGEMENT_FAILED'
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'error', code, message: 'DSH management operation failed' })}\n`, () => exit(1))
    }
  }
  void run().catch(() => ctx.get('appExit')?.(1))
}
