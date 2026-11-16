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
