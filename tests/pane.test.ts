import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, visibleWidth, type OverlayHandle, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { UnderstandingPane, terminalText, type PaneView } from "../src/pane.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { freshLearning, dive, overview, LearningRunner, type Learning } from "../src/learning.ts";
import { selectClaim, openClaimEvidence, modelBack, skipChallenge, type Claim } from "../src/model.ts";
import { hash, type Scope } from "../src/scope.ts";
import fixture, { longDetail, LONG_MARKERS } from "./fixture-provider.ts";

const code = Array.from({ length: 40 }, (_, i) => `  export function step${i + 1}(value: string) { return value; }`).join("\n");
const source = { path: "src/learning.ts", ref: "worktree", digest: "fixed", text: code };
const ev = (start: number, end: number) => ({ path: source.path, ref: source.ref, start, end, quote: code.split("\n").slice(start - 1, end).join("\n") });
function modelLearning(): Learning {
  const learning = freshLearning({ id: "a1b2c3d4".repeat(8), root: "/fixture/repo", repository: "r", request: { kind: "repository" }, base: "b".repeat(40), head: "c".repeat(40), snapshot: "d".repeat(64), sources: [source], files: [source.path], omitted: 0 } as unknown as Scope);
  learning.modelSummary = "固定した対象から独立した学習会話とモデルを作ります。";
  learning.claims = [
    { id: "scope-identity", kind: "concept", statement: "Scope は固定した理解対象です", status: "fact", evidence: [ev(3, 4)], relations: [] },
    { id: "no-tools", kind: "rule", statement: "学習AIはツールを持ちません", status: "fact", signature: ev(10, 10), tests: [ev(12, 14)], evidence: [ev(20, 22)], relations: [{ to: "why-isolation", type: "explains" }], challenge: "実装AIへ学習会話は返りますか？", detail: "根拠取得は拡張が仲介します。" },
    { id: "uncaptured", kind: "boundary", statement: "未収集ファイルは後から読めません", status: "fact", evidence: [ev(30, 31)], relations: [] },
    { id: "why-isolation", kind: "rationale", statement: "誤解が実装指示へ混ざらないよう分けます", status: "inferred", evidence: [], relations: [{ to: "no-tools", type: "explains" }] },
  ] as Claim[];
  return learning;
}
type Asked = string[];
/** `production` also calls pane.navigate() after each navigation command, as the extension does. */
function mount(learning: Learning | undefined, columns = 120, rows = 36, mode = "fullscreen", view?: PaneView, production = false) {
  initTheme("dark", false);
  const asked: Asked = [];
  const terminal = { columns, rows };
  const tui = { mode, terminal, requestRender: () => {} } as unknown as TUI;
  // The fake host applies the same pure navigation the extension performs for these commands.
  const ask = (text: string) => {
    asked.push(text);
    if (!learning) return;
    if (text === "overview") overview(learning);
    else if (text === "back") { if (learning.selectedPoint) overview(learning); else modelBack(learning); }
    else if (text.startsWith("select ")) { selectClaim(learning, text.slice(7)); learning.selectedPoint = undefined; }
    else if (/^evidence/.test(text)) openClaimEvidence(learning, Number(text.split(" ")[1] ?? 1));
    else if (text === "skip") skipChallenge(learning);
    else if (text === "quiet") learning.questions = false;
    else if (text === "questions on") learning.questions = true;
    else if (text === "proposal clear") learning.proposal = undefined;
    else if (/^dive \d+$/.test(text)) { dive(learning, Number(text.slice(5))); learning.selectedClaim = undefined; learning.evidenceView = undefined; }
    else return;
    if (production) pane.navigate();
  };
  let hidden = false;
  const pane = new UnderstandingPane(tui, theme, () => learning, { ask, cancel: () => {}, close: () => {}, running: () => false }, false, view);
  pane.handle = { focus: () => { pane.focused = true; hidden = false; }, unfocus: () => { pane.focused = false; }, setHidden: (value: boolean) => { hidden = value; }, isHidden: () => hidden } as unknown as OverlayHandle;
  pane.focus();
  const width = Math.floor(columns * .96);
  const frame = () => pane.render(width);
  const text = () => terminalText(frame().join("\n").replaceAll(CURSOR_MARKER, ""));
  return { pane, asked, terminal, frame, text, width, hidden: () => hidden };
}
const rowOf = (lines: string[], needle: string) => lines.findIndex(line => terminalText(line).includes(needle));
const wheel = (x: number, y: number, wheelDelta: number) => ({ type: "wheel", button: "none", x, y, wheelDelta } as TuiMouseEvent);

test("production pane bounds widths/heights, propagates IME focus, accepts Japanese paste, releases focus and cancels independently", () => {
  initTheme("dark", false); assert.ok(theme);
  const learning = freshLearning({ id: "a".repeat(64), root: "/fixture/理解/repo", request: { kind: "repository" }, base: "b".repeat(40), head: "c".repeat(40), snapshot: "d".repeat(64), sources: [], files: [], omitted: 2 } as unknown as Scope);
  let submitted = "", cancelled = false, closed = false, rendered = 0, hidden = false;
  const terminal = { columns: 140, rows: 40 };
  const tui = { terminal, requestRender: () => { rendered++; } } as unknown as TUI;
  const pane = new UnderstandingPane(tui, theme, () => learning, { ask: text => { submitted = text; }, cancel: () => { cancelled = true; }, close: () => { closed = true; }, running: () => false });
  pane.handle = { focus: () => { pane.focused = true; }, unfocus: () => { pane.focused = false; }, setHidden: (value: boolean) => { hidden = value; } } as unknown as OverlayHandle;
  assert.equal(pane.options().nonCapturing, true); assert.equal(pane.focused, false);
  pane.focus(); pane.handleInput("\x1b[200~質問：日本語の入力\x1b[201~");
  const lines = pane.render(58);
  assert.equal(lines.filter(line => line.includes(CURSOR_MARKER)).length, 1, "exactly one IME cursor marker on the native Input row");
  assert.ok(terminalText(lines.find(line => line.includes(CURSOR_MARKER))!).includes("学習 > 質問：日本語の入力"));
  pane.handleInput("\r"); assert.equal(submitted, "質問：日本語の入力");
  for (const [columns, rows] of [[160, 48], [120, 30], [80, 24], [40, 16], [40, 12]]) {
    terminal.columns = columns!; terminal.rows = rows!;
    const width = Math.floor(columns! * .96);
    const frame = pane.render(width);
    assert.ok(frame.every(line => visibleWidth(line) === width), `${columns} column frame must be exactly the overlay width`);
    assert.ok(frame.length <= Math.floor(rows! * .96), `${rows} row overflow`);
  }
  pane.handleInput("\x03"); assert.equal(cancelled, true); assert.equal(closed, false);
  pane.handleInput("\x1b"); assert.equal(pane.focused, false); assert.equal(hidden, true);
  pane.focus(); assert.equal(hidden, false); assert.equal(pane.options().visible!(80, 24), true);
  pane.handleInput("\x04"); assert.equal(closed, true); assert.ok(rendered > 0);
});

