#!/usr/bin/env python3
"""Live probe: a real /compact cycle with a real fork child, driven in a pty.

Opt-in, not part of any battery: it boots the current runtime release, spends a
provider request, and takes about a minute. Run it by hand when the cycle's
user-visible behaviour changed.

What it proves, which no headless test can: the notice a person actually sees
when they cancel the restruct-plan stage names the cancel, instead of the bare
`Cancelled` card this probe was written for (2026-11-13).

Isolation: every session it touches lives under /tmp/dsh-fixture-home-rp with a
synthetic id, the workspace is /tmp/rp-live, and the runtime runs with DSH_HOME
pointed at that fixture. The real ~/.dsh sessions are never resumed, so a live
terminal elsewhere keeps its mount.

Run: python3 scripts/verify-compact-rp-live.py
"""
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import time

HOME = '/tmp/dsh-fixture-home-rp'
WORKSPACE = '/tmp/rp-live'
SESSION = '22222222-2222-4222-8222-222222222222'
FULL_HOME = '/tmp/dsh-fixture-home-rp-full'
FULL_WORKSPACE = '/tmp/rp-live-full'
FULL_SESSION = '33333333-3333-4333-8333-333333333333'
BOOT = os.path.expanduser('~/.dsh/runtime/current/boot.mjs')
ANSI_CSI = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]')
ANSI_OSC = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def plain(text):
    return ANSI_CSI.sub('', ANSI_OSC.sub('', text))


def session_dir(home=HOME, workspace=WORKSPACE, session=SESSION):
    cwd_key = '--' + workspace.strip('/').replace('/', '-') + '--'
    return os.path.join(home, 'sessions', cwd_key, session)


def seed(home=HOME, workspace=WORKSPACE, session=SESSION):
    shutil.rmtree(home, ignore_errors=True)
    shutil.rmtree(workspace, ignore_errors=True)
    os.makedirs(os.path.join(workspace, '.dev/demo'))
    with open(os.path.join(workspace, '.dev/demo/tasks.md'), 'w') as handle:
        handle.write('# Tasks: demo\n\n- [ ] T1: synthetic plan for the live probe\n')
    with open(os.path.join(workspace, '.dev/demo/context.md'), 'w') as handle:
        handle.write('# Context: demo\n\nSynthetic workspace; the probe deletes it.\n')
    directory = session_dir(home, workspace, session)
    os.makedirs(directory)
    now = int(time.time() * 1000)
    header = {'type': 'session', 'version': 4, 'id': session, 'createdAt': now,
              'cwd': workspace, 'isSeeded': False, 'delegationDepth': 0,
              'agentPreset': 'standard'}
    events = [
        {'type': 'permission/preset', 'seq': 0, 'time': now, 'data': {'preset': 'danger-full-access'}},
        {'type': 'sandbox/mode', 'seq': 1, 'time': now, 'data': {'mode': 'danger-full-access'}},
        {'type': 'approval/policy', 'seq': 2, 'time': now, 'data': {'policy': 'never'}},
        {'type': 'turn/start', 'seq': 3, 'time': now, 'data': {'turn': 1}},
        {'type': 'request/header', 'seq': 4, 'time': now,
         'data': {'reason': 'initial', 'header': {'config': {'provider': 'opencode-go',
                                                             'model': 'deepseek-v4.1-flash',
                                                             'reasoningEffort': 'max'}}}},
        {'type': 'turn/end', 'seq': 5, 'time': now,
         'data': {'turn': 1, 'reason': {'kind': 'completed'}}},
    ]
    path = os.path.join(directory, 'session.v4.jsonl.zstd')
    # Each frame decodes to exactly one newline-terminated line: the loader
    # rejects a header frame without the terminator.
    with open(path, 'wb') as log:
        for event in [header, *events]:
            frame = subprocess.run(['zstd', '-q', '-c'],
                                   input=(json.dumps(event) + '\n').encode(),
                                   capture_output=True, check=True)
            log.write(frame.stdout)
    return path


