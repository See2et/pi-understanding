#!/usr/bin/env python3
"""Actual Pi 1.0.4 loader + PTY QA, isolated config, deterministic native provider, no paid inference.
PI_UNDERSTANDING_BINARY=/path/to/pi python3 tests/native-qa.py
Evidence is ignored .evidence/native-qa; no personal auth/settings are opened.
"""
import os, sys, subprocess, json, time, pathlib, shutil, hashlib, pty, fcntl, termios, struct, signal, select
ROOT = pathlib.Path(__file__).resolve().parents[1]
MODE = os.environ.get('PI_UNDERSTANDING_TUI_MODE', 'fullscreen')
assert MODE in ('fullscreen', 'regular')
OUT = ROOT / ('.evidence/native-qa' if MODE == 'fullscreen' else '.evidence/native-qa-regular')
OUT.mkdir(parents=True, exist_ok=True)
if (OUT / 'config').exists(): shutil.rmtree(OUT / 'config')
PI = os.environ.get('PI_UNDERSTANDING_BINARY', '/nix/store/rpga5vi5495pglblk0b57bcvrrp68dxz-pi-coding-agent-1.0.4/libexec/pi/pi')
RAW = OUT / 'raw-package'
if RAW.exists(): shutil.rmtree(RAW)
shutil.copytree(ROOT / 'src', RAW / 'src')
shutil.copyfile(ROOT / 'package.json', RAW / 'package.json')
WORK = OUT / 'workspace'
if WORK.exists(): shutil.rmtree(WORK)
WORK.mkdir()
def git(*args): return subprocess.check_output(['git', *args], cwd=WORK, text=True).strip()
git('init', '-q'); git('config', 'user.name', 'QA fixture'); git('config', 'user.email', 'qa@example.invalid')
(WORK / 'src').mkdir(); (WORK / 'src/main.ts').write_text('export function submit() { return "ok"; }\n')
(WORK / 'README.md').write_text('# Fixture\nUser flow: submit -> validate -> result\n')
git('add', '.'); git('commit', '-qm', 'fixture base'); BASE = git('rev-parse', 'HEAD')
(WORK / 'src/main.ts').write_text('export function submit() { return "verified"; }\n')
git('add', '.'); git('commit', '-qm', 'fixture head'); HEAD = git('rev-parse', 'HEAD')
ENV = {**os.environ, 'PI_CODING_AGENT_DIR': str(OUT / 'config'), 'PI_OFFLINE': '1', 'PI_TELEMETRY': '0', 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor'}
ARGS = [PI, '--offline', '--no-approve', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--tools', 'select_understanding_scope', '-e', str(RAW), '-e', str(ROOT / 'tests/fixture-provider.ts'), '--model', 'understanding-qa/gpt-qa', '--thinking', 'off']
proc = subprocess.Popen([*ARGS, '--mode', 'rpc'], cwd=WORK, env=ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
records = []
def rpc(kind, **fields):
    assert proc.stdin is not None and proc.stdout is not None
    rid = str(len(records)) + kind + str(time.time_ns())
    proc.stdin.write((json.dumps({'id': rid, 'type': kind, **fields}) + '\n').encode()); proc.stdin.flush()
    deadline = time.time() + 15
    while time.time() < deadline:
        ready, _, _ = select.select([proc.stdout], [], [], 1)
        if not ready: continue
        line = proc.stdout.readline()
        if not line: raise RuntimeError('Pi RPC exited')
        record = json.loads(line); records.append(record)
        if record.get('id') == rid:
            assert record.get('success'), record
            return record.get('data', {})
    raise RuntimeError('RPC timeout ' + kind)
def prompt(text): return rpc('prompt', message=text)
commands = rpc('get_commands')['commands']; assert any(c['name'] == 'understand' for c in commands), commands
prompt(f'/understand scope commit {HEAD} {BASE}')
first = rpc('get_entries')['entries']; assert any(e.get('customType') == 'see2et.pi-understanding.v1' for e in first)
prompt('/understand ask learner-only-rpc')
time.sleep(3)
entries = rpc('get_entries')['entries']
state = [e['data'] for e in entries if e.get('customType') == 'see2et.pi-understanding.v1'][-1]
active = state['active']; assert state['scopes'][active]['turns'][-1]['role'] == 'assistant', state
messages = rpc('get_messages')['messages']; assert 'learner-only-rpc' not in json.dumps(messages), messages
prompt('main-chat-probe')
time.sleep(1)
messages = rpc('get_messages')['messages']; assert 'main-chat-probe' in json.dumps(messages); assert 'learner-only-rpc' not in json.dumps(messages)
session_file = rpc('get_state')['sessionFile']
rpc('clone'); prompt('/understand focus fork-only-focus');
rpc('switch_session', sessionPath=session_file)
prompt('/understand check')
restored = [e['data'] for e in rpc('get_entries')['entries'] if e.get('customType') == 'see2et.pi-understanding.v1'][-1]
assert restored['active'] == active; assert restored['scopes'][active]['focus'] != 'fork-only-focus'
prompt('/understand ask WAIT_CANCEL')
rpc('new_session'); time.sleep(2.2)
assert not [e for e in rpc('get_entries')['entries'] if e.get('customType') == 'see2et.pi-understanding.v1'], 'late learning result contaminated new session'
proc.stdin.close(); proc.wait(timeout=10)
(OUT / 'rpc.json').write_text(json.dumps(records, ensure_ascii=False, indent=2))
(OUT / 'rpc.stderr').write_bytes(proc.stderr.read())
assert not (OUT / 'rpc.stderr').read_text().strip(), (OUT / 'rpc.stderr').read_text()

# Everyday target flows use actual Git staging/working changes in this isolated fixture only.
git('branch', 'feature', HEAD)
BRANCH = git('branch', '--show-current')
(WORK / 'src/main.ts').write_text('export function submit() { return "staged"; }\n')
git('add', 'src/main.ts')
(WORK / 'src/main.ts').write_text('export function submit() { return "working"; }\n')
(WORK / 'src/new.ts').write_text('export const draft = true;\n')
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
process = subprocess.Popen([*ARGS, '--tui-mode', MODE, '--session-id', 'understanding-pty-qa'], cwd=WORK, env=ENV, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
raw = bytearray(); stages = []
def drain(seconds=.4):
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], min(.1, max(0, deadline - time.time())))
        if ready:
            try: block = os.read(master, 65536)
            except OSError: return
            if not block: return
            raw.extend(block)
def send(text): os.write(master, text.encode()); drain(.4)
def command(text): send(text + '\r')
def capture(name, cols, rows):
    drain(.3); stages.append({'name': name, 'cols': cols, 'rows': rows, 'end': len(raw)})
def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0)); os.kill(process.pid, signal.SIGWINCH); drain(.5)
drain(1.5)
command('/understand scope changes'); capture('uncommitted-background-120x36', 120, 36)
command(f'/understand scope branch feature {BRANCH}'); capture('branch-comparison-120x36', 120, 36)
command('/understand scope repository'); capture('typical-background-120x36', 120, 36)
command('/understand map'); drain(3); command('/understand focus'); send('\x1b[5~'); capture('grounded-map-120x36', 120, 36); send('\x1b')
# Background pane must not own ordinary input.
send('main-input-still-active'); capture('main-input-background-120x36', 120, 36)
send('\x15'); command('/understand focus')
send('\x1b[200~質問：責任を説明してください\x1b[201~'); capture('japanese-focused-120x36', 120, 36)
send('\r'); drain(3); capture('learning-dialogue-120x36', 120, 36)
send('\x1b'); command('main-chat-probe'); drain(.8); capture('main-chat-operational-120x36', 120, 36)
command('/understand focus'); send('WAIT_CANCEL\r'); drain(.2); send('\x03'); drain(2); capture('cancelled-learning-120x36', 120, 36)
send('\x1b'); resize(80, 24); capture('narrow-background-hidden-80x24', 80, 24)
command('/understand focus'); capture('narrow-focus-fallback-80x24', 80, 24)
resize(160, 48); capture('wide-focused-160x48', 160, 48)
send('\x1b'); command('/understand ask FAIL_NATIVE'); drain(3); capture('native-failure-cleanup-160x48', 160, 48)
command('/reload'); drain(1); command('/understand open'); capture('reload-restored-160x48', 160, 48)
# The implementation agent proposes a target while the learner is in wide view.
command('/understand close')
command('QA_TARGET_DELAY'); command('/understand wide'); send('draft-to-preserve'); drain(3)
capture('ai-target-confirm-visible-160x48', 160, 48)
send('\x1b'); drain(.8); capture('ai-target-cancel-restored-160x48', 160, 48)
send('\x1b'); command('QA_TARGET_DELAY'); command('/understand wide'); drain(3)
capture('ai-target-accept-visible-160x48', 160, 48)
send('\r'); drain(1); capture('ai-target-changed-160x48', 160, 48)
send('\x1b'); command('/qa-exit'); drain(.7)
try: process.wait(timeout=5)
except subprocess.TimeoutExpired: process.terminate(); process.wait(timeout=5); raise RuntimeError('PTY orderly shutdown timed out')
os.close(master)
(OUT / 'pty.ansi').write_bytes(raw)
(OUT / 'stages.json').write_text(json.dumps(stages, ensure_ascii=False, indent=2))
source_hash = hashlib.sha256(b''.join(p.read_bytes() for p in sorted((ROOT / 'src').glob('*.ts')))).hexdigest()
(OUT / 'summary.json').write_text(json.dumps({'pi': PI, 'source_sha256': source_hash, 'raw_package_has_node_modules': (RAW / 'node_modules').exists(), 'rpc_exit': proc.returncode, 'pty_exit': process.returncode, 'tui_mode': MODE, 'fixture_head': HEAD, 'stages': len(stages), 'inference': 'deterministic native Pi provider fixture only; no paid/network inference'}, indent=2))
print(json.dumps({'rpc': 'passed loader/separation/clone/switch/cancellation checks', 'pty_exit': process.returncode, 'stages': len(stages), 'evidence': str(OUT)}))
