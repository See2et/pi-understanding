// QA-only ANSI replay. Requires `npm install --no-save @xterm/headless@6.0.0` alongside matching Pi peers.
import xterm from '@xterm/headless';
import { readFile, writeFile } from 'node:fs/promises';
const { Terminal } = xterm;
const root = new URL(process.argv[2] === 'regular' ? '../.evidence/native-qa-regular/' : '../.evidence/native-qa/', import.meta.url);
const stages = JSON.parse(await readFile(new URL('stages.json', root), 'utf8'));
const raw = await readFile(new URL('pty.ansi', root));
const terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true, scrollback: 5000 });
let start = 0;
const escape = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const checks = [];
for (const stage of stages) {
  terminal.resize(stage.cols, stage.rows);
  await new Promise(resolve => terminal.write(raw.subarray(start, stage.end), resolve));
  start = stage.end;
  const buffer = terminal.buffer.active;
  let html = '', text = '';
  for (let row = 0; row < stage.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    text += (line?.translateToString(true) ?? '') + '\n';
    html += '<div class="row">';
    for (let col = 0; col < stage.cols; col++) {
      const cell = line?.getCell(col);
      if (cell?.getWidth() === 0) continue;
      const fg = cell?.isFgRGB() ? '#' + cell.getFgColor().toString(16).padStart(6, '0') : '#e4e7eb';
      const bg = cell?.isBgRGB() ? '#' + cell.getBgColor().toString(16).padStart(6, '0') : '#101318';
      html += `<span style="color:${fg};background:${bg};font-weight:${cell?.isBold() ? 'bold' : 'normal'};width:${(cell?.getWidth() || 1) * 10}px">${escape(cell?.getChars() || ' ')}</span>`;
    }
    html += '</div>';
  }
  const cursor = `<div class="cursor" style="left:${buffer.cursorX * 10}px;top:${buffer.cursorY * 20}px"></div>`;
  await writeFile(new URL(`${stage.name}.txt`, root), text);
  await writeFile(new URL(`${stage.name}.html`, root), `<!doctype html><meta charset="utf-8"><title>${escape(stage.name)}</title><style>body{margin:0;background:#101318;color:#e4e7eb}.terminal{position:relative;width:${stage.cols * 10}px;height:${stage.rows * 20}px;font:16px/20px "Noto Sans Mono CJK JP","DejaVu Sans Mono",monospace}.row{height:20px;white-space:pre}.row span{display:inline-block;vertical-align:top}.cursor{position:absolute;height:18px;width:9px;border-bottom:2px solid #e4e7eb;pointer-events:none}</style><main class="terminal">${html}${cursor}</main>`);
  checks.push({ stage: stage.name, scopeHeaderVisible: text.includes('snapshot'), scopeIdentity: text.match(/scope ([0-9a-f]{8})/)?.[1], confirmationVisible: text.includes('この固定範囲') && text.includes('snapshot') && !text.includes('理解 /'), draftVisible: text.includes('draft-to-preserve'), changesVisible: text.includes('未commit分 / HEAD'), mapVisible: text.includes('送信する') && text.includes('submit()'), japaneseInputVisible: text.includes('質問：責任'), mainInputVisible: text.includes('main-input-still-active'), mainChatVisible: text.includes('main-chat-probe'), abortedVisible: text.includes('aborted'), failureVisible: text.includes('deterministic native provider failure'), cursor: { x: buffer.cursorX, y: buffer.cursorY } });
}
const byName = name => checks.find(c => c.stage === name);
const textAt = async name => readFile(new URL(`${name}.txt`, root), 'utf8');
const focusChecks = [];
for (const label of ['wide', 'narrow', 'large']) {
  const learning = await textAt('shortcut-learner-' + label);
  const main = await textAt('shortcut-main-' + label);
  const preserved = await textAt('shortcut-preserved-' + label);
  const ok = learning.includes('学習 > learner-draft-' + label) && main.includes('main-draft-' + label + '-tail') && preserved.includes('学習 > learner-draft-' + label + '-tail');
  focusChecks.push({ label, ok });
}
if (process.argv[2] !== 'regular') {
  for (const label of ['side-120x36', 'wide-120x36', 'narrow-80x24']) {
    const learning = await textAt('click-focus-' + label);
    const main = await textAt('click-main-' + label);
    const preserved = await textAt('click-preserved-' + label);
    focusChecks.push({ label: 'fullscreen-mouse-' + label, ok:
      learning.includes('学習 > mouse-learner-' + label) &&
      main.includes('mouse-main-' + label + '-tail') &&
      (label.startsWith('narrow') ? !main.includes('snapshot') : main.includes('通常チャットに入力')) &&
      preserved.includes('学習 > mouse-learner-' + label + '-tail') });
  }
}
focusChecks.push({ label: 'command-focus', ok: (await textAt('command-focus-input-120x36')).includes('学習 > command-focus-probe') });
await writeFile(new URL('focus-render-checks.json', root), JSON.stringify(focusChecks, null, 2));
const required = [
  ...focusChecks.map(check => check.ok),
  byName('typical-background-120x36')?.scopeHeaderVisible,
  (await readFile(new URL('wide-first-input-120x36.txt', root), 'utf8')).includes('学習 > wide-first-probe'),
  byName('grounded-map-120x36')?.mapVisible,
  byName('main-input-background-120x36')?.mainInputVisible,
  byName('japanese-focused-120x36')?.japaneseInputVisible,
  byName('japanese-focused-120x36')?.cursor.x > 65,
  byName('main-chat-operational-120x36')?.mainChatVisible,
  byName('cancelled-learning-120x36')?.abortedVisible,
  byName('narrow-background-hidden-80x24')?.scopeHeaderVisible === false,
  byName('narrow-focus-fallback-80x24')?.scopeHeaderVisible,
  byName('narrow-focus-fallback-80x24')?.cursor.x > 0,
  byName('wide-focused-160x48')?.scopeHeaderVisible,
  byName('native-failure-cleanup-160x48')?.failureVisible,
  byName('reload-restored-160x48')?.failureVisible,
  byName('ai-target-confirm-visible-160x48')?.confirmationVisible,
  byName('ai-target-cancel-restored-160x48')?.scopeIdentity === byName('reload-restored-160x48')?.scopeIdentity,
  byName('ai-target-cancel-restored-160x48')?.changesVisible === false,
  byName('ai-target-cancel-restored-160x48')?.draftVisible,
  byName('ai-target-accept-visible-160x48')?.confirmationVisible,
  byName('ai-target-changed-160x48')?.changesVisible,
];
if (!required.every(Boolean)) throw new Error(`Rendered interaction assertion failed: ${JSON.stringify(required)}`);
await writeFile(new URL('render-checks.json', root), JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
terminal.dispose();