test("geometry remount retains the native draft cursor; Alt+S and Ctrl+Alt+U release; only completed primary clicks request focus", () => {
  initTheme("dark", false);
  const tui = { terminal: { columns: 80, rows: 24 }, requestRender: () => {} } as unknown as TUI;
  const actions = { ask: () => {}, cancel: () => {}, close: () => {}, running: () => false };
  const original = new UnderstandingPane(tui, theme, () => undefined, actions, true);
  original.handleInput("abcd"); original.handleInput("\x1b[D"); original.handleInput("\x1b[D");
  const remounted = new UnderstandingPane(tui, theme, () => undefined, actions, true, original.view());
  remounted.handleInput("X"); assert.equal(remounted.view().input, "abXcd", "cursor was not reset to the start/end");
  let released = 0;
  remounted.handle = { unfocus: () => { released++; }, setHidden: () => {} } as unknown as OverlayHandle;
  remounted.handleInput("\x1b[117;7u"); assert.equal(released, 1); assert.equal(remounted.view().input, "abXcd");
  for (const altS of ["\x1bs", "\x1b[115;3u"]) remounted.handleInput(altS);
  assert.equal(released, 3, "Alt+S (legacy and CSI-u) toggles back to the ordinary editor"); assert.equal(remounted.view().input, "abXcd");
  const mouse = { type: "click", button: "left" } as TuiMouseEvent;
  assert.deepEqual(remounted.handleMouse(mouse), { handled: true, focus: true });
  for (const type of ["press", "drag", "release"] as const) assert.equal(remounted.handleMouse({ ...mouse, type }), undefined, `${type} stays with Pi selection`);
  assert.equal(remounted.handleMouse({ ...mouse, button: "right" }), undefined);
  assert.deepEqual(remounted.handleMouse({ ...mouse, type: "wheel", button: "none", wheelDelta: -3 }), { handled: true }, "wheel over the pane never scrolls the transcript behind it");
});

test("near-fullscreen overlay never wraps or replaces the ordinary editor's mouse handler", () => {
  initTheme("dark", false);
  const nativeResult = { handled: true, focus: true };
  const main = { render: () => [], invalidate: () => {}, handleMouse: (event: TuiMouseEvent) => event.type === "click" ? nativeResult : undefined };
  const original = main.handleMouse;
  const tui = { mode: "fullscreen", terminal: { columns: 120, rows: 36 }, requestRender: () => {}, getFocusedComponent: () => main } as unknown as TUI;
  const pane = new UnderstandingPane(tui, theme, () => undefined, { ask: () => {}, cancel: () => {}, close: () => {}, running: () => false });
  let target: unknown;
  pane.handle = { unfocus: (options: { target: unknown }) => { target = options.target; } } as unknown as OverlayHandle;
  assert.equal(main.handleMouse({ type: "press", button: "left" } as TuiMouseEvent), undefined);
  assert.equal(target, undefined);
  assert.equal(main.handleMouse({ type: "click", button: "left" } as TuiMouseEvent), nativeResult);
  assert.equal(target, undefined); assert.equal(main.handleMouse, original);
  pane.dispose(); assert.equal(main.handleMouse, original);
  const regular = new UnderstandingPane({ ...tui, mode: "regular" } as TUI, theme, () => undefined, { ask: () => {}, cancel: () => {}, close: () => {}, running: () => false });
  assert.equal(main.handleMouse, original); regular.dispose();
});

test("untrusted terminal control sequences are not emitted", () => {
  assert.equal(terminalText("hello\x1b[2J\x1b]52;c;secret\x07world"), "helloworld");
  assert.ok(!/[\x80-\x9f]/.test(terminalText("\u009b2J\u009d52;data")));
  const learning = modelLearning();
  learning.claims![0]!.statement = "危険\x1b]52;c;c2VjcmV0\x07な\x1b[2J主張";
  learning.turns.push({ role: "assistant", text: "回答\x1b[31m\u009b2J", timestamp: 1 });
  const { frame } = mount(learning);
  const raw = frame().join("\n");
  assert.doesNotMatch(raw, /\x1b\]52|\x1b\[2J|\u009b/, "model and dialogue text are sanitized before styling");
});

test("empty model shows an explicit generation action; opening never infers and Enter on the action asks once for model", () => {
  const learning = modelLearning(); learning.claims = undefined; learning.modelSummary = undefined;
  const { pane, asked, text } = mount(learning);
  const screen = text();
  assert.match(screen, /モデルはまだありません/); assert.match(screen, /▸ モデルを生成する（GPT呼出し）/); assert.match(screen, /Ctrl\+C で中止/);
  assert.match(screen, /Enter 実行/); assert.deepEqual(asked, [], "rendering/opening performs no inference");
  pane.handleInput("draft"); pane.handleInput("\t"); pane.handleInput("\x1b[B");
  assert.deepEqual(asked, [], "navigation keys with a draft never submit or generate"); assert.equal(pane.view().input, "draft");
  pane.handleInput("\x15"); text(); pane.handleInput("\r");
  assert.deepEqual(asked, ["model"]);
  learning.claims = modelLearning().claims; learning.modelSummary = "生成済み";
  assert.match(text(), /▸ 現状 Scope は固定した理解対象です/, "a newly generated model starts at its first claim");
});

