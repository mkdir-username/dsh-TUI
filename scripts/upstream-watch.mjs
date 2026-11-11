#!/usr/bin/env node
/**
 * Upstream drift watcher for the personal fork: fetch `origin`, count how far the
 * checked-out branch lags behind, persist the last snapshot and optionally post a
 * notification when upstream gained commits since the previous run.
 *
 * Driven by a launchd agent, which is the same command line as a manual run:
 *   /opt/homebrew/bin/node /Users/username/Docs/dsh-tui-fork/scripts/upstream-watch.mjs --notify
 * Agent: ~/Library/LaunchAgents/com.username.dsh-tui-upstream-watch.plist (daily 10:15).
 *
 * Run: node scripts/upstream-watch.mjs [--notify] [--json] [--quiet]
 * Env: DSH_UPSTREAM_WATCH_REMOTE  remote name, default `origin`
 *      DSH_UPSTREAM_WATCH_STATE   snapshot path, default ~/.cache/dsh-upstream-watch/last.json
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REMOTE = process.env.DSH_UPSTREAM_WATCH_REMOTE ?? 'origin'
const STATE_PATH =
  process.env.DSH_UPSTREAM_WATCH_STATE ?? join(homedir(), '.cache', 'dsh-upstream-watch', 'last.json')
const flags = new Set(process.argv.slice(2))
const notify = flags.has('--notify')
const asJson = flags.has('--json')
const quiet = flags.has('--quiet')

function git(...argv) {
  return execFileSync('git', ['-C', REPO_ROOT, ...argv], { encoding: 'utf8' }).trim()
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function notifyUpstream(state) {
  const title = 'dsh-tui: upstream ушёл вперёд'
  const body = `${state.behind} новых коммит(ов), первый: ${state.commits[0] ?? '—'}`
  execFileSync('/usr/bin/osascript', [
    '-e',
    `display notification "${appleScriptString(body.slice(0, 180))}" with title "${appleScriptString(title)}"`,
  ])
}

function main() {
  git('fetch', '--quiet', REMOTE)
  let branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === 'HEAD') branch = 'main'
  const upstream = `${REMOTE}/${branch}`
  git('rev-parse', '--verify', '--quiet', upstream)

  const behind = Number(git('rev-list', '--count', `${branch}..${upstream}`))
  const ahead = Number(git('rev-list', '--count', `${upstream}..${branch}`))
  const upstreamHead = git('rev-parse', upstream)
  const commits = behind ? git('log', '--oneline', '--no-decorate', `${branch}..${upstream}`).split('\n') : []

  const previous = readState()
  const fresh = previous?.upstreamHead !== upstreamHead && behind > 0
  const state = {
    checkedAt: new Date().toISOString(),
    repo: REPO_ROOT,
    branch,
    upstream,
    upstreamHead,
    behind,
    ahead,
    commits,
    freshSinceLastRun: fresh,
  }
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)

  if (asJson) {
    console.log(JSON.stringify(state, null, 2))
  } else if (!quiet) {
    console.log(`repo: ${REPO_ROOT}`)
    console.log(`${upstream} @ ${upstreamHead.slice(0, 10)}`)
    console.log(`fork ${branch}: behind ${behind}, ahead ${ahead}`)
    for (const line of commits.slice(0, 10)) console.log(`  ${line}`)
    if (behind > 10) console.log(`  … и ещё ${behind - 10}`)
    if (!behind && !ahead) console.log('форк и upstream совпадают')
  }

  if (notify && fresh) notifyUpstream(state)
}

try {
  main()
} catch (error) {
  console.error(`upstream-watch: ${error?.message ?? error}`)
  process.exitCode = 1
}
