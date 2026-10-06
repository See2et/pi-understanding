import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayHandle, type OverlayOptions, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Learning } from "./learning.ts";

// Remove terminal control payloads from untrusted source/model output, including OSC links.
export function terminalText(value: string): string { return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""); }
export const FOCUS_SHORTCUT = "ctrl+alt+u";
export const FOCUS_HINT = "Ctrl+Alt+U 入力切替";
// Keep the native editing buffer across geometry remounts, including cursor/undo/paste state.
export type PaneView = { input: string; editor?: Input; offset: number; partial?: string; error: string };
export class UnderstandingPane implements Component, Focusable {
  focused = false;
  handle?: OverlayHandle;
  wide = false;
  private input = new Input({ prompt: "学習 > ", placeholder: "質問を入力（通常チャットとは別）" });
  private offset = 0;
  private bodyLength = 0;
  private bodyHeight = 1;
  private cachedKey = "";
  private cached: string[] = [];
  partial?: string;
  error = "";
  private tui: TUI;
  private theme: Theme;
  private current: () => Learning | undefined;
  private restoreMainMouse?: () => void;
  private actions: { ask: (text: string) => void; cancel: () => void; close: () => void; running: () => boolean; choose?: () => void; layout?: (wide: boolean, focus: boolean) => void };
  constructor(tui: TUI, theme: Theme, current: () => Learning | undefined, actions: { ask: (text: string) => void; cancel: () => void; close: () => void; running: () => boolean; choose?: () => void; layout?: (wide: boolean, focus: boolean) => void }, wide = false, view?: PaneView) {
    this.tui = tui; this.theme = theme; this.current = current; this.actions = actions; this.wide = wide;
    // Pi 1.0.4's concrete TUI exposes the focus owner (not yet in its TUI interface).
    // Adapt the existing editor only while this pane lives; never replace its renderer/input.
    const main = (tui as TUI & { getFocusedComponent?: () => Component | null }).getFocusedComponent?.();
    if (tui.mode === "fullscreen" && main?.handleMouse) {
      const original = main.handleMouse;
      const owned = Object.hasOwn(main, "handleMouse");
      const mouse: NonNullable<Component["handleMouse"]> = event => {
        const result = original.call(main, event);
        // A native editor click positions its cursor and requests focus, but Pi retains
        // the overlay's eligible focus restore. Clear that lifetime through its handle.
        if (event.type === "click" && event.button === "left" && result?.focus) this.release(main);
        return result;
      };
      main.handleMouse = mouse;
      this.restoreMainMouse = () => {
        if (main.handleMouse !== mouse) return; // do not overwrite a later extension's handler
        if (owned) main.handleMouse = original;
        else delete main.handleMouse;
      };
    }
    if (view) {
      if (view.editor) this.input = view.editor;
      else { this.input.setValue(view.input); this.input.handleInput("\x05"); }
      this.offset = view.offset; this.partial = view.partial; this.error = view.error;
    }
    this.input.onSubmit = value => { if (!value.trim()) return; this.actions.ask(value.trim()); this.input.setValue(""); this.offset = 0; this.redraw(); };
  }
  options(): OverlayOptions {
    const narrow = this.tui.terminal.columns < 110;
    return { nonCapturing: true, anchor: "top-right", width: this.wide || narrow ? "94%" : "42%", minWidth: Math.min(38, this.tui.terminal.columns), maxHeight: "90%", margin: { top: 1, right: 1 }, visible: (width, height) => {
      // Pi 1.0.4 evaluates custom overlay geometry once. Remount to update size, not a second renderer.
      if (width < 110 && this.focused && !this.wide && this.actions.layout) { queueMicrotask(() => this.actions.layout?.(true, true)); return false; }
      return height >= 12 && (width >= 110 || this.focused || this.wide);
    } };
  }
  focus(): void {
    // Visibility is checked by OverlayHandle.focus(): reveal the narrow fallback first.
    if (this.tui.terminal.columns < 110 && !this.wide && this.actions.layout) { this.actions.layout(true, true); return; }
    if (this.tui.terminal.columns < 110) this.wide = true;
    this.handle?.setHidden(false); this.handle?.focus(); this.redraw(this.partial);
  }
  view(): PaneView { return { input: this.input.getValue(), editor: this.input, offset: this.offset, partial: this.partial, error: this.error }; }
  dispose(): void { this.restoreMainMouse?.(); this.restoreMainMouse = undefined; }
  release(target?: Component): void {
    this.handle?.unfocus(target ? { target } : undefined);
    if (this.wide && this.actions.layout) { this.actions.layout(false, false); return; }
    this.wide = false; this.redraw(this.partial);
  }
  redraw(partial?: string): void { this.partial = partial; this.invalidate(); this.tui.requestRender(); }
  invalidate(): void { this.cachedKey = ""; this.input.invalidate(); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Fullscreen Pi dispatches this natively; regular mode keeps terminal scrollback/mouse.
    // Only a primary click requests focus. Wheel/right-click/drag fallback stays with Pi.
    if (event.button === "left" && event.type === "click") return { handled: true, focus: true };
    return undefined;
  }
  handleInput(data: string): void {
    // Extension shortcuts belong to the main editor, not focused custom overlays.
    if (matchesKey(data, FOCUS_SHORTCUT) || matchesKey(data, "escape") || matchesKey(data, "ctrl+g")) this.release();
    else if (matchesKey(data, "ctrl+t")) this.actions.choose?.();
    else if (matchesKey(data, "ctrl+c")) { this.actions.cancel(); this.redraw(this.partial); }
    else if (matchesKey(data, "ctrl+d")) this.actions.close();
    else if (matchesKey(data, "ctrl+o")) { if (this.actions.layout) this.actions.layout(!this.wide, true); else { this.wide = !this.wide; this.redraw(this.partial); } }
    else if (matchesKey(data, "pageUp")) { this.offset = Math.min(Math.max(0, this.bodyLength - this.bodyHeight), this.offset + this.bodyHeight); this.redraw(this.partial); }
    else if (matchesKey(data, "pageDown")) { this.offset = Math.max(0, this.offset - this.bodyHeight); this.redraw(this.partial); }
    else { this.input.handleInput(data); this.redraw(this.partial); }
  }
  render(width: number): string[] {
    if (width < 4) return [truncateToWidth("理解", width)];
    const learning = this.current();
    const inner = width - 2;
    const height = Math.max(8, Math.floor(this.tui.terminal.rows * .9) - 2);
    const th = this.theme;
    const clean = (s: string) => terminalText(s);
    const row = (s: string) => th.fg("border", "│") + truncateToWidth(s, inner, "…", true) + th.fg("border", "│");
    const border = th.fg(this.focused ? "accent" : "border", `╭${"─".repeat(inner)}╮`);
    if (!learning) return [border, row("理解 / スコープ未選択"), row("/understand scope で選択してください"), th.fg("border", `╰${"─".repeat(inner)}╯`)];
    const scope = learning.scope;
    const label = scope.request.kind === "module" ? `module ${scope.request.module}` : scope.request.kind === "pr" ? `PR #${scope.request.number}` : scope.request.kind === "branch" ? `branch ${scope.request.ref}${scope.request.base ? ` ← ${scope.request.base}` : " / 全体"}` : scope.request.kind === "changes" ? "未commit分 / HEAD → 作業状態" : scope.request.kind;
    const header = [
      th.fg("accent", `理解 / ${clean(label)} / ${this.focused ? "学習に入力" : "通常チャットに入力"}`),
      ...wrapTextWithAnsi(clean(scope.root), inner).slice(0, 2),
      `base ${scope.base.slice(0, 12)} → head ${scope.head.slice(0, 12)}`,
      `snapshot ${scope.snapshot.slice(0, 12)} / scope ${scope.id.slice(0, 8)}`,
      th.fg(learning.stale === "stale" ? "warning" : "muted", `${learning.stale === "unknown" ? "鮮度未確認" : learning.stale === "stale" ? "古い根拠 / refreshで更新" : "確認時点で一致"} / 収集${scope.sources.length} 未収集${scope.omitted}`),
    ];
    const key = JSON.stringify([inner, learning.map, learning.focus, learning.turns, this.partial, this.error]);
    if (this.cachedKey !== key) {
      const map = learning.map.length ? learning.map.map((n, i) => `**${i + 1}. ${n.flow}** → ${n.responsibility}\n\`${n.symbol}\` — ${n.contract}\nテスト: ${n.tests}\n${n.evidence.map(e => `${e.ref.slice(0, 12)}:${e.path}:${e.start}-${e.end}`).join(" / ")}`).join("\n\n") : "まだマップはありません。`/understand map` で作成します。";
      const focus = learning.focus ? `現在の焦点（スコープとは別）: ${learning.focus}` : "現在の焦点: 未指定";
      const chat = learning.turns.map(t => `**${t.role === "user" ? "あなた" : t.role === "assistant" ? "学習AI" : "状態 / 未検証"}**\n${t.text}${t.usage ? `\n\n使用量: ${t.usage.totalTokens} tokens / ${t.provider}/${t.model} / ${t.stopReason}` : ""}`).join("\n\n");
      const markdown = `## マップ\n${map}\n\n## 焦点・根拠\n${focus}\n\n引用を読む: /understand reference path [base|head]\n\n## 学習チャット\n${chat || "この会話は実装AIには送られません。"}${this.partial !== undefined ? `\n\n**学習AI / 回答中**\n${this.partial}` : ""}${this.error ? `\n\n**エラー**\n${this.error}` : ""}`;
      this.cached = new Markdown(clean(markdown), 0, 0, getMarkdownTheme()).render(inner);
      this.cachedKey = key;
    }
    this.bodyLength = this.cached.length;
    this.bodyHeight = Math.max(1, height - header.length - 4);
    this.offset = Math.min(this.offset, Math.max(0, this.bodyLength - this.bodyHeight));
    // A new pane starts at map; submitting a question or streaming follows the dialogue at bottom.
    const end = this.partial !== undefined || learning.turns.length ? Math.max(this.bodyHeight, this.bodyLength - this.offset) : this.bodyHeight;
    const body = this.cached.slice(Math.max(0, end - this.bodyHeight), end);
    while (body.length < this.bodyHeight) body.push("");
    this.input.focused = this.focused;
    const footer = th.fg("muted", `${FOCUS_HINT} / Esc 通常 / ${this.actions.running() ? "Ctrl+C 中止" : "Ctrl+T 対象"}`);
    return [border, ...header.map(row), row(th.fg("border", "─".repeat(inner))), ...body.map(row), row(footer), ...this.input.render(inner).map(row), th.fg("border", `╰${"─".repeat(inner)}╯`)];
  }
}
