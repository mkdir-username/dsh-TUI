/**
 * Fork a STORED session without materializing it as a live Session.
 *
 * The runtime forks from a live source (`ctx.sessions.fork`), and the agent
 * factory persists through its own write handle. A short-lived automation
 * process has neither: it reads a validated snapshot (`sessionQuery.readSession`)
 * and writes the child with the storage handle (`sessionPersistence.create`).
 * `cli/` may not import `@deepseek-ai/*` (`cli/test/boundary.test.mjs`), so the
 * seed is assembled here by the storage contract, not by `buildForkSeed`:
 *
 *   events[0..boundary]                 copied prefix (closed turn)
 *   session/end-seed {inherited: true}  at seq boundary + 1 == inheritedEventCount
 *   session/title                       optional, child-owned, at boundary + 2
 *
 * Cutting only at a closed turn keeps the prefix self-contained: an open turn
 * would need synthetic tool results and turn closers. The child is re-read after
 * the write, so a format the runtime rejects surfaces as an error instead of a
 * corrupt log.
 */
import { randomUUID } from 'node:crypto'

function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

/** Title text of a `SessionTitleObservation`: `title` is the folded snapshot, itself carrying the text. */
export function titleText(observation) {
  const snapshot = observation?.title
  const text = typeof snapshot === 'string' ? snapshot : snapshot?.title
  return typeof text === 'string' && text !== '' ? text : null
}

/** Latest title text for a session, or `null`; a failing fold is not an error. */
export async function latestTitle(query, sessionId) {
  try {
    const results = await query.readTitleSnapshots([sessionId])
    const result = results.find(entry => entry.sessionId === sessionId && entry.status === 'fulfilled')
    return titleText(result?.value)
  } catch {
    return null
  }
}

/**
 * Inclusive seq of the last event that still belongs to a CLOSED turn.
 *
 * The last `turn/end` is the cut, extended over the trailing events that are
 * not the beginning of another turn's work (step bookkeeping, hooks). The first
 * `turn/start`, appended `user/message` or inbox splice ends the extension.
 * @param events - contiguous session log.
 * @returns the boundary seq, or `undefined` when the session has no closed turn.
 */
export function latestCompletedPrefixBoundary(events) {
  const lastTurnEnd = events.findLast(event => event.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start' || (next.type === 'user/message' && next.surfaceOp === 'append') || next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/**
 * Build the child header and log for one source snapshot.
 * @param options.snapshot - `readSession` result: source header plus validated events.
 * @param options.childId - child session id.
 * @param options.title - child title; omitted means a title event is not written.
 * @param options.now - timestamp for the header, marker and title event.
 * @returns the artifact, or `undefined` when the source has no closed turn.
 */
export function buildForkArtifact({ snapshot, childId, title, now }) {
  const events = snapshot.events ?? []
  const boundary = latestCompletedPrefixBoundary(events)
  if (boundary === undefined) return undefined
  const header = {
    ...snapshot.session,
    id: childId,
    createdAt: now,
    parentSession: snapshot.session.id,
    isSeeded: true,
    delegationDepth: 0,
  }
  // A subagent source must not make the child a subagent.
  delete header.origin
  const seed = [
    ...events.slice(0, boundary + 1),
    { type: 'session/end-seed', seq: boundary + 1, time: now, data: { inherited: true } },
  ]
  if (title !== undefined) seed.push({ type: 'session/title', seq: boundary + 2, time: now, data: { title, messageSeqs: [], source: { kind: 'user' } } })
  return { header, events: seed, boundary, inheritedEventCount: boundary + 1 }
}

/**
 * Create a stored fork of `sourceId` and verify it, returning the child facts.
 * @param options.query - `sessionQuery` service (read side).
 * @param options.persistence - `sessionPersistence` service (write side).
 * @param options.sourceId - session to copy.
 * @param options.title - explicit title; omitted derives `Fork: <source title>`.
 * @param options.now - injectable clock for tests.
 */
export async function createSessionFork({ query, persistence, sourceId, title, now = Date.now() }) {
  const snapshot = await query.readSession(sourceId)
  const childTitle = title ?? `Fork: ${(await latestTitle(query, sourceId)) ?? sourceId.slice(0, 8)}`
  const childId = `session-${randomUUID()}`
  const artifact = buildForkArtifact({ snapshot, childId, title: childTitle, now })
  if (artifact === undefined) throw coded('SESSION_FORK_UNAVAILABLE', `session "${sourceId}" has no completed turn to fork from`)
  const handle = await persistence.create(artifact.header, { inheritedEventCount: artifact.inheritedEventCount })
  try {
    await handle.append(artifact.events)
    await handle.flush()
  } finally {
    await handle.close()
  }
  const verify = await query.readSession(childId)
  if (verify.inheritedEventCount !== artifact.inheritedEventCount || verify.events.length !== artifact.events.length) {
    throw coded('CAPABILITY_UNAVAILABLE', `forked session "${childId}" failed verification; remove it before resuming`)
  }
  return {
    sessionId: childId,
    sourceSessionId: sourceId,
    boundary: artifact.boundary,
    inheritedEventCount: artifact.inheritedEventCount,
    events: artifact.events.length,
    title: childTitle,
  }
}
