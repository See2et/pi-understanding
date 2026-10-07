import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { CURSOR_MARKER, visibleWidth, type OverlayHandle, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { UnderstandingPane, terminalText } from "../src/pane.ts";
import { freshLearning, dive, overview } from "../src/learning.ts";
import type { Scope } from "../src/scope.ts";

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
  assert.ok(pane.render(58).some(line => line.includes(CURSOR_MARKER)), "IME cursor marker reaches production rendered row");
  pane.handleInput("\r"); assert.equal(submitted, "質問：日本語の入力");
  for (const [columns, rows] of [[160, 48], [120, 30], [80, 24], [40, 16], [40, 12]]) {
    terminal.columns = columns!; terminal.rows = rows!;
    const width = Math.floor(columns! * .96);
    const lines = pane.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `${columns} column overflow`);
    assert.ok(lines.length <= Math.floor(rows! * .96), `${rows} row overflow`);
  }
  pane.handleInput("\x03"); assert.equal(cancelled, true); assert.equal(closed, false);
  pane.handleInput("\x1b"); assert.equal(pane.focused, false); assert.equal(hidden, true);
  pane.focus(); assert.equal(hidden, false); assert.equal(pane.options().visible!(80, 24), true);
  pane.handleInput("\x04"); assert.equal(closed, true); assert.ok(rendered > 0);
});

test("geometry remount retains the native draft cursor and shortcut releases; only completed primary clicks request focus", () => {
  initTheme("dark", false);
  const tui = { terminal: { columns: 80, rows: 24 }, requestRender: () => {} } as unknown as TUI;
  const actions = { ask: () => {}, cancel: () => {}, close: () => {}, running: () => false };
  const original = new UnderstandingPane(tui, theme, () => undefined, actions, true);
  original.handleInput("abcd"); original.handleInput("\x1b[D"); original.handleInput("\x1b[D");
  const remounted = new UnderstandingPane(tui, theme, () => undefined, actions, true, original.view());
  remounted.handleInput("X"); assert.equal(remounted.view().input, "abXcd", "cursor was not reset to the start/end");
  let released = false;
  remounted.handle = { unfocus: () => { released = true; }, setHidden: () => {} } as unknown as OverlayHandle;
  remounted.handleInput("\x1b[117;7u"); assert.equal(released, true); assert.equal(remounted.view().input, "abXcd");
  const mouse = { type: "click", button: "left" } as TuiMouseEvent;
  assert.deepEqual(remounted.handleMouse(mouse), { handled: true, focus: true });
  for (const type of ["press", "drag", "wheel"] as const) assert.equal(remounted.handleMouse({ ...mouse, type }), undefined);
  assert.equal(remounted.handleMouse({ ...mouse, button: "right" }), undefined);
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
});
