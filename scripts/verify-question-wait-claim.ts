/**
 * Questionnaire timed wait: the host counts an `ask_user_question` deadline
 * down only while no answer UI holds a claim (`attachWait`), and the panel is
 * that UI. This regression pins both halves of the fix:
 *
 *  1. the neutral store publishes the ask that is on screen (queued asks stay
 *     silent, index moves inside one ask stay silent) and every touch the user
 *     makes on it;
 *  2. the DSH binding turns that into a claim over the real `userQuestions`
 *     service — typing past the deadline keeps the question answerable, a real
 *     idle window still settles it as `{pending: true}`, an answer while
 *     claimed wins, an indefinite ask stays untouched, and a host without
 *     `attachWait` degrades to its plain deadline.
 *
 * Section 2 runs against the installed `@deepseek-ai/dsh-user-questions`, not a
 * double: the claim/pause/release contract is the host's, and a fake would only
 * prove our own model of it.
 *
 * Run: node --import tsx/esm scripts/verify-question-wait-claim.ts
 */

import assert from 'node:assert/strict'
import { QuestionStore } from '../src/dsh-adapter/questions.js'

// ── 1. The store publishes the on-screen ask and every touch ───────────────
const seen: string[] = []
const observer = {
  active: (request: { questions: readonly unknown[] } | undefined): void => {
    seen.push(request === undefined ? 'none' : `active:${request.questions.length}`)
  },
  touch: (): void => { seen.push('touch') },
}
const store = new QuestionStore()
store.setActivityObserver(observer)
assert.deepEqual(seen, [], 'installing the observer on an idle store publishes nothing')

const first = store.ask({ questions: [{ id: 'q1', question: 'Q1', options: [{ label: 'A' }] }] })
const second = store.ask({ questions: [{ id: 'q2', question: 'Q2' }] })
await Promise.resolve()
assert.deepEqual(seen, ['active:1'], 'only the ask on screen is published, the queued one is not')

store.noteActivity()
assert.equal(seen.at(-1), 'touch', 'a touch reaches the observer')

store.answerCurrent({ selected: ['A'] })
assert.equal(seen.at(-1), 'active:1', 'answering publishes the next ask on screen')

store.cancelCurrent()
assert.equal(seen.at(-1), 'none', 'cancelling the last ask publishes no ask')

assert.deepEqual(await first, { answers: [{ id: 'q1', selected: ['A'] }] })
await second.catch(() => undefined)

// A throwing observer must never wedge the question queue.
const throwing = new QuestionStore()
throwing.setActivityObserver({ active: () => { throw new Error('observer blew up') }, touch: () => { throw new Error('observer blew up') } })
const guarded = throwing.ask({ questions: [{ id: 'q3', question: 'Q3' }] })
assert.doesNotThrow(() => throwing.noteActivity(), 'a throwing touch is swallowed')
throwing.answerCurrent({ selected: [], custom: 'x' })
assert.deepEqual(await guarded, { answers: [{ id: 'q3', selected: [], custom: 'x' }] },
  'the answer still settles after the observer threw')
throwing.setActivityObserver(undefined)
console.log('PASS store publishes the on-screen ask and every touch')

// ── 2. Claim against the real host service ─────────────────────────────────
const { Context } = await import('@deepseek-ai/cordis')
const { default: UserQuestionService } = await import('@deepseek-ai/dsh-user-questions')
const { prepareQuestionAnswerer } = await import('../src/dsh-adapter/questions-answerer.js')
const { createQuestionWaitClaim } = await import('../src/dsh-adapter/questionWait.js')
const { settled, settle } = await import('./lib/term-test.mjs')

type Harness = {
  /** The exact live agent the host registry hands back: `askTimed` checks identity. */
  readonly agent: { id: string; session: { header: { origin: string } } }
  readonly service: InstanceType<typeof UserQuestionService>
  readonly store: QuestionStore
  readonly claims: string[]
  readonly claim: NonNullable<ReturnType<typeof createQuestionWaitClaim>>
}