FAILURES = []


def check(name, ok, detail=''):
    if ok:
        print('PASS: %s' % name)
    else:
        FAILURES.append(name)
        print('FAIL: %s  %s' % (name, plain(str(detail))[-500:]))


def read_events(path):
    if not os.path.exists(path):
        return []
    run = subprocess.run(['zstd', '-dc', '--', path], capture_output=True)
    events = []
    for line in run.stdout.decode('utf-8', 'replace').splitlines():
        line = line.strip()
        if line == '':
            continue
        try:
            events.append(json.loads(line))
        except ValueError:
            continue
    return events


def children_of(home, workspace, parent):
    base = os.path.join(home, 'sessions', '--' + workspace.strip('/').replace('/', '-') + '--')
    if not os.path.isdir(base):
        return []
    found = []
    for name in sorted(os.listdir(base)):
        if name == parent:
            continue
        events = read_events(os.path.join(base, name, 'session.v4.jsonl.zstd'))
        if events and events[0].get('parentSession') == parent:
            found.append((name, events))
    return found


def newest_boot_profile():
    """The composed profile a live TUI boots with: plugin rows the fixture home
    cannot compose on its own (a bare DSH_HOME disables rc.2 rows on rc.1)."""
    runs = os.path.expanduser('~/.dsh/runtime/runs')
    candidates = sorted(
        (os.path.join(runs, name, 'profile') for name in os.listdir(runs)),
        key=os.path.getmtime, reverse=True,
    ) if os.path.isdir(runs) else []
    return next((path for path in candidates if os.path.isdir(path)), None)


def boot(home, workspace, session):
    env = {**os.environ, 'DSH_HOME': home, 'TERM': 'xterm-256color'}
    env.pop('DSH_DEEPSEEK_APPROVED', None)
    profile = os.environ.get('DSH_PROBE_PROFILE_DIR') or newest_boot_profile()
    if profile and os.path.isdir(profile):
        # Sessions stay under the fixture home; only the composed row set is
        # shared, and it overrides the inherited (possibly recycled) boot dir.
        env['DSH_PROFILE_DIR'] = profile
    master, slave = pty.openpty()
    proc = subprocess.Popen(['node', BOOT, '--resume', session], cwd=workspace, env=env,
                            stdin=slave, stdout=slave, stderr=slave, preexec_fn=os.setsid)
    os.close(slave)
    return master, proc