test("model traversal: Tab/arrow selection, Enter opens claim, evidence order signature→tests→evidence, back and Ctrl+O, without dive typing", () => {
  const learning = modelLearning();
  const { pane, asked, text } = mount(learning, 120, 36);
  let screen = text();
  assert.match(screen, /概念 1/); assert.match(screen, /ルール 1/); assert.match(screen, /理由 1/);
  assert.match(screen, /現状 Scope は固定した理解対象です/); assert.match(screen, /推論 誤解が実装指示へ/, "inferred claims are marked as interpretation");
  assert.match(screen, /▸ 現状 Scope/, "first claim is highlighted on open");
  pane.handleInput("\t"); screen = text(); assert.match(screen, /▸ 現状 学習AIはツールを持ちません/);
  pane.handleInput("\x1b[Z"); pane.handleInput("\x1b[B"); text();
  pane.handleInput("\r"); assert.equal(asked.at(-1), "select no-tools"); assert.equal(learning.selectedClaim, "no-tools");
  screen = text();
  assert.match(screen, /全体 › ルール › no-tools/); assert.match(screen, /問い（任意/); assert.match(screen, /実装AIへ学習会話は返りますか？/);
  assert.match(screen, /根拠 3件/);
  assert.ok(screen.indexOf("1 署名") < screen.indexOf("2 テスト") && screen.indexOf("2 テスト") < screen.indexOf("3 根拠"), "signature → tests → evidence");
  assert.match(screen, /▸ 1 署名/, "claim view highlights the first evidence");
  assert.match(screen, /理由づけ → why-isolation/);
  assert.match(screen, /宛先 no-tools「学習AIはツールを持ちません」/);
  pane.handleInput("\t"); text(); pane.handleInput("\r");
  assert.equal(asked.at(-1), "evidence 2"); screen = text();
  assert.match(screen, /テスト · worktree:src\/learning.ts:12-14/); assert.match(screen, /12 │ {3}export function step12/, "original line numbers and indentation");
  assert.match(screen, /固定snapshotの正確な引用（照合済み）/); assert.match(screen, /引用は主張の正しさを証明しません/);
  assert.match(screen, /Enter\/← 戻る · Tab 次の根拠/);
  pane.handleInput("\t"); assert.equal(asked.at(-1), "evidence 3", "Tab steps to the next evidence");
  pane.handleInput("\x1b[D"); assert.equal(asked.at(-1), "back"); assert.equal(learning.evidenceView, undefined);
  screen = text(); assert.match(screen, /▸ 3 根拠/, "returning keeps the evidence just viewed highlighted");
  pane.handleInput("\x0f"); assert.equal(asked.at(-1), "overview"); assert.equal(learning.selectedClaim, undefined);
  assert.match(text(), /▸ 現状 学習AIはツールを持ちません/, "overview returns to the claim just left");
  // Relations are navigable: follow explains → why-isolation.
  pane.handleInput("\r"); text(); for (let i = 0; i < 4; i++) pane.handleInput("\x1b[B");
  text(); pane.handleInput("\r"); assert.equal(asked.at(-1), "select why-isolation");
  assert.match(text(), /引用はありません（推論）/);
});

test("optional challenge: skip and quiet are selectable rows, never required; quiet restores via questions on", () => {
  const learning = modelLearning();
  const { pane, asked, text } = mount(learning);
  selectClaim(learning, "no-tools");
  let screen = text();
  assert.match(screen, /この問いをスキップ/); assert.match(screen, /問いをすべて出さない（quiet）/);
  pane.handleInput("\x1b[Z"); pane.handleInput("\x1b[Z"); text();
  assert.match(text(), /▸ この問いをスキップ/);
  pane.handleInput("\r"); assert.equal(asked.at(-1), "skip");
  screen = text(); assert.match(screen, /この問いはスキップしました/); assert.doesNotMatch(screen, /実装AIへ学習会話は返りますか？/);
  learning.skippedChallenges = [];
  pane.handleInput("\x1b[A"); pane.handleInput("\x1b[A"); text();
  pane.handleInput("\x1b[Z"); text(); pane.handleInput("\r");
  assert.equal(asked.at(-1), "quiet"); screen = text();
  assert.match(screen, /問いオフ/); assert.match(screen, /問いは非表示中 · 再開する/);
  pane.handleInput("\x1b[Z"); text(); pane.handleInput("\r"); assert.equal(asked.at(-1), "questions on"); assert.equal(learning.questions, true);
});

test("proposal hypothesis is visibly separate from current facts and can be cleared from the overview", () => {
  const learning = modelLearning(); learning.proposal = "学習AIにファイル読取toolを渡す";
  const { pane, asked, text } = mount(learning);
  const screen = text();
  assert.match(screen, /仮説 · 未実装の変更案（現状の事実ではありません）/); assert.match(screen, /仮説あり/);
  assert.ok(screen.indexOf("仮説 · 未実装") > screen.indexOf("推論 誤解が"), "hypothesis is a separate block after the current model");
  assert.doesNotMatch(screen.split("仮説 · 未実装")[1]!, /現状 /, "no current-fact claim rows inside the hypothesis block");
  learning.turns.push({ role: "user", text: "toolを渡したら？", timestamp: 1, intent: "proposal" }, { role: "assistant", text: "仮説として検討します。", timestamp: 2, intent: "proposal" });
  const chat = text(); assert.match(chat, /あなた · 変更案（仮説として相談）/); assert.match(chat, /仮説への回答（未実装）/);
  pane.handleInput("\x1b[Z"); assert.match(text(), /▸ 仮説を解除/); pane.handleInput("\r");
  assert.equal(asked.at(-1), "proposal clear"); assert.doesNotMatch(text(), /仮説あり/);
});

function longDialogue(learning: Learning, turns = 40) {
  learning.turns.push({ role: "notice", text: "保存上限のため以前の12件を省略しました。", timestamp: 0 });
  for (let i = 1; i < turns; i += 2) {
    learning.turns.push({ role: "user", text: `質問${String(i).padStart(2, "0")}`, timestamp: i });
    learning.turns.push({ role: "assistant", text: `回答${String(i).padStart(2, "0")}\n\n${"本文 ".repeat(30)}`, timestamp: i + 1 });
  }
}

test("dialogue scrolls independently: PgUp moves up in both modes, reaches retained history and the trim notice; new output never moves the reading position", () => {
  for (const mode of ["fullscreen", "regular"]) for (const [columns, rows] of [[160, 48], [120, 36], [80, 24]] as const) {
    const learning = modelLearning(); longDialogue(learning);
    const { pane, text, frame } = mount(learning, columns, rows, mode);
    const label = `${mode} ${columns}x${rows}`;
    let screen = text();
    assert.match(screen, /回答39/, `${label}: follows latest on open`); assert.doesNotMatch(screen, /保存上限のため/);
    const model = screen.includes("現状 Scope");
    pane.handleInput("\x1b[5~"); screen = text();
    assert.doesNotMatch(screen, /回答39\n/, `${label}: PgUp moves up, not down`);
    assert.match(screen, /↑\d+行 ↓\d+行/, `${label}: position is shown`);
    assert.equal(screen.includes("現状 Scope"), model, `${label}: model region is unaffected`);
    const before = frame().join("\n");
    learning.turns.push({ role: "assistant", text: "LATE-OUTPUT", timestamp: 999 });
    screen = text();
    assert.doesNotMatch(screen, /LATE-OUTPUT/, `${label}: reading position held while new output arrives`);
    assert.match(screen, /新着 Ctrl\+End/, `${label}: new output indicator`);
    assert.equal(terminalText(frame().join("\n")).split("\n").filter(l => /回答\d\d/.test(l)).join(), terminalText(before).split("\n").filter(l => /回答\d\d/.test(l)).join(), `${label}: same history lines remain visible`);
    for (let i = 0; i < 60; i++) pane.handleInput("\x1b[5~");
    screen = text(); assert.match(screen, /保存上限のため以前の12件を省略しました/, `${label}: top shows the retained-history notice, not invented trimmed turns`);
    assert.match(screen, /↑0行/);
    pane.handleInput("\x1b[1;5F"); screen = text();
    assert.match(screen, /LATE-OUTPUT/, `${label}: Ctrl+End returns to and follows latest`);
    assert.match(screen, /PgUp\/PgDn 会話/, `${label}: scroll keys are always hinted`);
    assert.match(screen, mode === "fullscreen" ? /最新 · ホイール\/PgUp で遡る/ : /最新 · PgUp で遡る/, `${label}: affordance on the dialogue itself`);
    if (mode === "regular") assert.doesNotMatch(screen, /ホイール/, "regular mode does not promise wheel scrolling");
  }
});

