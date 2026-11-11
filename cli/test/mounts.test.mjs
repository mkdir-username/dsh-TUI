/** Mount-ledger reader: display reads tolerate damage, decision reads refuse it. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ledgerPath, ownerOf, pidAlive, readSessionOwners, readSessionOwnersStrict } from '../adapters/dsh/mounts.mjs'

function home() {
  const root = mkdtempSync(join(tmpdir(), 'dst-mounts-'))
  mkdirSync(join(root, '.dsh-tui'))
  return root
}

function writeLedger(root, document) {
  writeFileSync(ledgerPath(root), typeof document === 'string' ? document : JSON.stringify(document))
}

test('a missing ledger is an empty ledger, not a failure', () => {
  const root = home()
  const strict = readSessionOwnersStrict({ home: root })
  assert.equal(strict.ok, true)
  assert.equal(strict.owners.size, 0)
  assert.equal(readSessionOwners({ home: root }).size, 0)
})

test('damage is refused for decisions and ignored for display', () => {
  const root = home()
  for (const broken of ['not json', JSON.stringify({ version: 2, owners: [] }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, owners: [{ pid: 'x' }] })]) {
    writeLedger(root, broken)
    assert.equal(readSessionOwnersStrict({ home: root }).ok, false, broken)
    assert.equal(readSessionOwners({ home: root }).size, 0, broken)
  }
})

test('a live pid owns its sessions, a dead one is dropped', () => {
  const root = home()
  writeLedger(root, { version: 1, owners: [
    { pid: process.pid, startedAt: Date.now(), sessionIds: ['alive-1', 'alive-2'] },
    { pid: 2147483646, startedAt: Date.now(), sessionIds: ['dead-1'] },
  ] })
  const owners = readSessionOwners({ home: root })
  assert.equal(ownerOf(owners, 'alive-1').pid, process.pid)
  assert.equal(owners.has('alive-2'), true)
  assert.equal(owners.has('dead-1'), false)
  assert.equal(ownerOf(owners, 'nobody'), undefined)
})

test('two live owners resolve to the one that started last', () => {
  const root = home()
  const child = Number(process.env.DST_TEST_LIVE_PID ?? process.pid)
  writeLedger(root, { version: 1, owners: [
    { pid: child, startedAt: 1000, sessionIds: ['shared'] },
    { pid: child, startedAt: 2000, sessionIds: ['shared'] },
  ] })
  assert.equal(ownerOf(readSessionOwners({ home: root }), 'shared').startedAt, 2000)
})

test('pidAlive rejects nonsense and accepts this process', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive(-1), false)
  assert.equal(pidAlive(2147483646), false)
})