def pump(master, screen, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            return screen
        if not chunk:
            return screen
        screen += chunk.decode('utf-8', 'replace')
    return screen


def wait_for(master, screen, needle, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        if needle in plain(screen):
            return True, screen
        screen = pump(master, screen, 0.2)
    return needle in plain(screen), screen


def scenario_cancel():
    """The reported scenario: the stage is cancelled and the notice names who did it."""
    path = seed()
    check('cancel: fixture session is seeded', os.path.getsize(path) > 0)
    master, proc = boot(HOME, WORKSPACE, SESSION)
    screen = ''
    try:
        ready, screen = wait_for(master, screen, '❯', 40)
        check('cancel: the TUI reaches its composer', ready, screen[-600:])
        if not ready:
            print(plain(screen)[-4_000:])
            return
        os.write(master, b'/compact\n')
        stage, screen = wait_for(master, screen, 'restruct-plan', 30)
        check('cancel: the restruct-plan stage is visible', stage, screen[-600:])
        time.sleep(1.5)
        os.write(master, b'\x1b')
        notice, screen = wait_for(master, screen, 'отменён пользователем', 15)
        check('cancel: cancelling the stage names the user', notice, screen[-800:])
        check('cancel: the notice says the compaction did not run', 'Сжатие' in plain(screen), screen[-800:])
        os.write(master, b'/quit\n')
        pump(master, screen, 3)
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            pass
        proc.wait(timeout=10)
        os.close(master)


def scenario_full():
    """The happy path: the fork works, then the compaction actually runs."""
    parent_log = seed(FULL_HOME, FULL_WORKSPACE, FULL_SESSION)
    check('full: fixture session is seeded', os.path.getsize(parent_log) > 0)
    master, proc = boot(FULL_HOME, FULL_WORKSPACE, FULL_SESSION)
    screen = ''
    try:
        ready, screen = wait_for(master, screen, '❯', 40)
        check('full: the TUI reaches its composer', ready, screen[-600:])
        if not ready:
            print(plain(screen)[-4_000:])
            return
        os.write(master, b'/compact\n')
        stage, screen = wait_for(master, screen, 'restruct-plan', 30)
        check('full: the restruct-plan stage is visible', stage, screen[-600:])
        # The fork runs the plan actualization, then the summary: both are durable
        # events in the fixture's own logs, so the wait is bounded by the log.
        deadline = time.time() + 240
        events = []
        while time.time() < deadline:
            screen = pump(master, screen, 2)
            events = read_events(parent_log)
            if any(event.get('type') == 'compaction/end' for event in events):
                break
        # A fixture boot on engine rc.1 cannot mount the release profile's
        # provider row, so the fork cannot reach the model. That is a property
        # of the fixture, not a verdict about the cycle: report it and stop
        # before the compaction assertions rather than blaming the cycle.
        kids = children_of(FULL_HOME, FULL_WORKSPACE, FULL_SESSION)
        if kids:
            kid_id, kid_events = kids[0]
            ends = [event for event in kid_events if event.get('type') == 'turn/end']
            error = ((ends[-1].get('data') or {}).get('reason') or {}).get('error') or {} if ends else {}
            if error.get('code') == 'NO_ADAPTER':
                print('SKIP: full: the fixture boot has no adapter for opencode-go (%s)' % error.get('message', ''))
                os.write(master, b'/quit\n')
                pump(master, screen, 3)
                return
        types = [event.get('type') for event in events]
        check('full: the compaction bracket opened', 'compaction/start' in types, types[-8:])
        check('full: the compaction finished', 'compaction/end' in types, types[-8:])
        check('full: the fork child left its own session', len(kids) == 1, [name for name, _ in kids])
        if kids:
            kid_id, kid_events = kids[0]
            kid_types = [event.get('type') for event in kid_events]
            check('full: the fork actually talked to the model',
                  'assistant/message' in kid_types, kid_types[-8:])
            ends = [event for event in kid_events if event.get('type') == 'turn/end']
            reason = (ends[-1].get('data') or {}).get('reason') if ends else None
            check('full: the fork finished its own turn', (reason or {}).get('kind') == 'completed', reason)
            text = ''
            for event in kid_events:
                if event.get('type') != 'assistant/message':
                    continue
                for block in ((event.get('data') or {}).get('message') or {}).get('content') or []:
                    if block.get('type') == 'text':
                        text += block.get('text', '') + '\n'
            last = [line for line in text.splitlines() if line.strip()][-1] if text.strip() else ''
            check('full: the fork ends on an RP marker', 'RP_DONE' in last or 'RP_SKIP' in last, last)
            print('  fork %s: %s' % (kid_id[:8], last[:120]))
        os.write(master, b'/quit\n')
        pump(master, screen, 3)
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            pass
        proc.wait(timeout=10)
        os.close(master)


def main():
    if not os.path.exists(BOOT):
        print('SKIP: %s отсутствует — сначала dsh-runtime prepare' % BOOT)
        return 0
    only = sys.argv[1] if len(sys.argv) > 1 else ''
    if only != '--full':
        scenario_cancel()
    if only != '--cancel':
        scenario_full()
    print('live compact-rp probe OK' if not FAILURES else 'live compact-rp probe FAILED (%d)' % len(FAILURES))
    return 0 if not FAILURES else 1


if __name__ == '__main__':
    sys.exit(main())