test("retention trimming: a surviving anchor keeps the same content; a trimmed anchor lands on the retained-history notice", () => {
  const learning = modelLearning(); longDialogue(learning);
  const { pane, text } = mount(learning);
  text(); for (let i = 0; i < 2; i++) pane.handleInput("\x1b[5~");
  const history = () => text().replaceAll("┃", " ").split("\n").filter(l => /質問\d\d|回答\d\d/.test(l)).join();
  const reading = history();
  learning.turns.splice(0, 3); learning.turns.unshift({ role: "notice", text: "保存上限のため以前の3件を省略しました。", timestamp: 1000 });
  assert.equal(history(), reading, "front trimming does not move retained content");
  for (let i = 0; i < 60; i++) pane.handleInput("\x1b[5~");
  text(); learning.turns.splice(0, 3); learning.turns.unshift({ role: "notice", text: "保存上限のため以前の6件を省略しました。", timestamp: 1001 });
  const screen = text();
  assert.match(screen, /保存上限のため以前の6件を省略しました/); assert.match(screen, /↑0行/);
});

test("fullscreen wheel scrolls the region under the pointer: dialogue history and model viewport move independently", () => {
  const learning = modelLearning(); longDialogue(learning);
  for (const [columns, rows] of [[120, 36], [80, 24], [160, 48]] as const) {
    learning.selectedClaim = undefined; learning.evidenceView = undefined;
    const { pane, frame, text } = mount(learning, columns, rows);
    let lines = frame();
    const chatRow = rowOf(lines, "回答39");
    const chatCol = Math.max(...[...terminalText(lines[chatRow]!)].map((_c, i) => i)) - 4;
    const x = columns >= 120 ? Math.floor(columns * .96) - 10 : 10;
    assert.ok(chatRow > 0);
    assert.deepEqual(pane.handleMouse(wheel(x, chatRow, -5)), { handled: true });
    let screen = text(); assert.match(screen, /↑\d+行 ↓5行/, `${columns}: wheel up moved dialogue 5 lines`);
    pane.handleMouse(wheel(x, chatRow, 5)); screen = text(); assert.match(screen, /最新 · ホイール\/PgUp で遡る/, `${columns}: wheel down returns to latest`);
    assert.ok(chatCol > 0);
    // Model region: open a long evidence snippet and wheel over it.
    learning.claims![1]!.tests = [ev(1, 40)];
    selectClaim(learning, "no-tools"); openClaimEvidence(learning, 2);
    lines = frame();
    const marker = rowOf(lines, " 5 │ ");
    assert.ok(marker > 0, `${columns}: snippet visible`);
    pane.handleMouse(wheel(3, marker, 3)); lines = frame();
    assert.equal(rowOf(lines, " 5 │ "), marker - 3, `${columns}: wheel over the model moved the snippet 3 lines`);
    assert.match(terminalText(lines.join("\n")), /最新 · ホイール/, `${columns}: dialogue untouched by model wheel`);
    pane.handleInput("\x1b[A"); assert.equal(rowOf(frame(), " 5 │ "), marker - 2, `${columns}: ↑ scrolls the snippet by a line`);
    learning.claims![1]!.tests = [ev(12, 14)];
  }
});

test("sending follows latest; navigation commands keep the dialogue position; Enter with a draft sends instead of opening", () => {
  const learning = modelLearning(); longDialogue(learning);
  const { pane, asked, text } = mount(learning);
  text(); pane.handleInput("\x1b[5~"); text();
  pane.handleInput("select no-tools"); pane.handleInput("\r"); assert.equal(asked.at(-1), "select no-tools");
  assert.match(text(), /↑\d+行/, "typed navigation keeps reading position");
  pane.handleInput("自由質問"); pane.handleInput("\t"); assert.equal(pane.view().input, "自由質問", "Tab with a draft keeps the native draft");
  pane.handleInput("\r"); assert.equal(asked.at(-1), "自由質問"); assert.equal(pane.view().input, "");
  assert.match(text(), /最新 · /, "sending a question follows latest output");
});

test("respects remapped Pi keybindings for dialogue paging", () => {
  try {
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.pageUp": "f7", "tui.editor.pageUp": "f7" }));
    const learning = modelLearning(); longDialogue(learning);
    const { pane, text } = mount(learning);
    text(); pane.handleInput("\x1b[5~"); assert.match(text(), /最新 · /, "unbound PageUp no longer pages");
    pane.handleInput("\x1b[18~"); assert.match(text(), /↑\d+行/, "remapped key pages the dialogue");
  } finally { setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); }
});

test("drafts, highlight and dialogue position survive resize and geometry remount; no CURSOR_MARKER outside the Input", () => {
  const learning = modelLearning(); longDialogue(learning);
  const first = mount(learning, 160, 48);
  first.text(); first.pane.handleInput("\t"); first.pane.handleInput("下書き"); first.pane.handleInput("\x1b[D");
  first.pane.handleInput("\x1b[5~"); first.text();
  for (const [columns, rows] of [[80, 24], [120, 36], [160, 48]] as const) {
    first.terminal.columns = columns; first.terminal.rows = rows;
    const lines = first.pane.render(Math.floor(columns * .96));
    assert.equal(lines.filter(l => l.includes(CURSOR_MARKER)).length, 1, `${columns}: single IME marker`);
    assert.ok(terminalText(lines.find(l => l.includes(CURSOR_MARKER))!).includes("学習 > 下書"), `${columns}: marker sits in the native Input row`);
    const screen = terminalText(lines.join("\n").replaceAll(CURSOR_MARKER, ""));
    assert.match(screen, /学習 > 下書き/); assert.match(screen, /↑\d+行/, `${columns}: still reading history after resize`);
    assert.match(screen, /▸ 現状 学習AIはツールを持ちません/);
  }
  const second = mount(learning, 120, 36, "fullscreen", first.pane.view());
  second.pane.handleInput("X"); assert.equal(second.pane.view().input, "下書X き".replace(" ", ""), "cursor position retained across remount");
  const screen = second.text();
  assert.match(screen, /▸ 現状 学習AIはツールを持ちません/); assert.match(screen, /↑\d+行/);
});

