/**
 * Headless verification of the /compact input hold: the queued lines park as
 * docked `heldCompact` rows, `queueUserMessages` hands them over in order only
 * when the cycle ends, a row the user took back is not delivered, and a
 * session switch (`abandon`) keeps the rows without sending anything.
 *
 * Run with plain node against the compiled lib:
 *   node scripts/verify-compact-queue.mjs
 */
import './lib/fake-home.mjs' // must stay first: DATA_DIR resolves at import time
import { createCompactHold, COMPACT_HOLD_ROW } from '../lib/types/dsh-adapter/channel/compact-hold.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

function makeWorld({ currentAgent = 'a1' } = {}) {
  const view = { pending: [], emit() { emits += 1 } }
  let emits = 0
  const notifications = []
  const delivered = []
  const hold = createCompactHold({
    state: () => view,
    notify: (text, options) => notifications.push({ text, options }),
    current: origin => origin.agentId === currentAgent,
    enqueue: (text, placement, images, origin, attach) => {
      delivered.push({ text, placement, images: images.length, origin, attach })
    },
  })
  const origin = agentId => ({ agentId, generation: 1, attachedContexts: [] })
  return { view, hold, notifications, delivered, origin, emits: () => emits }
}

// ── 1. park in order, deliver in order at the end of the cycle ─────────────
{
  const world = makeWorld()
  check('hold is inert before install', world.hold.active() === false)
  check('park before install is refused', world.hold.park({ text: 'x', placement: 'followup', images: [], origin: world.origin('a1') }) === false)
  world.hold.install({ agentId: 'a1', generation: 1 })
  check('hold is active after install', world.hold.active() === true)
  check('owns the installed generation', world.hold.owns('a1', 1) === true)
  check('does not own another generation', world.hold.owns('a1', 2) === false)

  world.hold.park({ text: 'one', placement: 'steer', images: [], origin: world.origin('a1') })
  world.hold.park({ text: 'two', placement: 'followup', images: [], origin: world.origin('a1') })
  const rows = world.view.pending
  check('both lines are parked as composer rows', rows.length === 2, JSON.stringify(rows.map(row => row.text)))
  check('parked rows are docked and held', rows.every(row => row.docked === true && row.heldCompact === true))
  check('parked rows carry the hold id prefix', rows.every(row => row.id.startsWith(COMPACT_HOLD_ROW)))
  check('nothing was delivered while the cycle runs', world.delivered.length === 0)

  const sent = world.hold.queueUserMessages()
  check('queue releases both lines', sent === 2 && world.delivered.length === 2, JSON.stringify(world.delivered.map(item => item.text)))
  check('queue keeps submission order', world.delivered.map(item => item.text).join(',') === 'one,two')
  check('released lines leave the composer', world.view.pending.length === 0, JSON.stringify(world.view.pending.length))
  check('hold is inert again after the flush', world.hold.active() === false)
  check('a second flush sends nothing', world.hold.queueUserMessages() === 0)
}

// ── 2. a row the user took back is not delivered ───────────────────────────
{
  const world = makeWorld()
  world.hold.install({ agentId: 'a1', generation: 1 })
  world.hold.park({ text: 'keep', placement: 'followup', images: [], origin: world.origin('a1') })
  world.hold.park({ text: 'taken back', placement: 'followup', images: [], origin: world.origin('a1') })
  // The user removes the second row (↑ / Alt+↑) — only the still-parked one goes.
  world.view.pending = world.view.pending.filter(row => row.text !== 'taken back')
  const sent = world.hold.queueUserMessages()
  check('only still-parked rows are delivered', sent === 1 && world.delivered.length === 1, JSON.stringify(world.delivered.map(item => item.text)))
}

// ── 3. a session switch keeps the rows and sends nothing ───────────────────
{
  const world = makeWorld({ currentAgent: 'a2' })
  world.hold.install({ agentId: 'a1', generation: 1 })
  world.hold.park({ text: 'foreign', placement: 'followup', images: [], origin: world.origin('a1') })
  const notifiedBefore = world.notifications.length
  const abandoned = world.hold.abandon()
  check('abandon reports the queued count', abandoned === 1, JSON.stringify(abandoned))
  check('abandon sends nothing', world.delivered.length === 0)
  check('abandon leaves the row in the composer', world.view.pending.length === 1)
  check('abandon deactivates the hold', world.hold.active() === false)
  check('abandon itself notifies nothing', world.notifications.length === notifiedBefore, JSON.stringify(world.notifications.map(item => item.text)))
}

console.log(failed === 0 ? 'compact-queue battery OK' : `compact-queue battery FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
