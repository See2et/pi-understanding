// QA-only ANSI replay. Requires `npm install --no-save @xterm/headless@6.0.0` alongside matching Pi peers.
import xterm from '@xterm/headless';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const { Terminal } = xterm;
const mode = process.argv[2] === 'regular' ? 'regular' : 'fullscreen';
const root = new URL(mode === 'regular' ? '../.evidence/native-qa-regular/' : '../.evidence/native-qa/', import.meta.url);
const stages = JSON.parse(await readFile(new URL('stages.json', root), 'utf8'));
const raw = await readFile(new URL('pty.ansi', root));
const terminal = new Terminal({ cols: 120, rows: 36, allowProposedApi: true, scrollback: 5000 });
let start = 0;
const escape = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const checks = [];
const texts = new Map();
const hashes = {};
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
  texts.set(stage.name, text);
  // Commit/scope hashes come from the runtime fixture repository; normalize them so hashes compare layouts.
  hashes[stage.name] = createHash('sha256').update(text.replace(/[0-9a-f]{8,}/g, '<hex>')).digest('hex');
  await writeFile(new URL(`${stage.name}.txt`, root), text);
  await writeFile(new URL(`${stage.name}.html`, root), `<!doctype html><meta charset="utf-8"><title>${escape(stage.name)}</title><style>body{margin:0;background:#101318;color:#e4e7eb}.terminal{position:relative;width:${stage.cols * 10}px;height:${stage.rows * 20}px;font:16px/20px "Noto Sans Mono CJK JP","DejaVu Sans Mono",monospace}.row{height:20px;white-space:pre}.row span{display:inline-block;vertical-align:top}.cursor{position:absolute;height:18px;width:9px;border-bottom:2px solid #e4e7eb;pointer-events:none}</style><main class="terminal">${html}${cursor}</main>`);
  checks.push({ stage: stage.name, paneVisible: text.includes('理解 · '), scopeIdentity: text.match(/scope ([0-9a-f]{8})/)?.[1], confirmationVisible: text.includes('この固定範囲') && text.includes('snapshot') && !text.includes('理解 · '), draftVisible: text.includes('draft-to-preserve'), changesVisible: text.includes('未commit分 / HEAD'), interactionActionVisible: text.includes('相互作用図をブラウザで開く'), japaneseInputVisible: text.includes('質問：責任'), mainInputVisible: text.includes('main-input-still-active'), mainChatVisible: text.includes('main-chat-probe'), abortedVisible: text.includes('aborted'), failureVisible: text.includes('deterministic native provider failure'), cursor: { x: buffer.cursorX, y: buffer.cursorY } });
}
const byName = name => checks.find(c => c.stage === name);
const textAt = name => { const text = texts.get(name); if (text === undefined) throw new Error(`Missing stage ${name}`); return text; };
const has = (name, ...needles) => needles.every(n => textAt(name).includes(n));
const lacks = (name, ...needles) => needles.every(n => !textAt(name).includes(n));
const above = name => Number(textAt(name).match(/↑(\d+)行/)?.[1] ?? NaN);
const focusChecks = [];
for (const label of ['wide', 'narrow', 'large']) {
  const learning = textAt('shortcut-learner-' + label);
  const main = textAt('shortcut-main-' + label);
  const preserved = textAt('shortcut-preserved-' + label);
  const ok = learning.includes('学習 > learner-draft-' + label) && main.includes('main-draft-' + label + '-tail') && preserved.includes('学習 > learner-draft-' + label + '-tail');
  focusChecks.push({ label, ok });
}
focusChecks.push({ label: 'Ctrl+D-preserves-both-drafts', ok: has('closed-draft-main-120x36', 'main-close-draft-tail') && lacks('closed-draft-main-120x36', '理解 · ') && has('closed-draft-learner-120x36', '学習 > learner-close-draft-tail') });
focusChecks.push({ label: 'Alt+S-preserves-both-drafts', ok: has('alts-main-120x36', 'alt-s-main-draft') && lacks('alts-main-120x36', '理解 · ') && has('alts-learner-120x36', '学習 > alt-s-learner-draft-tail') });
focusChecks.push({ label: 'retired-map-hidden-claim-evidence-return', ok: lacks('retired-map-120x36', '旧マップ', 'M1 送信する') && has('claim-fixed-evidence-120x36', 'return "working"', '全体 › submit-handler') && has('claim-overview-return-120x36', 'submit() は結果文字列を返す入口です') && lacks('claim-overview-return-120x36', '旧マップ', '▶M1') });
focusChecks.push({ label: 'near-fullscreen-display', ok: textAt('japanese-focused-120x36').split('\n').some(line => line.includes('╭─ 理解 · ') && line.includes('─╮')) && textAt('japanese-focused-120x36').split('\n').some(line => line.includes('╰─ ') && line.includes('─╯')) });
focusChecks.push({ label: 'command-focus', ok: has('command-focus-input-120x36', '学習 > command-focus-probe') });
await writeFile(new URL('focus-render-checks.json', root), JSON.stringify(focusChecks, null, 2));
// Model ownership traversal, optional questions, hypotheses and independent scrolling.
const modelChecks = [
  ['empty-model-has-explicit-generation', has('model-empty-120x36', 'モデルはまだありません', 'モデルを生成する（GPT呼出し）')],
  ['generated-overview-first-claim', has('model-overview-120x36', '▸ 現状 submit() は結果文字列を返す入口です', '概念 1', '理由 1', '推論 ')],
  ['tab-moves-highlight', has('model-tab-120x36', '▸ 現状 結果は固定文字列で')],
  ['enter-opens-claim', has('model-claim-120x36', '全体 › 概念 › submit-handler', '問い（任意', '1 署名', '2 根拠', '宛先 submit-handler')],
  ['enter-opens-signature-evidence', has('model-evidence-120x36', '署名 · worktree:src/main.ts:1-1', '1 │ export function submit()', '引用は主張の正しさを証明しません')],
  ['tab-next-evidence', has('model-evidence-next-120x36', '根拠 · worktree:src/main.ts:1-1', '根拠 2/2')],
  ['left-returns-to-claim', has('model-back-claim-120x36', '▸ 2 根拠', '全体 › 概念 › submit-handler')],
  ['skip-is-optional', has('model-skip-120x36', 'この問いはスキップしました') && lacks('model-skip-120x36', 'submit() が例外を投げる')],
  ['ctrl-o-overview', has('model-ctrl-o-120x36', '▸ 現状 submit()', '全体 · モデル')],
  ['proposal-is-hypothesis', has('proposal-120x36', '仮説 · 未実装の変更案', '仮説あり', 'あなた · 変更案（仮説として相談）')],
  ['proposal-cleared', lacks('proposal-cleared-120x36', '仮説あり', '仮説 · 未実装')],
  ['quiet-hides-questions', has('quiet-120x36', '問いオフ', '問いは非表示中 · 再開する', '全体 › 振る舞い › flow-order')],
  ['questions-on-restores', has('questions-on-120x36', 'この問いをスキップ') && lacks('questions-on-120x36', '問いオフ')],
  ['claim-scoped-question', has('claim-question-120x36', '宛先 flow-order', 'このフローで validate を飛ばすと？')],
  ['long-follows-latest', has('long-latest-120x36', 'LONG-3-END', '最新 · ')],
  ['pgup-moves-up', /↑\d+行 ↓\d+行/.test(textAt('long-pgup-120x36')) && lacks('long-pgup-120x36', 'LONG-3-END')],
  ['retained-top-notice', has('long-top-120x36', '保存上限のため以前の', '↑0行')],
  ['reading-held-during-output', has('reading-while-streaming-120x36', '新着') && lacks('reading-while-streaming-120x36', 'SLOW-END') && /↑\d+行/.test(textAt('reading-while-streaming-120x36'))],
  ['ctrl-end-follows', has('stream-followed-120x36', 'SLOW-END')],
  ['narrow-claim-stacked', has('narrow-claim-80x24', '全体 › 概念 › submit-handler', 'submit() は結果文字列を返す入口です')],
  ['narrow-enter-reveals-before-acting', has('narrow-claim-reveal-80x24', '▸ 1 署名') && lacks('narrow-claim-reveal-80x24', '引用は主張の正しさ')],
  ['narrow-evidence', has('narrow-evidence-80x24', '署名 · worktree:src/main.ts:1-1')],
  ['wide-claim', has('wide-claim-160x48', '全体 › 振る舞い › flow-order', 'validate を飛ばすと結果はどう変わると予測しますか？', 'この問いをスキップ')],
  ['wide-evidence', has('wide-evidence-160x48', '根拠 · worktree:README.md:2-2', 'User flow: submit -> validate -> result')],
];
// Long claims: every paragraph's start/end marker is rendered, in reading order, including middle-only frames.
const LONG = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, '0')).flatMap(n => [`P${n}始`, `P${n}終`]);
const series = prefix => stages.filter(s => new RegExp(`^${prefix}-\\d\\d-80x24$`).test(s.name)).map(s => textAt(s.name));
const readsAll = frames => { const first = LONG.map(m => frames.findIndex(f => f.includes(m))); return first.every((v, i) => v >= 0 && (i === 0 || v >= first[i - 1])); };
const middleOnly = frames => frames.some(f => f.includes('P10始') && !f.includes('P01始') && !f.includes('P20終'));
const plain = series('long-claim-plain'); const controls = series('long-claim-controls'); const pages = series('long-claim-page');
const firstControl = controls.findIndex(f => f.includes('▸ '));
modelChecks.push(
  ['long-claim-overview', has('long-claim-overview-80x24', '▸ 推論 長い推論の主張は操作がなくても', '長い主張の後ろの操作は')],
  ['long-claim-plain-opens-at-top', plain.length === 17 && has('long-claim-plain-00-80x24', '全体 › 概念 › long-plain', 'P01始', '↑0行 ↓', 'Shift+↑↓ ページ', '↑↓ 読む', 'Alt+S 閉じる') && lacks('long-claim-plain-00-80x24', 'P20終')],
  ['long-claim-plain-reads-every-paragraph', readsAll(plain) && middleOnly(plain)],
  ['long-claim-plain-reaches-end', plain.at(-1).includes('P20終') && plain.at(-1).includes(' ↓0行')],
  ['long-claim-plain-up-returns-to-top', has('long-claim-plain-top-80x24', '長い推論の主張は操作がなくても', 'P01始', '↑0行 ↓')],
  ['long-claim-controls-read-before-controls', controls.length === 19 && firstControl > 0 && readsAll(controls.slice(0, firstControl + 1)) && middleOnly(controls.slice(0, firstControl + 1))],
  ['long-claim-controls-reach-relation', controls.at(-1).includes('▸ 理由づけ → long-plain')],
  ['long-claim-controls-evidence-opens', has('long-claim-controls-evidence-row-80x24', '▸ 1 根拠') && has('long-claim-controls-evidence-80x24', 'src/long-claim.ts:2-2', 'export const longClaim')],
  ['long-claim-controls-back-reveals-row', has('long-claim-controls-back-80x24', '全体 › ルール › long-controls', '▸ 1 根拠')],
  ['long-claim-controls-skip', has('long-claim-controls-skip-row-80x24', '▸ この問いをスキップ') && has('long-claim-controls-skipped-80x24', 'この問いはスキップしました')],
  ['long-claim-shift-page-reads-every-paragraph', pages.length === 13 && readsAll(pages) && has('long-claim-page-00-80x24', '全体 › 概念 › long-plain')],
  ['long-claim-wide-middle', has('long-claim-middle-120x36', '全体 › 概念 › long-plain') && lacks('long-claim-middle-120x36', 'P01始', 'P20終') && LONG.filter(m => textAt('long-claim-middle-120x36').includes(m)).length >= 6],
);
if (mode === 'fullscreen') modelChecks.push(
  ['wheel-scrolls-dialogue-up', above('long-wheel-chat-120x36') < above('long-pgup-120x36')],
  ['wheel-scrolls-model-only', has('narrow-focus-fallback-80x24', '送信から結果までの小さな流れ') && lacks('narrow-model-wheel-80x24', '送信から結果までの小さな流れ') && textAt('narrow-model-wheel-80x24').match(/最新 · [^\n─]*/)?.[0] === textAt('narrow-focus-fallback-80x24').match(/最新 · [^\n─]*/)?.[0]],
  ['narrow-wheel-scrolls-dialogue', /↑\d+行/.test(textAt('narrow-chat-wheel-80x24'))],
  ['wide-wheel-scrolls-dialogue', /↑\d+行/.test(textAt('wide-chat-wheel-160x48'))],
  ['fullscreen-hints-wheel', has('long-latest-120x36', 'ホイール/PgUp で遡る')],
);
else modelChecks.push(
  ['regular-promises-no-wheel', has('long-latest-120x36', '最新 · PgUp で遡る') && lacks('long-latest-120x36', 'ホイール')],
  ['regular-wheel-not-exercised', !stages.some(s => s.name.includes('wheel'))],
);
await writeFile(new URL('model-render-checks.json', root), JSON.stringify(modelChecks.map(([label, ok]) => ({ label, ok: !!ok })), null, 2));
const required = [
  ...focusChecks.map(check => check.ok),
  ...modelChecks.map(([, ok]) => ok),
  byName('typical-background-120x36')?.paneVisible,
  textAt('wide-first-input-120x36').includes('学習 > wide-first-probe'),
  byName('retired-map-120x36')?.interactionActionVisible,
  byName('main-input-background-120x36')?.mainInputVisible,
  byName('main-input-background-120x36')?.paneVisible === false,
  byName('japanese-focused-120x36')?.japaneseInputVisible,
  byName('japanese-focused-120x36')?.cursor.x > 20,
  byName('main-chat-operational-120x36')?.mainChatVisible,
  byName('cancelled-learning-120x36')?.abortedVisible,
  byName('narrow-background-hidden-80x24')?.paneVisible === false,
  byName('narrow-focus-fallback-80x24')?.paneVisible,
  byName('narrow-focus-fallback-80x24')?.cursor.x > 0,
  byName('wide-focused-160x48')?.paneVisible,
  byName('native-failure-cleanup-160x48')?.failureVisible,
  byName('reload-restored-160x48')?.failureVisible,
  byName('ai-target-confirm-visible-160x48')?.confirmationVisible,
  byName('ai-target-cancel-restored-160x48')?.scopeIdentity === byName('reload-restored-160x48')?.scopeIdentity,
  byName('ai-target-cancel-restored-160x48')?.changesVisible === false,
  byName('ai-target-cancel-restored-160x48')?.draftVisible,
  byName('ai-target-accept-visible-160x48')?.confirmationVisible,
  byName('ai-target-changed-160x48')?.changesVisible,
];
await writeFile(new URL('render-checks.json', root), JSON.stringify(checks, null, 2));
await writeFile(new URL('render-hashes.json', root), JSON.stringify({ normalization: 'sha256 of replayed text grid with [0-9a-f]{8,} replaced by <hex>', hashes }, null, 2));
if (!required.every(Boolean)) throw new Error(`Rendered interaction assertion failed: ${JSON.stringify({ required, failedModelChecks: modelChecks.filter(([, ok]) => !ok).map(([label]) => label), failedFocusChecks: focusChecks.filter(c => !c.ok).map(c => c.label) })}`);
console.log(JSON.stringify({ mode, stages: checks.length, modelChecks: modelChecks.length, focusChecks: focusChecks.length }, null, 2));
terminal.dispose();