test("legacy 12-point map remains reachable by keys and dive; clearly marked as old, not the new model", () => {
  const learning = modelLearning(); learning.claims = undefined;
  learning.map = Array.from({ length: 12 }, (_, i) => ({ flow: `流れ${i + 1}`, responsibility: "owner", symbol: `fn${i + 1}()`, contract: "c", tests: "t", evidence: [ev(i + 1, i + 1)] }));
  const { pane, asked, text } = mount(learning, 80, 24);
  let screen = text();
  for (let i = 1; i <= 12; i++) assert.ok(screen.includes(`M${i}`), `M${i} visible in pinned minimap`);
  assert.match(screen, /旧マップ（旧形式/); assert.match(screen, /モデルを生成する/);
  pane.handleInput("\x1b[B"); text(); pane.handleInput("\r"); assert.equal(asked.at(-1), "dive 1");
  screen = text(); assert.match(screen, /▶M1/); assert.match(screen, /旧マップ › M1/);
  pane.handleInput("\t"); assert.equal(asked.at(-1), "dive 2");
  pane.handleInput("\r"); assert.equal(asked.at(-1), "back"); assert.equal(learning.selectedPoint, undefined);
});

test("every view renders exact-width frames within the overlay height at all sizes and both modes", () => {
  const learning = modelLearning(); longDialogue(learning, 12); learning.proposal = "変更案"; learning.questions = false;
  learning.map = [{ flow: "送信", responsibility: "handler", symbol: "submit()", contract: "c", tests: "t", evidence: [ev(1, 2)] }];
  const views: [string, () => void][] = [["overview", () => overview(learning)], ["claim", () => selectClaim(learning, "no-tools")], ["evidence", () => { selectClaim(learning, "no-tools"); openClaimEvidence(learning, 3); }], ["point", () => { overview(learning); dive(learning, 1); }]];
  for (const mode of ["fullscreen", "regular"]) for (const [columns, rows] of [[160, 48], [120, 36], [80, 24], [60, 20], [40, 16], [40, 12]] as const) for (const [name, open] of views) {
    open();
    const { frame } = mount(learning, columns, rows, mode);
    const width = Math.floor(columns * .96); const lines = frame();
    assert.ok(lines.every(line => visibleWidth(line) === width), `${mode} ${columns}x${rows} ${name}: exact width`);
    assert.ok(lines.length <= Math.floor(rows * .96), `${mode} ${columns}x${rows} ${name}: height`);
    assert.equal(lines.filter(line => line.includes(CURSOR_MARKER)).length, 1, `${mode} ${columns}x${rows} ${name}: one IME marker`);
  }
});

test("fullscreen click highlights a model row, a second click (or double click) opens it; clicks on the dialogue only focus", () => {
  const learning = modelLearning();
  const { pane, asked, frame, text } = mount(learning);
  const lines = frame();
  const row = rowOf(lines, "未収集ファイルは後から読めません");
  assert.deepEqual(pane.handleMouse({ type: "click", button: "left", x: 6, y: row, clickCount: 1 } as TuiMouseEvent), { handled: true, focus: true });
  assert.match(text(), /▸ 現状 未収集ファイル/); assert.deepEqual(asked, []);
  pane.handleMouse({ type: "click", button: "left", x: 6, y: row, clickCount: 1 } as TuiMouseEvent);
  assert.equal(asked.at(-1), "select uncaptured");
  overview(learning); const again = frame();
  pane.handleMouse({ type: "click", button: "left", x: 6, y: rowOf(again, "学習AIはツールを持ちません"), clickCount: 2 } as TuiMouseEvent);
  assert.equal(asked.at(-1), "select no-tools", "double click opens directly");
  const count = asked.length; frame();
  pane.handleMouse({ type: "click", button: "left", x: 100, y: 5, clickCount: 2 } as TuiMouseEvent);
  assert.equal(asked.length, count, "dialogue click never navigates");
});

test("dialogue clicks on a row aligned with a selectable model row only focus: no highlight change or navigation", () => {
  for (const [columns, rows] of [[120, 36], [160, 48]] as const) {
    const learning = modelLearning(); longDialogue(learning, 10);
    const { pane, asked, frame, text, width } = mount(learning, columns, rows);
    const lines = frame();
    const row = rowOf(lines, "未収集ファイルは後から読めません");
    // Locate the column separator in display cells (CJK characters occupy two cells).
    const chars = [...terminalText(lines[row]!)];
    const separator = visibleWidth(chars.slice(0, chars.findIndex((c, i) => i > 0 && c === "│")).join(""));
    assert.ok(row > 0 && separator > 40, `${columns}: model row and column separator located`);
    const x = Math.min(width - 3, separator + 10);
    for (const clickCount of [1, 1, 2]) {
      assert.deepEqual(pane.handleMouse({ type: "click", button: "left", x, y: row, clickCount } as TuiMouseEvent), { handled: true, focus: true }, `${columns}: dialogue click requests focus`);
      assert.match(text(), /▸ 現状 Scope は固定した理解対象です/, `${columns}: model highlight unchanged by click ${clickCount}`);
    }
    assert.deepEqual(asked, [], `${columns}: dialogue clicks never navigate`);
    for (const type of ["press", "drag", "release"] as const) assert.equal(pane.handleMouse({ type, button: "left", x, y: row } as TuiMouseEvent), undefined, "native selection fallback kept");
    assert.equal(pane.handleMouse({ type: "click", button: "right", x: 6, y: row } as TuiMouseEvent), undefined);
    pane.handleMouse({ type: "click", button: "left", x: 6, y: row, clickCount: 1 } as TuiMouseEvent);
    assert.match(text(), /▸ 現状 未収集ファイル/, `${columns}: the same row inside the model region still selects`);
  }
});

function sameCitationLearning(): Learning {
  const learning = modelLearning();
  // Signature, test and general evidence legitimately quote identical lines; each is a distinct ordered entry.
  const claim = learning.claims![1]!;
  claim.signature = ev(10, 10); claim.tests = [ev(10, 10)]; claim.evidence = [ev(10, 10)];
  return learning;
}

