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
BOOT = os.path.expanduser('~/.dsh/runtime/current/boot.mjs')
ANSI_CSI = re.compile(r'\x1b\[[0-9;?]*[a-zA-Z]')
ANSI_OSC = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')


def plain(text):
    return ANSI_CSI.sub('', ANSI_OSC.sub('', text))


def session_dir():
    cwd_key = '--' + WORKSPACE.strip('/').replace('/', '-') + '--'
    return os.path.join(HOME, 'sessions', cwd_key, SESSION)


def seed():
    shutil.rmtree(HOME, ignore_errors=True)
    shutil.rmtree(WORKSPACE, ignore_errors=True)
    os.makedirs(os.path.join(WORKSPACE, '.dev/demo'))
    with open(os.path.join(WORKSPACE, '.dev/demo/tasks.md'), 'w') as handle:
        handle.write('# Tasks: demo\n\n- [ ] T1: synthetic plan for the live probe\n')
    with open(os.path.join(WORKSPACE, '.dev/demo/context.md'), 'w') as handle:
        handle.write('# Context: demo\n\nSynthetic workspace; the probe deletes it.\n')
    directory = session_dir()
    os.makedirs(directory)
    now = int(time.time() * 1000)
    header = {'type': 'session', 'version': 4, 'id': SESSION, 'createdAt': now,
              'cwd': WORKSPACE, 'isSeeded': False, 'delegationDepth': 0,
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


def main():
    if not os.path.exists(BOOT):
        print('SKIP: %s отсутствует — сначала dsh-runtime prepare' % BOOT)
        return 0
    log_path = seed()
    failures = []

    def check(name, ok, detail=''):
        if ok:
            print('PASS: %s' % name)
        else:
            failures.append(name)
            print('FAIL: %s  %s' % (name, plain(str(detail))[-500:]))

    check('fixture session is seeded', os.path.getsize(log_path) > 0)

    env = {**os.environ, 'DSH_HOME': HOME, 'TERM': 'xterm-256color'}
    env.pop('DSH_DEEPSEEK_APPROVED', None)
    master, slave = pty.openpty()
    proc = subprocess.Popen(['node', BOOT, '--resume', SESSION], cwd=WORKSPACE, env=env,
                            stdin=slave, stdout=slave, stderr=slave, preexec_fn=os.setsid)
    os.close(slave)
    screen = ''

    def pump(seconds):
        nonlocal screen
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            screen += chunk.decode('utf-8', 'replace')
        return True

    def wait_for(needle, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if needle in plain(screen):
                return True
            if not pump(0.2):
                break
        return needle in plain(screen)

    try:
        ready = wait_for('❯', 40)
        check('the TUI reaches its composer', ready, plain(screen)[-600:])
        if not ready:
            print('---- boot capture ----')
            print(plain(screen)[-4_000:])
            return 1
        os.write(master, b'/compact\n')
        check('the restruct-plan stage is visible', wait_for('restruct-plan', 30), plain(screen)[-600:])
        time.sleep(1.5)
        os.write(master, b'\x1b')
        check('cancelling the stage names the user', wait_for('отменён пользователем', 15), plain(screen)[-800:])
        # The notice is one clipped status line, so the body is asserted by its
        # opening words rather than the full sentence.
        check('the notice says the compaction did not run',
              'Сжатие' in plain(screen), plain(screen)[-800:])
        os.write(master, b'/quit\n')
        pump(3)
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except OSError:
            pass
        proc.wait(timeout=10)
        os.close(master)

    print('live compact-rp probe OK' if not failures else 'live compact-rp probe FAILED (%d)' % len(failures))
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())