/** The live host service, the TUI store as its answerer, and a claim spying on attachWait. */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  const agent = {
    id: 'agent-1',
    session: { header: { origin: 'root' } },
    steer(): void {},
    inbox: { nextTurn: [], nextStep: [] },
  }
  ctx.provide('agents')
  ;(ctx as unknown as { agents: unknown }).agents = { get: (id: string) => (id === agent.id ? agent : undefined) }
  const service = new UserQuestionService(ctx)
  // The live composition hands both the tool and this binding the traceable
  // proxy from `ctx.get`, not the raw instance: the claim has to work through it.
  const host = ctx.get('userQuestions') as typeof service
  if (host !== service) assert.equal(typeof host.attachWait, 'function', 'the proxy exposes attachWait')
  const store = new QuestionStore()
  const registration = prepareQuestionAnswerer(ctx as never, host, store)
  if (registration.kind !== 'waterfall') throw new Error('the regression needs the waterfall answerer')
  registration.register({ agentId: agent.id })
  const claims: string[] = []
  const spy = {
    attachWait: (agent: unknown, callId: string, signal: AbortSignal) => {
      claims.push(callId)
      return host.attachWait(agent as never, callId as never, signal)
    },
  }
  const claim = createQuestionWaitClaim(spy, { log: () => {} })
  if (claim === undefined) throw new Error('the host exposes attachWait, so a claim must exist')
  store.setActivityObserver(claim)
  return { agent, service: host as never, store, claims, claim } as Harness
}

const question = { id: 'q1', question: 'Which colour?', options: [{ label: 'Red' }] }

// (main) Typing past the deadline keeps the ask; stopping settles it as pending.
{
  const h = await harness()
  let outcome: unknown
  const answer = h.service.askTimed({ questions: [question], agent: h.agent } as never, 'call-1', 120)
  void answer.then(result => { outcome = result }, error => { outcome = error })
  await settle(() => h.store.getSnapshot() !== null)
  assert.deepEqual(h.claims, ['call-1'], 'exactly one claim per timed ask')

  const until = Date.now() + 260
  const typing = setInterval(() => h.store.noteActivity(), 40)
  await settle(() => Date.now() >= until, { stepMs: 20 })
  clearInterval(typing)
  assert.equal(outcome, undefined, 'typing past the deadline keeps the question answerable')

  assert.equal(await settled(() => outcome !== undefined), true, 'a real idle window still settles the ask')
  assert.deepEqual(outcome, { pending: true, callId: 'call-1' }, 'idleness settles it as pending, not as an answer')
  h.claim.dispose()
  console.log('PASS typing outlived the host deadline; idleness still expired the ask')
}

// (a) An answer while claimed wins over the deadline.
{
  const h = await harness()
  const answer = h.service.askTimed({ questions: [question], agent: h.agent } as never, 'call-2', 400)
  await settle(() => h.store.getSnapshot() !== null)
  h.store.answerCurrent({ selected: ['Red'] })
  assert.deepEqual(await answer, { answers: [{ id: 'q1', selected: ['Red'] }] },
    'the answer settles the ask while the claim is held')
  h.claim.dispose()
  console.log('PASS an answer while claimed still wins')
}

// (b) An indefinite ask never takes a claim and keeps its own lifetime.
{
  const h = await harness()
  const ask = h.store.ask({ questions: [question] })
  await settle(() => h.store.getSnapshot() !== null)
  h.store.noteActivity()
  assert.deepEqual(h.claims, [], 'an ask without a timed wait is not claimed')
  h.store.answerCurrent({ selected: ['Red'] })
  assert.deepEqual(await ask, { answers: [{ id: 'q1', selected: ['Red'] }] })
  h.claim.dispose()
  console.log('PASS an indefinite ask is left alone')
}

// (c) A host without attachWait degrades instead of failing.
{
  assert.equal(createQuestionWaitClaim({}, {}), undefined, 'a host without attachWait yields no claim')
  assert.equal(createQuestionWaitClaim(undefined, {}), undefined, 'a missing service yields no claim')
  console.log('PASS a host without attachWait degrades to its plain deadline')
}
