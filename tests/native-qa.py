#!/usr/bin/env python3
"""Actual Pi 1.0.4 loader + PTY QA, isolated config, deterministic native provider, no paid inference.
PI_UNDERSTANDING_BINARY=/path/to/pi python3 tests/native-qa.py
PI_UNDERSTANDING_TUI_MODE=regular python3 tests/native-qa.py
Evidence is ignored .evidence/native-qa(-regular); no personal auth/settings are opened.
Mouse wheel is injected as SGR reports only in fullscreen, where Pi routes mouse events to components.
Regular mode leaves the wheel to terminal scrollback (Pi docs), which a PTY cannot represent; it is not exercised.
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
ENTRY = 'see2et.pi-understanding.v2'
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
first = rpc('get_entries')['entries']; assert any(e.get('customType') == ENTRY for e in first)
prompt('/understand ask learner-only-rpc')
time.sleep(3)
entries = rpc('get_entries')['entries']
state = [e['data'] for e in entries if e.get('customType') == ENTRY][-1]
active = state['active']; assert state['scopes'][active]['turns'][-1]['role'] == 'assistant', state
messages = rpc('get_messages')['messages']; assert 'learner-only-rpc' not in json.dumps(messages), messages
prompt('main-chat-probe')
time.sleep(1)
messages = rpc('get_messages')['messages']; assert 'main-chat-probe' in json.dumps(messages); assert 'learner-only-rpc' not in json.dumps(messages)
session_file = rpc('get_state')['sessionFile']
rpc('clone'); prompt('/understand focus fork-only-focus');
rpc('switch_session', sessionPath=session_file)
prompt('/understand check')
restored = [e['data'] for e in rpc('get_entries')['entries'] if e.get('customType') == ENTRY][-1]
assert restored['active'] == active; assert restored['scopes'][active]['focus'] != 'fork-only-focus'
prompt('/understand ask WAIT_CANCEL')
rpc('new_session'); time.sleep(2.2)
assert not [e for e in rpc('get_entries')['entries'] if e.get('customType') == ENTRY], 'late learning result contaminated new session'
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
def command(text):
    # All normal commands run in the ordinary editor; near-fullscreen learning has no background-input mode.
    send('\x1b'); send(text + '\r')
SHORTCUT = '\x1b[117;7u'  # native CSI-u Ctrl+Alt+U, no terminal mouse enabling
ALT_S = '\x1bs'  # legacy Alt+S as most terminals (and mosh) send it; a focused pane receives it directly
TAB, SHIFT_TAB, UP, DOWN, LEFT, ENTER = '\t', '\x1b[Z', '\x1b[A', '\x1b[B', '\x1b[D', '\r'
PGUP, CTRL_HOME, CTRL_END, CTRL_O = '\x1b[5~', '\x1b[1;5H', '\x1b[1;5F', '\x0f'
wheel_events = []
def wheel(x, y, up, times):
    # SGR wheel reports at 1-based cells. Only fullscreen Pi enables/routes mouse input to components;
    # regular mode leaves the wheel to terminal scrollback, which this PTY cannot represent.
    if MODE != 'fullscreen': return False
    for _ in range(times): os.write(master, ('\x1b[<%d;%d;%dM' % (64 if up else 65, x, y)).encode()); drain(.12)
    wheel_events.append({'x': x, 'y': y, 'up': up, 'times': times}); drain(.3); return True
learner_probes = ['wide-first-probe', 'command-focus-probe', 'learner-draft-wide-tail', 'learner-draft-narrow-tail', 'learner-draft-large-tail']
main_probes = ['main-draft-wide-tail', 'main-draft-narrow-tail', 'main-draft-large-tail']
def focus_roundtrip(label, cols, rows):
    send('main-draft-' + label)
    send(SHORTCUT); send('learner-draft-' + label); capture('shortcut-learner-' + label, cols, rows)
    send(SHORTCUT); send('-tail'); capture('shortcut-main-' + label, cols, rows)
    send(SHORTCUT); send('-tail'); capture('shortcut-preserved-' + label, cols, rows)
    send('\r'); drain(3); send(SHORTCUT); send('\r'); drain(1)
    capture('shortcut-submitted-' + label, cols, rows)
def capture(name, cols, rows):
    drain(.3); stages.append({'name': name, 'cols': cols, 'rows': rows, 'end': len(raw)})
def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0)); os.kill(process.pid, signal.SIGWINCH); drain(.5)
drain(1.5)
command('/understand scope changes'); capture('uncommitted-background-120x36', 120, 36)
command(f'/understand scope branch feature {BRANCH}'); capture('branch-comparison-120x36', 120, 36)
command('/understand scope repository'); capture('typical-background-120x36', 120, 36)
# New wide interaction must take actual text ownership, just like an existing pane.
command('/understand close'); command('/understand focus'); send('command-focus-probe'); capture('command-focus-input-120x36', 120, 36)
send('\r'); drain(3); send('\x07')
command('/understand close'); command('/understand wide'); send('wide-first-probe'); capture('wide-first-input-120x36', 120, 36)
send('\r'); drain(3); send('\x1b')
# Model ownership on an existing repository (no change required): explicit generation, then
# overview -> claim -> evidence -> back -> overview with non-printing keys only (no `dive N`).
command('/u'); capture('model-empty-120x36', 120, 36)
send(ENTER); drain(5); capture('model-overview-120x36', 120, 36)
send(TAB); capture('model-tab-120x36', 120, 36)
send(SHIFT_TAB); send(ENTER); capture('model-claim-120x36', 120, 36)
send(ENTER); capture('model-evidence-120x36', 120, 36)
send(TAB); capture('model-evidence-next-120x36', 120, 36)
send(LEFT); capture('model-back-claim-120x36', 120, 36)
for _ in range(3): send(SHIFT_TAB)
send(ENTER); capture('model-skip-120x36', 120, 36)
send(CTRL_O); capture('model-ctrl-o-120x36', 120, 36)
# A prospective change is a hypothesis entrance, kept apart from current facts.
send('proposal 学習AIに読取toolを渡す\r'); drain(3); capture('proposal-120x36', 120, 36)
send(SHIFT_TAB); send(ENTER); capture('proposal-cleared-120x36', 120, 36)
# Optional questions: quiet hides every challenge; questions on restores them.
for _ in range(3): send(DOWN)
send(ENTER); send(SHIFT_TAB); send(ENTER); capture('quiet-120x36', 120, 36)
send(SHIFT_TAB); send(ENTER); capture('questions-on-120x36', 120, 36)
send('このフローで validate を飛ばすと？\r'); drain(3); capture('claim-question-120x36', 120, 36)
send(CTRL_O)
# Long dialogue beyond the 60k-character retention: independent scroll, retained top, reading during output.
for n in (1, 2, 3): send(f'LONG_REPLY {n}\r'); drain(3)
capture('long-latest-120x36', 120, 36)
for _ in range(3): send(PGUP)
capture('long-pgup-120x36', 120, 36)
if wheel(90, 15, True, 5): capture('long-wheel-chat-120x36', 120, 36)
send(CTRL_HOME); capture('long-top-120x36', 120, 36)
send('SLOW_STREAM 読書中に届く回答\r'); send(PGUP); send(PGUP); drain(3.5); capture('reading-while-streaming-120x36', 120, 36)
send(CTRL_END); capture('stream-followed-120x36', 120, 36)
# Alt+S toggles with both native drafts retained; each draft reaches only its own conversation.
send('alt-s-learner-draft'); send(ALT_S); send('alt-s-main-draft'); capture('alts-main-120x36', 120, 36)
send(ALT_S); send('-tail'); capture('alts-learner-120x36', 120, 36)
send(ENTER); drain(3); send(ALT_S); send(ENTER); drain(1); capture('alts-submitted-120x36', 120, 36)
learner_probes.append('alt-s-learner-draft-tail'); main_probes.append('alt-s-main-draft')
command('/understand map'); drain(3); command('/understand overview'); capture('grounded-map-120x36', 120, 36)
send('dive 1\r'); capture('point-detail-120x36', 120, 36)
send('\x0f'); capture('point-overview-return-120x36', 120, 36); send('\x1b')
# Hidden overlay must not own ordinary input.
send('main-input-still-active'); capture('main-input-background-120x36', 120, 36)
send('\x15'); focus_roundtrip('wide', 120, 36)
# The old side/wide exposed-editor mouse routing contract is intentionally retired.
# Ctrl+D hides without destroying the learner's unsent draft; normal draft remains independent.
send('main-close-draft'); send(SHORTCUT); send('learner-close-draft'); send('\x04')
send('-tail'); capture('closed-draft-main-120x36', 120, 36)
send(SHORTCUT); send('-tail'); capture('closed-draft-learner-120x36', 120, 36)
send('\r'); drain(3); send(SHORTCUT); send('\r'); drain(1)
learner_probes.append('learner-close-draft-tail'); main_probes.append('main-close-draft-tail')
command('/understand focus')
send('\x1b[200~質問：責任を説明してください\x1b[201~'); capture('japanese-focused-120x36', 120, 36)
send('\r'); drain(3); capture('learning-dialogue-120x36', 120, 36)
send('\x1b'); command('main-chat-probe'); drain(.8); capture('main-chat-operational-120x36', 120, 36)
command('/understand focus'); send('WAIT_CANCEL\r'); drain(.2); send('\x03'); drain(2); capture('cancelled-learning-120x36', 120, 36)
send('\x1b'); resize(80, 24); capture('narrow-background-hidden-80x24', 80, 24)
focus_roundtrip('narrow', 80, 24)
command('/understand focus'); capture('narrow-focus-fallback-80x24', 80, 24)
# Stacked layout: model above, dialogue below, each scrolled by the wheel under the pointer.
if wheel(10, 6, False, 4): capture('narrow-model-wheel-80x24', 80, 24)
if wheel(10, 15, True, 4): capture('narrow-chat-wheel-80x24', 80, 24)
send(CTRL_O); send(CTRL_END)
# A highlighted row below the fold is revealed by the first Enter and opened by the second.
send('select submit-handler\r'); capture('narrow-claim-80x24', 80, 24)
send(ENTER); capture('narrow-claim-reveal-80x24', 80, 24)
send(ENTER); capture('narrow-evidence-80x24', 80, 24)
send(LEFT); send(CTRL_O)
resize(160, 48); capture('wide-focused-160x48', 160, 48)
send('select flow-order\r'); capture('wide-claim-160x48', 160, 48)
send(ENTER); capture('wide-evidence-160x48', 160, 48)
send(LEFT); send(CTRL_O)
if wheel(120, 20, True, 3): capture('wide-chat-wheel-160x48', 160, 48)
send(CTRL_END)
send('\x1b'); focus_roundtrip('large', 160, 48)
command('/understand ask FAIL_NATIVE'); drain(3); capture('native-failure-cleanup-160x48', 160, 48)
command('/reload'); drain(1); command('/understand open'); send('\x1b[6~' * 10); capture('reload-restored-160x48', 160, 48)
# The implementation agent proposes a target while the learner is in wide view.
command('/understand close')
command('QA_TARGET_DELAY'); send('/understand wide\r'); send('draft-to-preserve'); drain(3)
capture('ai-target-confirm-visible-160x48', 160, 48)
send('\x1b'); drain(.8); capture('ai-target-cancel-restored-160x48', 160, 48)
send('\x1b'); command('QA_TARGET_DELAY'); send('/understand wide\r'); drain(3)
capture('ai-target-accept-visible-160x48', 160, 48)
send('\r'); drain(1); capture('ai-target-changed-160x48', 160, 48)
# Long model claims (twenty-paragraph detail beyond the 80x24 model viewport): ↓/↑ and Shift+↓ read every
# paragraph continuously, with no selectable row (long-plain) and with controls after the detail (long-controls).
SHIFT_DOWN, SHIFT_UP = '\x1b[1;2B', '\x1b[1;2A'
(WORK / 'src/long-claim.ts').write_text('// LONG_CLAIM_FIXTURE\nexport const longClaim = "readable";\n')
def wait_for(needle, mark, seconds=20):
    # State-aware wait: bytes rendered since mark must contain the needle, else fail rather than capture a stale frame.
    deadline = time.time() + seconds
    while needle.encode() not in raw[mark:]:
        if time.time() > deadline: raise RuntimeError('timed out waiting for ' + needle)
        drain(.2)
resize(80, 24)
# The generation row itself is covered by the standard model stages; here the explicit command is awaited until the
# generated claims actually render, then long-plain is opened explicitly.
command('/understand scope changes'); drain(1)
mark = len(raw); command('/understand model'); wait_for('長い推論の主張は操作がなくても', mark); capture('long-claim-overview-80x24', 80, 24)
command('/understand select long-plain')
# The previous scope-cancellation case deliberately left a preserved learner draft.
# Clear it through native Input before testing Enter as navigation, not question submission.
send('\x15'); capture('long-claim-plain-00-80x24', 80, 24)
# Six lines per capture is less than the nine-row model viewport, so every rendered line lands in some capture.
for i in range(1, 17): send(DOWN * 6); capture(f'long-claim-plain-{i:02d}-80x24', 80, 24)
send(UP * 120); drain(1); capture('long-claim-plain-top-80x24', 80, 24)
send(CTRL_O); send(DOWN); send(ENTER); capture('long-claim-controls-00-80x24', 80, 24)
for i in range(1, 19): send(DOWN * 6); capture(f'long-claim-controls-{i:02d}-80x24', 80, 24)
send(UP); capture('long-claim-controls-evidence-row-80x24', 80, 24)
send(ENTER); capture('long-claim-controls-evidence-80x24', 80, 24)
send(LEFT); capture('long-claim-controls-back-80x24', 80, 24)
send(UP); send(UP); capture('long-claim-controls-skip-row-80x24', 80, 24)
send(ENTER); capture('long-claim-controls-skipped-80x24', 80, 24)
send(CTRL_O); send(UP); send(ENTER); capture('long-claim-page-00-80x24', 80, 24)
for i in range(1, 13): send(SHIFT_DOWN); capture(f'long-claim-page-{i:02d}-80x24', 80, 24)
resize(120, 36); send(SHIFT_UP * 20); drain(1); send(DOWN * 30); drain(1); capture('long-claim-middle-120x36', 120, 36)
send('\x1b'); command('/qa-exit'); drain(.7)
try: process.wait(timeout=5)
except subprocess.TimeoutExpired: process.terminate(); process.wait(timeout=5); raise RuntimeError('PTY orderly shutdown timed out')
os.close(master)
# Preserve this run's trace even when a following contract assertion fails.
(OUT / 'pty.ansi').write_bytes(raw)
(OUT / 'stages.json').write_text(json.dumps(stages, ensure_ascii=False, indent=2))
# Check the session's persisted user ownership, not just a focus label/render mock.
pty_sessions = []
for path in (OUT / 'config' / 'sessions').rglob('*.jsonl'):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if any(row.get('id') == 'understanding-pty-qa' for row in rows): pty_sessions = rows; break
assert pty_sessions, 'PTY session not found'
learning_states = [row['data'] for row in pty_sessions if row.get('customType') == ENTRY]
learner_users = {turn['text'] for state in learning_states for learning in state['scopes'].values() for turn in learning['turns'] if turn['role'] == 'user'}
main_users = {msg['content'][0]['text'] if isinstance(msg['content'], list) else msg['content'] for row in pty_sessions if row.get('type') == 'message' and (msg := row['message']).get('role') == 'user'}
for probe in learner_probes:
    assert probe in learner_users and probe not in main_users, ('learner routing', probe, learner_users, main_users)
for probe in main_probes:
    assert probe in main_users and probe not in learner_users, ('main routing', probe, learner_users, main_users)
# Model ownership state persisted by the real extension (not a render mock).
model_states = [learning for state in learning_states for learning in state['scopes'].values() if learning.get('claims')]
assert model_states, 'explicit model generation did not persist claims'
FIXTURE_IDS = ['submit-handler', 'literal-result', 'validate-boundary', 'flow-order', 'why-literal']
final_model = [m for m in model_states if m['claims'][0]['id'] == 'submit-handler'][-1]
assert [c['id'] for c in final_model['claims']] == FIXTURE_IDS, final_model['claims']
# The long-claim model is a separate fixed target; its claims keep the supported long shape.
long_models = [m for m in model_states if [c['id'] for c in m['claims']] == ['long-plain', 'long-controls']]
assert long_models, 'long-claim model not generated'
long_plain = long_models[-1]['claims'][0]
assert long_plain['status'] == 'inferred' and not long_plain.get('signature') and not long_plain.get('tests') and not long_plain.get('challenge') and long_plain['evidence'] == [] and long_plain['relations'] == [], long_plain
assert len(long_plain['detail']) <= 2000 and len(long_plain['detail'].split('\n\n')) == 20, len(long_plain['detail'])
assert 'long-controls' in (long_models[-1].get('skippedChallenges') or []), 'skip after the long detail not persisted'
assert any(t['role'] == 'notice' and t['text'].startswith('固定根拠取得 1/2') for learning in model_states for t in learning['turns']), 'bounded retrieval round not recorded'
assert any(r.get('status') == 'fetched' for learning in model_states for t in learning['turns'] for r in (t.get('read') or [])), 'fetched evidence not recorded'
assert 'submit-handler' in (final_model.get('skippedChallenges') or []), 'skipped challenge not persisted'
assert final_model.get('questions') is True and not final_model.get('proposal'), 'questions on / proposal clear not persisted'
assert any('保存上限のため以前の' in t['text'] for learning in model_states for t in learning['turns']), 'retention trimming not exercised'
(OUT / 'model-state.json').write_text(json.dumps({'claims': [c['id'] for c in final_model['claims']], 'skippedChallenges': final_model.get('skippedChallenges'), 'questions': final_model.get('questions')}, ensure_ascii=False, indent=2))
(OUT / 'focus-routing.json').write_text(json.dumps({'learner_probes': learner_probes, 'main_probes': main_probes, 'learner_users': sorted(learner_users), 'main_users': sorted(main_users)}, ensure_ascii=False, indent=2))
source_hash = hashlib.sha256(b''.join(p.read_bytes() for p in sorted((ROOT / 'src').glob('*.ts')))).hexdigest()
(OUT / 'summary.json').write_text(json.dumps({'pi': PI, 'source_sha256': source_hash, 'raw_package_has_node_modules': (RAW / 'node_modules').exists(), 'rpc_exit': proc.returncode, 'pty_exit': process.returncode, 'tui_mode': MODE, 'fixture_head': HEAD, 'stages': len(stages), 'wheel_events': wheel_events, 'wheel': 'SGR wheel reports injected (fullscreen routes them to components)' if MODE == 'fullscreen' else 'not exercised: regular mode leaves the wheel to terminal scrollback per Pi docs; PgUp/PgDn are the pane scroll path', 'unverified': 'physical IME, real terminals/multiplexers (Ghostty, mosh, herdr), live inference quality and learning outcomes', 'inference': 'deterministic native Pi provider fixture only; no paid/network inference'}, ensure_ascii=False, indent=2))
print(json.dumps({'rpc': 'passed loader/separation/clone/switch/cancellation checks', 'pty_exit': process.returncode, 'stages': len(stages), 'evidence': str(OUT)}))
