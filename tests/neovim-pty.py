#!/usr/bin/env python3
"""No-config real Pi/Neovim/Pi PTY roundtrip. Isolated fixture config/repository; no inference/auth.
Run PI_UNDERSTANDING_TUI_MODE=regular as well as the default fullscreen.
"""
import os, subprocess, json, time, pathlib, shutil, hashlib, pty, fcntl, termios, struct, signal, select
ROOT = pathlib.Path(__file__).resolve().parents[1]
MODE = os.environ.get('PI_UNDERSTANDING_TUI_MODE', 'fullscreen')
assert MODE in ('fullscreen', 'regular')
OUT = ROOT / '.evidence/neovim-zero-config' / MODE
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'summary.json').unlink(missing_ok=True)
for directory in ('config', 'workspace'):
    if (OUT / directory).exists(): shutil.rmtree(OUT / directory)
WORK = OUT / 'workspace'; WORK.mkdir(); (WORK / 'src').mkdir()
SOURCE = 'export function submit() { return "PINNED_RESULT"; }\n// OUTSIDE_SELECTED_RANGE\nexport const outside = "WHOLE_FIXED_FILE";\n'
(WORK / 'src/main.ts').write_text(SOURCE)
(WORK / 'README.md').write_text('# Fixture\nUser flow: submit -> validate -> result\n')
def git(*args): return subprocess.check_output(['git', *args], cwd=WORK, text=True).strip()
git('init', '-q'); git('add', '.'); git('-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-qm', 'PTY fixture')
ENV = {**os.environ, 'PI_CODING_AGENT_DIR': str(OUT / 'config'), 'PI_OFFLINE': '1', 'PI_TELEMETRY': '0', 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'XDG_CONFIG_HOME': str(OUT / 'xdg/config'), 'XDG_DATA_HOME': str(OUT / 'xdg/data'), 'XDG_STATE_HOME': str(OUT / 'xdg/state'), 'NVIM_LOG_FILE': str(OUT / 'nvim.log')}
for key in ('PI_UNDERSTANDING_NVIM_SERVER', 'PI_UNDERSTANDING_NVIM_TERMINAL', 'PI_UNDERSTANDING_NVIM_BINARY'): ENV.pop(key, None)
# Unrelated remote desktop variables must not select a GUI launcher.
ENV['DISPLAY'] = ':9999'; ENV['WAYLAND_DISPLAY'] = 'unrelated-server-desktop'
PI = os.environ.get('PI_UNDERSTANDING_BINARY', '/nix/store/rpga5vi5495pglblk0b57bcvrrp68dxz-pi-coding-agent-1.0.4/libexec/pi/pi')
ARGS = [PI, '--offline', '--no-approve', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--tools', '', '-e', str(ROOT), '-e', str(ROOT / 'tests/fixture-provider.ts'), '--model', 'understanding-qa/gpt-qa', '--thinking', 'off', '--tui-mode', MODE]
master, slave = pty.openpty(); fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
process = subprocess.Popen(ARGS, cwd=WORK, env=ENV, stdin=slave, stdout=slave, stderr=slave, start_new_session=True); os.close(slave)
raw = bytearray(); stages = []; handoffs = []
def drain(seconds=.4):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        ready, _, _ = select.select([master], [], [], min(.1, max(0, until - time.monotonic())))
        if ready:
            try: block = os.read(master, 65536)
            except OSError: return
            if not block: return
            raw.extend(block)
def send(text): os.write(master, text.encode()); drain()
def wait(needle, mark, seconds=20):
    until = time.monotonic() + seconds
    while needle.encode() not in raw[mark:]:
        if process.poll() is not None or time.monotonic() > until: raise RuntimeError('PTY wait failed: ' + needle)
        drain(.2)
def capture(name): stages.append({'name': name, 'end': len(raw), 'cols': 120, 'rows': 36})
def command(text): send('\x1b'); send(text + '\r')
def session_entries():
    files = list((OUT / 'config/sessions').rglob('*.jsonl'))
    assert len(files) == 1, files
    return [json.loads(line) for line in files[0].read_text().splitlines()]
def state(): return [e['data'] for e in session_entries() if e.get('customType') == 'see2et.pi-understanding.v2'][-1]
def observe(name):
    report = OUT / (name + '.json'); report.unlink(missing_ok=True)
    # Trusted fixed QA code inspects the actual interactive Neovim buffer and extmarks. No server/RPC.
    lua = 'local b=vim.api.nvim_get_current_buf(); local d={pid=vim.fn.getpid(), handoff=vim.env.PI_UNDERSTANDING_NVIM_HANDOFF, source=table.concat(vim.api.nvim_buf_get_lines(b,0,-1,false),"\\n"), identity=vim.b.pi_understanding_identity, evidence=vim.b.pi_understanding_evidence, readonly=vim.bo.readonly, modifiable=vim.bo.modifiable, annotations=vim.api.nvim_buf_get_extmarks(b,vim.api.nvim_get_namespaces()["pi-understanding-annotations"],0,-1,{details=true})}; vim.fn.writefile({vim.json.encode(d)},' + json.dumps(str(report)) + ')'
    send(':lua ' + lua + '\r')
    until = time.monotonic() + 5
    while not report.exists():
        if time.monotonic() > until: raise RuntimeError('interactive nvim observation missing')
        drain(.2)
    observed = json.loads(report.read_text()); handoffs.append(observed['handoff']); assert observed['source'] == SOURCE, observed
    assert observed['identity']['digest'] == hashlib.sha256(SOURCE.encode()).hexdigest()
    assert observed['evidence'] == {'start': 1, 'end': 1}; assert observed['readonly'] and not observed['modifiable']
    assert len(observed['annotations']) == 1
    assert '固定の結果文字列を返す入口。' in json.dumps(observed['annotations'], ensure_ascii=False)
    return observed
try:
    drain(1.5); command('START_SESSION_FIXTURE'); drain(1)
    command('/u scope repository'); drain(1)
    mark = len(raw); command('/u model'); wait('submit() は結果文字列を返す入口です。', mark)
    command('/u select submit-handler'); command('/u evidence 1'); capture('selected-evidence')
    before = state(); selected = before['scopes'][before['active']]['evidenceView']; assert selected['annotations']
    # Source changed AFTER pinning: Neovim must show captured bytes, not this live file.
    (WORK / 'src/main.ts').write_text('LIVE_WORKTREE_MUST_NOT_BE_READ\n')
    send('LEARNER_UNSENT'); command('/u nvim'); capture('public-nvim'); observe('public-observation')
    mark = len(raw); send(':qa\r'); wait('理解', mark); capture('public-return')
    assert state() == before
    # Public command returns to the hidden pane and ordinary input; its learning draft is retained.
    send('MAIN_UNSENT'); send('\x1bs'); capture('both-drafts-before')
    mark = len(raw); send('\x1b[110;7u'); wait('WHOLE_FIXED_FILE', mark); capture('shortcut-nvim')
    observe('shortcut-observation'); mark = len(raw); send(':qa\r'); wait('LEARNER_UNSENT', mark); capture('shortcut-return')
    assert state() == before, 'terminal handoff must not persist learning changes'
    send('-AFTER'); send('\x1bs'); send('-AFTER'); capture('main-draft-after'); send('\x1bs'); capture('drafts-after-shortcut')
    mark = len(raw); send('\x1b[110;7u'); wait('WHOLE_FIXED_FILE', mark); observe('failure-observation')
    mark = len(raw); send(':cq\r'); wait('LEARNER_UNSENT-AFTER', mark); capture('failure-return')
    assert state() == before
    mark = len(raw); send('\x1bs'); wait('Neovim exited with code 1', mark); capture('failure-notice'); send('\x1bs')
    mark = len(raw); send('\x1b[110;7u'); wait('WHOLE_FIXED_FILE', mark)
    signalled = observe('signal-observation'); mark = len(raw); os.kill(signalled['pid'], signal.SIGKILL)
    wait('LEARNER_UNSENT-AFTER', mark); capture('signal-return'); assert state() == before
    mark = len(raw); send('\x1bs')
    # Installed distribution wrappers may translate SIGKILL into conventional exit status 128+9.
    deadline = time.monotonic() + 10
    while not any(message.encode() in raw[mark:] for message in ('Neovim terminated by SIGKILL', 'Neovim exited with code 137')):
        if time.monotonic() > deadline: raise RuntimeError('missing signal failure notice')
        drain(.2)
    capture('signal-notice'); send('\x1bs')
    send('-FAILURE_RETURN'); send('\r'); drain(3); send('\x1bs'); send('\r'); drain(1)
    entries = session_entries(); saved = state(); learning = saved['scopes'][saved['active']]
    assert any(t['role'] == 'user' and t['text'] == 'LEARNER_UNSENT-AFTER-FAILURE_RETURN' for t in learning['turns']), learning['turns']
    entries = session_entries(); messages = [e.get('message', {}) for e in entries if e.get('type') == 'message']
    assert any(m.get('role') == 'user' and 'MAIN_UNSENT-AFTER' in json.dumps(m) for m in messages), messages
    assert not any('LEARNER_UNSENT' in json.dumps(m) for m in messages)
    assert (WORK / 'src/main.ts').read_text() == 'LIVE_WORKTREE_MUST_NOT_BE_READ\n'
    command('/qa-exit'); process.wait(timeout=10); drain()
    summary = {'status': 'PASS', 'mode': MODE, 'publicCommand': '/u nvim', 'shortcut': 'Ctrl+Alt+N', 'noServerTerminalOrBinaryOverride': True, 'unrelatedDesktopEnv': True, 'wholePinnedSourceAndRealAnnotations': True, 'bothDraftsAndNavigationRetained': True, 'exitFailureRestored': True, 'signalRestored': True, 'sourceNonmutation': True, 'processExit': process.returncode}
    (OUT / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2)); print(json.dumps(summary, ensure_ascii=False))
finally:
    (OUT / 'terminal.ansi').write_bytes(raw); (OUT / 'stages.json').write_text(json.dumps(stages, indent=2))
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL); process.wait()
    os.close(master)
    for handoff in handoffs: shutil.rmtree(pathlib.Path(handoff).parent, ignore_errors=True)