test("identical citations in signature/tests/evidence keep distinct occurrences: labels, forward/reverse Tab, Back highlight and return to skip", () => {
  const learning = sameCitationLearning();
  const { pane, asked, text } = mount(learning);
  selectClaim(learning, "no-tools"); text();
  pane.handleInput("\r"); assert.equal(asked.at(-1), "evidence 1");
  assert.match(text(), /署名 · worktree:src\/learning.ts:10-10/); assert.match(text(), /no-tools › 署名 1\/3/);
  pane.handleInput("\t"); assert.equal(asked.at(-1), "evidence 2"); assert.match(text(), /no-tools › テスト 2\/3/);
  pane.handleInput("\t"); assert.equal(asked.at(-1), "evidence 3"); assert.match(text(), /no-tools › 根拠 3\/3/);
  pane.handleInput("\t"); assert.equal(asked.at(-1), "evidence 1", "forward cycling wraps from the last occurrence");
  pane.handleInput("\x1b[Z"); assert.equal(asked.at(-1), "evidence 3", "reverse cycling wraps to the last occurrence");
  pane.handleInput("\x1b[Z"); assert.equal(asked.at(-1), "evidence 2"); text();
  pane.handleInput("\x1b[D"); assert.equal(asked.at(-1), "back");
  assert.match(text(), /▸ 2 テスト/, "Back highlights the occurrence just viewed, not the first equal quote");
  for (let i = 0; i < 3; i++) pane.handleInput("\x1b[Z");
  assert.match(text(), /▸ この問いをスキップ/, "three Shift+Tabs from the second evidence reach skip");
  pane.handleInput("\r"); assert.equal(asked.at(-1), "skip");
});

test("identical citations: same-occurrence fixture shape (signature = general evidence) returns to evidence 2, then skip", () => {
  const learning = modelLearning();
  const claim = learning.claims![1]!; claim.signature = ev(20, 22); claim.tests = undefined; claim.evidence = [ev(20, 22)];
  const { pane, asked, text } = mount(learning);
  selectClaim(learning, "no-tools"); text();
  pane.handleInput("\r"); pane.handleInput("\t"); assert.equal(asked.at(-1), "evidence 2");
  assert.match(text(), /no-tools › 根拠 2\/2/);
  pane.handleInput("\x1b[D"); assert.match(text(), /▸ 2 根拠/);
  for (let i = 0; i < 3; i++) pane.handleInput("\x1b[Z");
  pane.handleInput("\r"); assert.equal(asked.at(-1), "skip");
});

test("identical citations after a cloned restore: the occurrence this pane opened is kept; otherwise the first equal entry is a controlled fallback", () => {
  const live = sameCitationLearning();
  let current: Learning = live;
  initTheme("dark", false);
  const tui = { mode: "fullscreen", terminal: { columns: 120, rows: 36 }, requestRender: () => {} } as unknown as TUI;
  const asked: string[] = [];
  const ask = (text: string) => { asked.push(text); if (text.startsWith("evidence")) openClaimEvidence(current, Number(text.split(" ")[1])); else if (text === "back") modelBack(current); };
  const pane = new UnderstandingPane(tui, theme, () => current, { ask, cancel: () => {}, close: () => {}, running: () => false });
  pane.handle = { focus: () => { pane.focused = true; }, unfocus: () => {}, setHidden: () => {} } as unknown as OverlayHandle;
  pane.focus();
  const text = () => terminalText(pane.render(115).join("\n").replaceAll(CURSOR_MARKER, ""));
  selectClaim(live, "no-tools"); text(); pane.handleInput("\r"); pane.handleInput("\t"); pane.handleInput("\t");
  assert.equal(asked.at(-1), "evidence 3");
  current = JSON.parse(JSON.stringify(live)) as Learning;
  assert.notEqual(current.evidenceView, current.claims![1]!.evidence[0], "identity lost by restore");
  assert.match(text(), /根拠 3\/3/, "pane-opened occurrence survives a value-equal clone");
  const remounted = new UnderstandingPane(tui, theme, () => current, { ask, cancel: () => {}, close: () => {}, running: () => false }, false, pane.view());
  assert.match(terminalText(remounted.render(115).join("\n")), /根拠 3\/3/, "occurrence retained across geometry remount");
  const fresh = new UnderstandingPane(tui, theme, () => current, { ask, cancel: () => {}, close: () => {}, running: () => false });
  assert.match(terminalText(fresh.render(115).join("\n")), /署名 1\/3/, "without pane history the first equal entry is shown, never an invented one");
});

test("generation and retrieval progress stream into the dialogue; actions are disabled and Ctrl+C is offered while running", () => {
  const learning = modelLearning(); learning.claims = undefined;
  let running = true;
  initTheme("dark", false);
  const tui = { mode: "regular", terminal: { columns: 120, rows: 36 }, requestRender: () => {} } as unknown as TUI;
  const asked: string[] = [];
  const pane = new UnderstandingPane(tui, theme, () => learning, { ask: text => { asked.push(text); }, cancel: () => {}, close: () => {}, running: () => running });
  pane.handle = { focus: () => { pane.focused = true; }, unfocus: () => {}, setHidden: () => {} } as unknown as OverlayHandle;
  pane.focus();
  learning.turns.push({ role: "user", text: "モデル生成の依頼文", timestamp: 1, intent: "model" });
  pane.redraw("固定根拠を取得中: worktree:src/learning.ts:1-20 (実装を確認)");
  let screen = terminalText(pane.render(115).join("\n"));
  assert.match(screen, /あなた · モデル生成を依頼/); assert.match(screen, /根拠を取得中/); assert.match(screen, /src\/learning.ts:1-20/);
  assert.match(screen, /生成・回答中… 進捗は会話欄/); assert.match(screen, /Ctrl\+C 中止/); assert.match(screen, /回答中/);
  pane.handleInput("\r"); assert.deepEqual(asked, [], "a running generation cannot be started twice from the pane");
  pane.redraw("モデルを**組み立て**ています");
  screen = terminalText(pane.render(115).join("\n")); assert.match(screen, /学習AI · 回答中…/); assert.match(screen, /組み立て/);
  running = false; learning.turns.push({ role: "assistant", text: "完了", timestamp: 2, intent: "model", usage: { totalTokens: 321 } as never, model: "gpt-qa", read: [{ path: "a", ref: "w", status: "sent" }, { path: "b", ref: "w", status: "fetched" }, { path: ".env", ref: "w", status: "excluded" }] });
  pane.redraw();
  screen = terminalText(pane.render(115).join("\n"));
  assert.match(screen, /321 tokens · gpt-qa/); assert.match(screen, /根拠 送信1 · 取得1 · 読めず1/);
  pane.error = "現在選択中のPiネイティブGPTモデルが必要です。"; pane.redraw();
  assert.match(terminalText(pane.render(115).join("\n")), /エラー\s+│?[\s\S]*ネイティブGPTモデルが必要/);
});

