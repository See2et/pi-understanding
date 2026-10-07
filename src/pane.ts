import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayHandle, type OverlayOptions, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { pointId, pointDetail, selectedNode, stageLabel, stageReason, importanceReason, type Learning } from "./learning.ts";

// Remove terminal control payloads from untrusted source/model output, including OSC links.
export function terminalText(value: string): string { return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""); }
export const FOCUS_SHORTCUT = "ctrl+alt+u";
export const FOCUS_HINT = "Ctrl+Alt+U 表示/入力切替";
// Keep the native editing buffer across geometry remounts, including cursor/undo/paste state.
export type PaneView = { input: string; editor?: Input; offset: number; partial?: string; error: string; followChat?: boolean };
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
  private followChat = false;
  private selection?: number;
  private actions: { ask: (text: string) => void; cancel: () => void; close: () => void; running: () => boolean; choose?: () => void; layout?: (wide: boolean, focus: boolean) => void };
  constructor(tui: TUI, theme: Theme, current: () => Learning | undefined, actions: { ask: (text: string) => void; cancel: () => void; close: () => void; running: () => boolean; choose?: () => void; layout?: (wide: boolean, focus: boolean) => void }, wide = false, view?: PaneView) {
    this.tui = tui; this.theme = theme; this.current = current; this.actions = actions; this.wide = wide; this.selection = current()?.selectedPoint;
    if (view) {
      if (view.editor) this.input = view.editor;
      else { this.input.setValue(view.input); this.input.handleInput("\x05"); }
      this.offset = view.offset; this.partial = view.partial; this.error = view.error; this.followChat = view.followChat ?? false;
    }
    this.input.onSubmit = value => { if (!value.trim()) return; this.followChat = !/^(?:dive\s+(?:M)?\d+|overview)$/i.test(value.trim()); this.actions.ask(value.trim()); this.input.setValue(""); this.offset = 0; this.redraw(); };
  }
  options(): OverlayOptions {
    return { nonCapturing: true, anchor: "center", width: "96%", maxHeight: "96%", visible: (_width, height) => height >= 12 };
  }
  focus(): void {
    this.handle?.setHidden(false); this.handle?.focus(); this.redraw(this.partial);
  }
  view(): PaneView { return { input: this.input.getValue(), editor: this.input, offset: this.offset, partial: this.partial, error: this.error, followChat: this.followChat }; }
  dispose(): void {}
  release(target?: Component): void {
    this.handle?.unfocus(target ? { target } : undefined);
    this.handle?.setHidden(true); this.redraw(this.partial);
  }
  navigate(): void { this.followChat = false; this.offset = 0; this.redraw(this.partial); }
  followDialogue(): void { this.followChat = true; this.offset = 0; this.redraw(this.partial); }
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
    else if (matchesKey(data, "ctrl+o")) { this.actions.ask("overview"); this.followChat = false; this.offset = 0; this.redraw(this.partial); }
    else if (matchesKey(data, "pageUp")) { this.offset = Math.max(0, Math.min(Math.max(0, this.bodyLength - this.bodyHeight), this.offset + (this.followChat ? this.bodyHeight : -this.bodyHeight))); this.redraw(this.partial); }
    else if (matchesKey(data, "pageDown")) { this.offset = Math.max(0, Math.min(Math.max(0, this.bodyLength - this.bodyHeight), this.offset + (this.followChat ? -this.bodyHeight : this.bodyHeight))); this.redraw(this.partial); }
    else { this.input.handleInput(data); this.redraw(this.partial); }
  }
  render(width: number): string[] {
    if (width < 4) return [truncateToWidth("理解", width)];
    const learning = this.current();
    const inner = width - 2;
    const height = Math.max(8, Math.floor(this.tui.terminal.rows * .96) - 2);
    const th = this.theme;
    const clean = (s: string) => terminalText(s);
    const row = (s: string) => th.fg("border", "│") + truncateToWidth(s, inner, "…", true) + th.fg("border", "│");
    const border = th.fg(this.focused ? "accent" : "border", `╭${"─".repeat(inner)}╮`);
    if (!learning) return [border, row("理解 / スコープ未選択"), row("/understand scope で選択してください"), th.fg("border", `╰${"─".repeat(inner)}╯`)];
    const scope = learning.scope;
    const label = scope.request.kind === "module" ? `module ${scope.request.module}` : scope.request.kind === "pr" ? `PR #${scope.request.number}` : scope.request.kind === "branch" ? `branch ${scope.request.ref}${scope.request.base ? ` ← ${scope.request.base}` : " / 全体"}` : scope.request.kind === "changes" ? "未commit分 / HEAD → 作業状態" : scope.request.kind;
    const fullHeader = [
      th.fg("accent", `理解 / ${clean(label)} / ${this.focused ? "学習に入力" : "通常チャットに入力"}`),
      ...wrapTextWithAnsi(clean(scope.root), inner).slice(0, 2),
      `base ${scope.base.slice(0, 12)} → head ${scope.head.slice(0, 12)}`,
      `snapshot ${scope.snapshot.slice(0, 12)} / scope ${scope.id.slice(0, 8)}`,
      th.fg(learning.stale === "stale" ? "warning" : "muted", `${learning.stale === "unknown" ? "鮮度未確認" : learning.stale === "stale" ? "古い根拠 / refreshで更新" : "確認時点で一致"} / 収集${scope.sources.length} 未収集${scope.omitted}`),
    ];
    const header = this.tui.terminal.rows < 16 ? [fullHeader[0]!, `snapshot ${scope.snapshot.slice(0, 8)} / scope ${scope.id.slice(0, 8)}`, `base ${scope.base.slice(0, 8)} → head ${scope.head.slice(0, 8)}`] : fullHeader;
    if (this.selection !== learning.selectedPoint) { this.selection = learning.selectedPoint; this.offset = 0; this.followChat = false; }
    // Bounded IDs, not model-generated stage text, occupy the pinned minimap.
    // Even a 12-point map with long/distinct stage labels must retain every navigation target.
    const ids = learning.map.map((_node, i) => `${learning.selectedPoint === i + 1 ? "▶" : ""}${pointId(i)}`);
    const minimap = wrapTextWithAnsi(`全体図: ${ids.join(" ") || "未生成"}`, inner);
    const navigation = this.tui.terminal.rows < 16 ? minimap : ["dive N で詳細 / Ctrl+O 一操作で全体へ", ...minimap];
    const key = JSON.stringify([inner, learning.map, learning.mapSummary, learning.selectedPoint, learning.focus, learning.turns, this.partial, this.error]);
    if (this.cachedKey !== key) {
      const node = selectedNode(learning);
      const stages = new Map<string, string[]>();
      learning.map.forEach((n, i) => { const stage = stageLabel(n); const points = stages.get(stage) ?? []; points.push(`**${pointId(i)} ${n.flow}** → ${n.responsibility} / ${n.symbol}\n段階の理由: ${stageReason(n)}\n重要性: ${importanceReason(n)}`); stages.set(stage, points); });
      const map = node ? pointDetail(node, pointId(learning.selectedPoint! - 1)) : learning.map.length ? `${learning.mapSummary ?? "保存済みマップ（概要未記録）"}\n\n段階・理由は意味の解釈で、引用の正確性とは別です。\n\n${[...stages].map(([stage, points]) => `### ${stage}\n\n${points.join("\n\n")}`).join("\n\n")}` : "まだマップはありません。`/understand map` で作成します。";
      const focus = learning.focus ? `現在の焦点（スコープとは別）: ${learning.focus}` : "現在の焦点: 未指定";
      const chat = learning.turns.map(t => `**${t.role === "user" ? "あなた" : t.role === "assistant" ? "学習AI" : "状態 / 未検証"}**\n${t.text}${t.usage ? `\n\n使用量: ${t.usage.totalTokens} tokens / ${t.provider}/${t.model} / ${t.stopReason}` : ""}`).join("\n\n");
      const markdown = `## マップ\n${map}\n\n## 焦点・根拠\n${focus}\n\n引用を読む: /understand reference [path [base|head|index] [all|START-END]]\n\n## 学習チャット\n${chat || "この会話は実装AIには送られません。"}${this.partial !== undefined ? `\n\n**学習AI / 回答中**\n${this.partial}` : ""}${this.error ? `\n\n**エラー**\n${this.error}` : ""}`;
      this.cached = new Markdown(clean(markdown), 0, 0, getMarkdownTheme()).render(inner);
      this.cachedKey = key;
    }
    this.bodyLength = this.cached.length;
    this.bodyHeight = Math.max(1, height - header.length - navigation.length - 4);
    this.offset = Math.min(this.offset, Math.max(0, this.bodyLength - this.bodyHeight));
    // Overview/dive start at the top; an explicit question follows only the scrolling dialogue.
    const start = this.followChat ? Math.max(0, this.bodyLength - this.offset - this.bodyHeight) : this.offset;
    const body = this.cached.slice(start, start + this.bodyHeight);
    while (body.length < this.bodyHeight) body.push("");
    this.input.focused = this.focused;
    const footer = th.fg("muted", `${FOCUS_HINT} / Esc 通常 / ${this.actions.running() ? "Ctrl+C 中止" : "Ctrl+T 対象"}`);
    return [border, ...header.map(row), row(th.fg("border", "─".repeat(inner))), ...navigation.map(row), ...body.map(row), row(footer), ...this.input.render(inner).map(row), th.fg("border", `╰${"─".repeat(inner)}╯`)];
  }
}
