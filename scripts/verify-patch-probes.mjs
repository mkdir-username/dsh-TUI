#!/usr/bin/env node
/**
 * The profile's capability probes must tell a documented absence from a probe
 * that could not answer. `command-goal` and the `dsh-tui-agent-presets` config
 * both pick a row from the installed package generation; when the resolve or
 * read fails for any reason other than `MODULE_NOT_FOUND` (EACCES, a missing
 * project root, a broken package tree) a bare `false` silently selects the
 * legacy shape and nothing records why.
 *
 * This gate evaluates the two `!!js` expressions from `cordis.patch.yml`
 * against injected module systems and asserts: the documented absence stays
 * silent, every other failure is logged, and the fallback value is unchanged
 * (the probe never throws — it runs inside the profile loader).
 *
 * Run: node scripts/verify-patch-probes.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import nodePath from 'node:path'
import { parse as parseYaml } from 'yaml'

const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
const document = parseYaml(readFileSync(patchUrl, 'utf8'), { logLevel: 'silent' })
const PROFILE_ROOT = 'file:///profile/cordis.patch.yml'

function rowById(id) {
  for (const item of document) {
    if (item === null || typeof item !== 'object') continue
    if (item.id === id) return item
    if (!Array.isArray(item.insert)) continue
    const row = item.insert.find(candidate => candidate !== null && typeof candidate === 'object' && candidate.id === id)
    if (row !== undefined) return row
  }
  throw new Error(`cordis.patch.yml has no row "${id}"`)
}

const commandGoal = rowById('command-goal').disabled
const presetsConfig = rowById('dsh-tui-agent-presets').config
assert.equal(typeof commandGoal, 'string', 'command-goal probe expression must stay a `!!js` scalar')
assert.equal(typeof presetsConfig, 'string', 'agent-presets config must stay a `!!js` scalar')

/** Builtin modules the expression may ask for, with one injected failure mode. */
function fakeProcess({ resolve, readFile }) {
  return {
    getBuiltinModule(name) {
      if (name === 'node:module') return { createRequire: () => ({ resolve }) }
      if (name === 'node:fs') {
        return {
          existsSync: () => true,
          readFileSync: (...args) => {
            if (readFile === undefined) throw new Error('unexpected read')
            return readFile(...args)
          },
        }
      }
      if (name === 'node:path') return nodePath
      throw new Error(`unexpected builtin module ${name}`)
    },
  }
}

const absent = () => {
  const error = new Error('Cannot find module')
  error.code = 'MODULE_NOT_FOUND'
  throw error
}
const denied = () => {
  const error = new Error('EACCES: permission denied')
  error.code = 'EACCES'
  throw error
}

function run(expression, { resolve, readFile, baseUrl = PROFILE_ROOT }) {
  const warnings = []
  const ctx = { baseUrl, logger: { warn: (...args) => warnings.push(args.join(' ')) } }
  const value = new Function('process', 'ctx', `return (${expression})`)(fakeProcess({ resolve, readFile }), ctx)
  return { value, warnings }
}

let failures = 0
function check(name, run_check) {
  try { run_check(); console.log(`PASS ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL ${name}\n${error instanceof Error ? error.message : String(error)}`) }
}

const RESOLVE_REGISTRY = '@deepseek-ai/dsh-agent-preset-registry/package.json'
const RESOLVE_PRESETS = '@deepseek-ai/dsh-agent-presets/package.json'
const PRESET_TEXT = '- id: preset\n- id: command-goal\n'

check('a shipped preset registry disables the host command row', () => {
  const { value, warnings } = run(commandGoal, { resolve: spec => (spec === RESOLVE_REGISTRY ? '/pkg/registry/package.json' : absent()) })
  assert.equal(value, true)
  assert.deepEqual(warnings, [])
})

check('a documented legacy absence keeps the row and stays silent', () => {
  const { value, warnings } = run(commandGoal, { resolve: () => absent() })
  assert.equal(value, false)
  assert.deepEqual(warnings, [])
})

check('the shipped standard preset owning the command disables the row', () => {
  const { value, warnings } = run(commandGoal, {
    resolve: spec => (spec === RESOLVE_PRESETS ? '/pkg/presets/package.json' : absent()),
    readFile: () => PRESET_TEXT,
  })
  assert.equal(value, true)
  assert.deepEqual(warnings, [])
})

check('a preset without the command keeps the row', () => {
  const { value, warnings } = run(commandGoal, {
    resolve: spec => (spec === RESOLVE_PRESETS ? '/pkg/presets/package.json' : absent()),
    readFile: () => '- id: preset\n',
  })
  assert.equal(value, false)
  assert.deepEqual(warnings, [])
})

check('an unexpected resolve failure is reported instead of read as absence', () => {
  const { value, warnings } = run(commandGoal, { resolve: () => denied() })
  assert.equal(value, false)
  assert.equal(warnings.length, 1, 'exactly one warning for one failed probe')
  assert.match(warnings[0], /EACCES/u)
})

check('an unreadable preset file is reported instead of read as absence', () => {
  const { value, warnings } = run(commandGoal, {
    resolve: spec => (spec === RESOLVE_PRESETS ? '/pkg/presets/package.json' : absent()),
    readFile: denied,
  })
  assert.equal(value, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /EACCES/u)
})

check('a missing profile root is reported, not thrown', () => {
  const { value, warnings } = run(commandGoal, { resolve: () => absent(), baseUrl: null })
  assert.equal(value, false)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /baseUrl/u)
})

check('the bundled presets directory keeps the package default', () => {
  const { value, warnings } = run(presetsConfig, { resolve: spec => (spec === RESOLVE_PRESETS ? '/pkg/presets/package.json' : absent()) })
  assert.deepEqual(value, { default: 'standard' })
  assert.deepEqual(warnings, [])
})

check('a documented legacy absence falls back to the CLI preset root silently', () => {
  const { value, warnings } = run(presetsConfig, { resolve: () => absent() })
  assert.equal(value.default, 'standard')
  assert.equal(value.roots?.length, 1, 'the legacy generation needs an explicit root')
  assert.match(value.roots[0].path, /agent-presets\/$/u)
  assert.equal(value.roots[0].trust, 'system')
  assert.deepEqual(warnings, [])
})

check('an unexpected resolve failure is reported', () => {
  const { value, warnings } = run(presetsConfig, { resolve: () => denied() })
  assert.equal(value.default, 'standard')
  assert.equal(value.roots?.length, 1, 'the fallback value is unchanged by reporting')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /EACCES/u)
})

check('a missing profile root keeps the package default and is reported', () => {
  const { value, warnings } = run(presetsConfig, { resolve: () => absent(), baseUrl: null })
  assert.deepEqual(value, { default: 'standard' })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /baseUrl/u)
})

if (failures > 0) {
  console.error(`patch-probes: ${11 - failures}/11 checks passed`)
  process.exit(1)
}
console.log('patch-probes: 11/11 checks passed')