test("Ctrl+Shift+↑/↓ jump between own questions in the dialogue; Ctrl+Home goes to the retained top", () => {
  const learning = modelLearning(); longDialogue(learning);
  const { pane, text } = mount(learning);
  text(); pane.handleInput("\x1b[1;6A"); let screen = text();
  assert.match(screen.split("\n").find(l => l.includes("あなた")) ?? "", /あなた/);
  const firstVisibleQuestion = () => text().match(/質問(\d\d)/)?.[1];
  const a = firstVisibleQuestion(); pane.handleInput("\x1b[1;6A"); const b = firstVisibleQuestion();
  assert.ok(Number(b) < Number(a), `previous prompt moves up (${a} → ${b})`);
  pane.handleInput("\x1b[1;6B"); assert.equal(firstVisibleQuestion(), a);
  pane.handleInput("\x1b[1;5H"); screen = text(); assert.match(screen, /保存上限のため以前の12件/); assert.match(screen, /↑0行/);
});

test("QA fixture provider: explicit model generation does one bounded read round, then canonical exact-quote claims render in the pane", async () => {
  let provider: { streamSimple: (...args: unknown[]) => unknown } | undefined;
  fixture({ registerProvider: (_name: string, config: typeof provider) => { provider = config; }, registerCommand: () => {} } as unknown as ExtensionAPI);
  const files = { "README.md": "# Fixture\nUser flow: submit -> validate -> result", "src/main.ts": 'export function submit() { return "working"; }' } as Record<string, string>;
  const sources = Object.entries(files).map(([path, text]) => ({ path, ref: "worktree", digest: hash(text), text }));
  const learning = freshLearning({ id: "e".repeat(64), root: "/fixture", repository: "r", request: { kind: "repository" }, base: "b".repeat(40), head: "c".repeat(40), snapshot: "s", sources, files: Object.keys(files), omitted: 0, capturedAt: 0, fingerprint: "f" } as unknown as Scope);
  const model = { id: "gpt-qa", provider: "understanding-qa", api: "openai-responses" };
  const ctx = { model, modelRegistry: { streamSimple: (m: unknown, c: { tools: unknown[] }, o: unknown) => { assert.deepEqual(c.tools, []); return provider!.streamSimple(m, c, o); } } } as unknown as ExtensionContext;
  await new LearningRunner().ask(ctx, learning, "model", () => {}, () => {}, "model");
  assert.deepEqual(learning.claims?.map(c => c.id), ["submit-handler", "literal-result", "validate-boundary", "flow-order", "why-literal"]);
  assert.equal(learning.claims![0]!.signature?.quote, files["src/main.ts"]); assert.equal(learning.claims![3]!.status, "fact");
  assert.ok(learning.turns.some(t => t.role === "notice" && t.text.startsWith("固定根拠取得 1/2")), "retrieval round is visible in the dialogue");
  assert.ok(learning.turns.at(-1)?.read?.some(r => r.status === "fetched" && r.path === "README.md"));
  const { text } = mount(learning);
  const screen = text();
  assert.match(screen, /▸ 現状 submit\(\) は結果文字列を返す入口です/); assert.match(screen, /推論 固定文字列なのは/);
  assert.match(screen, /固定根拠取得 1\/2/);
});

test("small stacked layout: Enter/↓ reveal an off-screen highlight before acting; Alt+S stays hinted at 80 columns", () => {
  const learning = modelLearning(); longDialogue(learning, 10);
  const { pane, asked, text } = mount(learning, 80, 24);
  text(); pane.handleInput("\x1b[5~"); selectClaim(learning, "no-tools");
  let screen = text();
  assert.match(screen, /学習AIはツールを持ちません/); assert.doesNotMatch(screen, /▸ 1 署名/, "highlight starts below the fold");
  assert.match(screen, /Alt\+S 閉じる/);
  pane.handleInput("\r"); assert.deepEqual(asked, [], "first Enter only reveals"); screen = text();
  assert.match(screen, /▸ 1 署名/); assert.match(screen, /↑\d+行/, "dialogue position untouched by model navigation");
  pane.handleInput("\r"); assert.deepEqual(asked, ["evidence 1"]);
});

// Long claims: the same shape as the native QA fixture (inferred, no signature/tests/challenge, empty evidence/relations).
function longClaimLearning(): Learning {
  const learning = modelLearning();
  learning.claims = [
    { id: "long-plain", kind: "concept", statement: "長い推論の主張は操作がなくても最後まで読めます。", detail: longDetail(), status: "inferred", evidence: [], relations: [] },
    { id: "long-controls", kind: "rule", statement: "長い主張の後ろの操作は読み終えてから選べます。", detail: longDetail(), status: "fact", evidence: [ev(5, 5)], relations: [{ to: "long-plain", type: "explains" }], challenge: "長い説明の途中を飛ばさずに読めましたか？" },
  ] as Claim[];
  return learning;
}
const DOWN = "\x1b[B", UP = "\x1b[A", SHIFT_DOWN = "\x1b[1;2B", SHIFT_UP = "\x1b[1;2A";
/** Press a key until the frame stops changing; returns every distinct frame seen. */
function readThrough(pane: UnderstandingPane, text: () => string, key: string, limit = 400): string[] {
  const frames = [text()];
  for (let i = 0; i < limit; i++) { pane.handleInput(key); const screen = text(); if (screen === frames.at(-1)) break; frames.push(screen); }
  return frames;
}
/** Every paragraph's start and end marker appears, in document order, and some frame shows only middle paragraphs. */
function assertReadsEveryParagraph(frames: string[], label: string, reverse = false): void {
  const first = LONG_MARKERS.map(m => frames.findIndex(f => f.includes(m)));
  first.forEach((index, i) => assert.ok(index >= 0, `${label}: ${LONG_MARKERS[i]} never shown`));
  const order = reverse ? [...first].reverse() : first;
  assert.ok(order.every((index, i) => i === 0 || index >= order[i - 1]!), `${label}: paragraphs appear in reading order, none skipped ahead`);
  assert.ok(frames.some(f => f.includes("P10始") && !f.includes("P01始") && !f.includes("P20終")), `${label}: an intermediate frame shows middle paragraphs only`);
}

