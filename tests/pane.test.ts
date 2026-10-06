import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { CURSOR_MARKER, visibleWidth, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { UnderstandingPane, terminalText } from "../src/pane.ts";
import { freshLearning } from "../src/learning.ts";
import type { Scope } from "../src/scope.ts";

test("production pane bounds widths/heights, propagates IME focus, accepts Japanese paste, releases focus and cancels independently", () => {
  initTheme("dark", false); assert.ok(theme);
  const learning = freshLearning({ id: "a".repeat(64), root: "/fixture/理解/repo", request: { kind: "repository" }, base: "b".repeat(40), head: "c".repeat(40), snapshot: "d".repeat(64), sources: [], files: [], omitted: 2 } as unknown as Scope);
  let submitted = "", cancelled = false, closed = false, rendered = 0;
  const terminal = { columns: 140, rows: 40 };
  const tui = { terminal, requestRender: () => { rendered++; } } as unknown as TUI;
  const pane = new UnderstandingPane(tui, theme, () => learning, { ask: text => { submitted = text; }, cancel: () => { cancelled = true; }, close: () => { closed = true; }, running: () => false });
  pane.handle = { focus: () => { pane.focused = true; }, unfocus: () => { pane.focused = false; }, setHidden: () => {} } as unknown as OverlayHandle;
  assert.equal(pane.options().nonCapturing, true); assert.equal(pane.focused, false);
  pane.focus(); pane.handleInput("\x1b[200~質問：日本語の入力\x1b[201~");
  assert.ok(pane.render(58).some(line => line.includes(CURSOR_MARKER)), "IME cursor marker reaches production rendered row");
  pane.handleInput("\r"); assert.equal(submitted, "質問：日本語の入力");
  for (const [columns, rows] of [[160, 48], [120, 30], [80, 24], [40, 16]]) {
    terminal.columns = columns!; terminal.rows = rows!;
    const width = columns! < 110 ? Math.floor(columns! * .94) : Math.floor(columns! * .42);
    const lines = pane.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `${columns} column overflow`);
    assert.ok(lines.length <= Math.floor(rows! * .9), `${rows} row overflow`);
  }
  pane.handleInput("\x03"); assert.equal(cancelled, true); assert.equal(closed, false);
  pane.handleInput("\x1b"); assert.equal(pane.focused, false); assert.equal(pane.options().visible!(80, 24), false);
  pane.focus(); assert.equal(pane.options().visible!(80, 24), true);
  pane.handleInput("\x04"); assert.equal(closed, true); assert.ok(rendered > 0);
});

test("untrusted terminal control sequences are not emitted", () => {
  assert.equal(terminalText("hello\x1b[2J\x1b]52;c;secret\x07world"), "helloworld");
  assert.ok(!/[\x80-\x9f]/.test(terminalText("\u009b2J\u009d52;data")));
});