test("long claim without any selectable row: ↑/↓ and Shift+↑/↓ read every paragraph in both modes and all sizes; dialogue position independent", () => {
  assert.ok(longDetail().length <= 2000 && longDetail().split("\n\n").length === 20, "fixture shape: twenty short paragraphs within the 2000-character detail bound");
  for (const mode of ["fullscreen", "regular"]) for (const [columns, rows] of [[80, 24], [120, 36], [160, 48]] as const) {
    const label = `${mode} ${columns}x${rows}`;
    const learning = longClaimLearning(); longDialogue(learning, 10); selectClaim(learning, "long-plain");
    const { pane, asked, text } = mount(learning, columns, rows, mode);
    let screen = text();
    assert.match(screen, /長い推論の主張は操作がなくても最後まで読めます/); assert.match(screen, /P01始/);
    assert.doesNotMatch(screen, /P20終/, `${label}: the detail exceeds the model viewport`);
    assert.match(screen, /↑↓ 読む/, `${label}: reading keys are hinted`); assert.match(screen, /Alt\+S 閉じる/, `${label}: Alt+S stays hinted`);
    assert.match(screen, /↑0行 ↓\d+行/, `${label}: model reading position beside the crumb`);
    pane.handleInput("\x1b[5~"); screen = text();
    const dialogue = screen.match(/↑\d+行 ↓\d+行 · Ctrl\+End/)?.[0]; assert.ok(dialogue, `${label}: dialogue reading history`);
    const down = readThrough(pane, text, DOWN);
    assertReadsEveryParagraph(down, `${label} ↓`);
    assert.ok(down.length > 20, `${label}: ↓ moves continuously, not a top/bottom jump`);
    screen = down.at(-1)!; assert.match(screen, /P20終/); assert.match(screen, / ↓0行/, `${label}: bottom reached`);
    assert.ok(screen.includes(dialogue!), `${label}: dialogue position untouched by model reading`);
    const up = readThrough(pane, text, UP);
    assertReadsEveryParagraph(up, `${label} ↑`, true);
    assert.match(up.at(-1)!, /長い推論の主張は操作がなくても/); assert.match(up.at(-1)!, /↑0行 ↓\d+行/);
    const pages = readThrough(pane, text, SHIFT_DOWN);
    assert.ok(pages.length < down.length, `${label}: Shift+↓ pages faster than ↓`);
    assert.ok(LONG_MARKERS.every(m => pages.some(f => f.includes(m))), `${label}: paging never skips a paragraph`);
    assert.ok(readThrough(pane, text, SHIFT_UP).at(-1)!.includes("P01始"), `${label}: Shift+↑ pages back to the top`);
    assert.deepEqual(asked, [], `${label}: reading never navigates or sends`);
    pane.handleInput("下書き"); pane.handleInput(DOWN); assert.equal(pane.view().input, "下書き", `${label}: reading keeps the native draft`);
    pane.handleInput("\r"); assert.deepEqual(asked, ["下書き"], `${label}: Enter with a draft sends`);
  }
});

test("long claim with controls after the detail: ↓ reads every paragraph before taking skip/quiet/evidence/relation; Enter, Back, skip and Tab keep working", () => {
  for (const mode of ["fullscreen", "regular"]) for (const [columns, rows] of [[80, 24], [120, 36], [160, 48]] as const) {
    const label = `${mode} ${columns}x${rows}`;
    const learning = longClaimLearning(); longDialogue(learning, 10); selectClaim(learning, "long-controls");
    const { pane, asked, text } = mount(learning, columns, rows, mode, undefined, true);
    const opened = text();
    assert.doesNotMatch(opened, /▸ 1 根拠/, `${label}: the preferred evidence row starts below the long detail`);
    assert.match(opened, /↑↓ 読む · Tab 選択/); assert.match(opened, /Alt\+S 閉じる/);
    const down = readThrough(pane, text, DOWN);
    assertReadsEveryParagraph(down, `${label} ↓`);
    const skip = down.findIndex(f => f.includes("▸ この問いをスキップ"));
    assert.ok(skip > 0, `${label}: ↓ reaches skip`);
    assert.ok(LONG_MARKERS.every(m => down.slice(0, skip + 1).some(f => f.includes(m))), `${label}: every paragraph is read before the first control is taken`);
    const order = ["▸ この問いをスキップ", "▸ 問いをすべて出さない", "▸ 1 根拠", "▸ 理由づけ → long-plain"].map(row => down.findIndex(f => f.includes(row)));
    assert.ok(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1]!)), `${label}: controls are taken in order ${order}`);
    assert.match(down.at(-1)!, /▸ 理由づけ → long-plain/);
    assert.deepEqual(asked, []);
    pane.handleInput(UP); assert.match(text(), /▸ 1 根拠/);
    pane.handleInput("\r"); assert.equal(asked.at(-1), "evidence 1", `${label}: Enter opens the visible evidence`);
    pane.handleInput("\x1b[D"); assert.equal(asked.at(-1), "back"); assert.match(text(), /▸ 1 根拠/, `${label}: Back keeps the evidence highlighted`);
    pane.handleInput(UP); pane.handleInput(UP); assert.match(text(), /▸ この問いをスキップ/);
    pane.handleInput("\r"); assert.equal(asked.at(-1), "skip");
    const skipped = text();
    assert.match(skipped, /この問いはスキップしました/, `${label}: the skipped result is visible where the reader was`);
    assert.doesNotMatch(skipped, /P01始/, `${label}: skip keeps the reading position instead of returning to the top`);
    assert.match(skipped, /▸ 1 根拠/, `${label}: the highlight moves to a visible row`);
    const up = readThrough(pane, text, UP);
    assertReadsEveryParagraph(up, `${label} ↑`, true);
    assert.match(up.at(-1)!, /長い主張の後ろの操作は読み終えてから選べます/);
    pane.handleInput("\t"); assert.match(text(), /▸ 1 根拠/, `${label}: Tab first reveals the off-screen highlight`);
    pane.handleInput("\t"); assert.match(text(), /▸ 理由づけ → long-plain/, `${label}: Tab still jumps between controls`);
    pane.handleInput("\r"); assert.equal(asked.at(-1), "select long-plain");
    assert.match(text(), /↑0行 ↓\d+行[\s\S]*長い推論の主張は操作がなくても/, `${label}: opening another claim starts at its top`);
  }
});

test("long claim reading in the overview: ↓ takes the next claim when visible and Ctrl+O returns to it", () => {
  const learning = longClaimLearning();
  const { pane, asked, text } = mount(learning, 80, 24, "regular");
  assert.match(text(), /▸ 推論 長い推論の主張/);
  pane.handleInput(DOWN); assert.match(text(), /▸ 現状 長い主張の後ろの操作/);
  pane.handleInput("\r"); assert.equal(asked.at(-1), "select long-controls");
  pane.handleInput("\x0f"); assert.match(text(), /▸ 現状 長い主張の後ろの操作/);
});
