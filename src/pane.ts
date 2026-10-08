import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Markdown, getKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type Keybinding, type OverlayHandle, type OverlayOptions, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { type Learning, type Turn } from "./learning.ts";
import { claimChallenge, claimEvidence, selectedClaim, type Claim, type Evidence } from "./model.ts";

// Remove terminal control payloads from untrusted source/model output, including OSC links.
export function terminalText(value: string): string { return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""); }
export const FOCUS_SHORTCUT = "ctrl+alt+u";
/** Primary entry key. Registered by the extension; a focused overlay receives it directly and releases. */
export const ENTRY_SHORTCUT = "alt+s";
export const FOCUS_HINT = "Alt+S 表示/入力切替";
type PaneActions = { ask: (text: string) => void; cancel: () => void; close: () => void; running: () => boolean; choose?: () => void; layout?: (wide: boolean, focus: boolean) => void };
type ChatAnchor = { turn?: Turn; line: number; abs: number };
// Keep the native editing buffer across geometry remounts, including cursor/undo/paste state.
// offset is the model-region scroll; followChat/ui keep the independent dialogue position.
export type PaneView = { input: string; editor?: Input; offset: number; partial?: string; error: string; followChat?: boolean; ui?: { anchor?: ChatAnchor; learning?: Learning; seen?: string; cursor?: string; viewKey?: string; opened?: number } };

type Color = Parameters<Theme["fg"]>[0];
type Item = { key: string; command: string };
type Line = { text: string; item?: number; head?: boolean };
type ViewKind = "overview" | "claim" | "evidence";
type ModelView = { kind: ViewKind; key: string; crumb: string; pinned: string[]; lines: Line[]; items: Item[]; preferred?: string; destination: string; model?: string };
type Box = { top: number; bottom: number; left: number; right: number };

const KINDS = [["concept", "概念"], ["rule", "ルール"], ["boundary", "境界"], ["behavior", "振る舞い"], ["rationale", "理由"]] as const;
const RELATIONS: Record<Claim["relations"][number]["type"], string> = { depends: "依存", protects: "保護", constrains: "制約", explains: "理由づけ" };
// Pure navigation must not pull the dialogue to its latest line.
const NAVIGATION = /^(?:nvim(?:\s+export)?|annotations(?:\s+(?:on|off|toggle))?|diagram(?:\s+(?:preview|stop))?|map(?:\s+.*)?|dive(?:\s+.*)?|overview|back|skip|quiet|questions\s+(?:on|off)|proposal\s+clear|(?:select|claim)\s+\S+|evidence(?:\s+\d+)?)$/i;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(0, width), "…", true);
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const shortRef = (ref: string) => /^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 8) : ref;
const sameEvidence = (a: Evidence, b: Evidence) => a.path === b.path && a.ref === b.ref && a.start === b.start && a.end === b.end && a.quote === b.quote;
const EVIDENCE = /^evidence(?:\s+(\d+))?$/;
function evidenceLabel(claim: Claim, index: number): string {
  const signature = claim.signature ? 1 : 0;
  return index < signature ? "署名" : index < signature + (claim.tests?.length ?? 0) ? "テスト" : "根拠";
}
/** Hard-wrap code by display columns, preserving indentation (word wrap would drop it). */
function hardWrap(text: string, width: number): string[] {
  const out: string[] = []; let line = ""; let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = visibleWidth(segment);
    if (used + w > width && line) { out.push(line); line = ""; used = 0; }
    line += segment; used += w;
  }
  out.push(line);
  return out;
}

/**
 * Model-ownership learning pane. Model navigation (overview → claim → evidence) and the learner dialogue
 * scroll independently. Text always goes to the single native Input; navigation uses non-printing keys.
 */
export class UnderstandingPane implements Component, Focusable {
  focused = false;
  handle?: OverlayHandle;
  wide = false;
  partial?: string;
  error = "";
  private input = new Input({ prompt: "学習 > ", placeholder: "質問を入力（通常チャットとは別）" });
  private tui: TUI;
  private theme: Theme;
  private current: () => Learning | undefined;
  private actions: PaneActions;
  // Model region: UI-only highlight and scroll. Committed navigation always goes through actions.ask.
  private modelScroll = 0;
  private cursorKey?: string;
  private viewKey?: string;
  private reveal = false;
  private modelIds?: string;
  // Zero-based occurrence this pane last asked to open. Signature/tests/evidence may quote identical lines,
  // so value equality alone cannot tell which ordered entry is shown once identity is lost (restored state).
  private opened?: number;
  private model?: { view: ModelView; height: number; visible: Set<number> };
  // Dialogue region: anchored to a retained turn while reading history, so new output never moves it.
  private follow = true;
  private anchor?: ChatAnchor;
  private anchorLearning?: Learning;
  private seen = "";
  private chat?: { total: number; height: number; top: number; starts: number[]; turns: (Turn | undefined)[]; prompts: number[] };
  private geometry?: { wide: boolean; model: Box; chat: Box; items: Map<number, number> };
  private turnCache = new WeakMap<Turn, { width: number; lines: string[] }>();
  constructor(tui: TUI, theme: Theme, current: () => Learning | undefined, actions: PaneActions, wide = false, view?: PaneView) {
    this.tui = tui; this.theme = theme; this.current = current; this.actions = actions; this.wide = wide;
    if (view) {
      if (view.editor) this.input = view.editor;
      else { this.input.setValue(view.input); this.input.handleInput("\x05"); }
      this.modelScroll = view.offset; this.partial = view.partial; this.error = view.error; this.follow = view.followChat ?? true;
      if (view.ui) { this.anchor = view.ui.anchor; this.anchorLearning = view.ui.learning; this.seen = view.ui.seen ?? ""; this.cursorKey = view.ui.cursor; this.viewKey = view.ui.viewKey; this.opened = view.ui.opened; }
    }
    this.input.onSubmit = value => {
      const text = value.trim(); if (!text) return;
      if (!NAVIGATION.test(text)) this.followLatest();
      this.remember(text); this.actions.ask(text); this.input.setValue(""); this.refresh();
    };
  }
  options(): OverlayOptions {
    return { nonCapturing: true, anchor: "center", width: "96%", maxHeight: "96%", visible: (_width, height) => height >= 12 };
  }
  focus(): void {
    this.handle?.setHidden(false); this.handle?.focus(); this.redraw(this.partial);
  }
  view(): PaneView {
    return { input: this.input.getValue(), editor: this.input, offset: this.modelScroll, partial: this.partial, error: this.error, followChat: this.follow, ui: { anchor: this.anchor, learning: this.anchorLearning, seen: this.seen, cursor: this.cursorKey, viewKey: this.viewKey, opened: this.opened } };
  }
  dispose(): void {}
  release(target?: Component): void {
    this.handle?.unfocus(target ? { target } : undefined);
    this.handle?.setHidden(true); this.redraw(this.partial);
  }
  /**
   * A committed model navigation happened; the dialogue position is deliberately untouched. Leaving a view starts the next
   * at its top, but an in-place claim action (skip/quiet/questions on) keeps the reader's place in a long claim.
   */
  navigate(): void {
    const learning = this.current();
    const inPlace = !!learning && this.kindOf(learning) === "claim" && this.viewKey === `claim:${learning.selectedClaim}`;
    if (inPlace) this.reveal = true; else this.modelScroll = 0;
    this.model = undefined; this.refresh();
  }
  /** An explicit question was sent: follow the latest dialogue output. */
  followDialogue(): void { this.followLatest(); this.refresh(); }
  redraw(partial?: string): void { this.partial = partial; this.input.invalidate(); this.tui.requestRender(); }
  invalidate(): void { this.turnCache = new WeakMap(); this.input.invalidate(); }
  private refresh(): void { this.input.invalidate(); this.tui.requestRender(); }
  private followLatest(): void { this.follow = true; this.anchor = undefined; }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Pi dispatches mouse events only in fullscreen; regular mode leaves the wheel to terminal scrollback.
    // The wheel scrolls the region under the pointer and never falls through to the transcript behind.
    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (delta) { if (this.regionAt(event.x, event.y) === "model") this.scrollModel(delta); else this.scrollChat(delta); }
      return { handled: true };
    }
    // Only a completed primary click acts; press/drag stay with Pi for native text selection.
    if (event.button === "left" && event.type === "click") {
      // Rows map to items by y, so only a click inside the model region's x and y bounds may resolve one;
      // a dialogue click on the same row just focuses.
      const g = this.geometry; const { x, y } = event;
      const inModel = !!g && typeof x === "number" && typeof y === "number" && x >= g.model.left && x < g.model.right && y >= g.model.top && y < g.model.bottom;
      const item = inModel ? g!.items.get(y) : undefined;
      if (item !== undefined && this.model) {
        const key = this.model.view.items[item]?.key;
        const again = key === this.cursorKey || (event.clickCount ?? 1) >= 2;
        this.cursorKey = key;
        if (again) this.activate(); else this.refresh();
      }
      return { handled: true, focus: true };
    }
    return undefined;
  }
  handleInput(data: string): void {
    const kb = getKeybindings();
    const is = (...ids: Keybinding[]) => ids.some(id => kb.matches(data, id));
    const draft = this.input.getValue();
    // Extension shortcuts belong to the main editor; a focused overlay receives them here instead.
    if (matchesKey(data, ENTRY_SHORTCUT) || matchesKey(data, FOCUS_SHORTCUT) || matchesKey(data, "escape") || matchesKey(data, "ctrl+g")) this.release();
    else if (matchesKey(data, "ctrl+t")) this.actions.choose?.();
    else if (matchesKey(data, "ctrl+c")) { this.actions.cancel(); this.refresh(); }
    else if (matchesKey(data, "ctrl+d")) this.actions.close();
    else if (matchesKey(data, "ctrl+o")) this.leave("overview");
    else if (matchesKey(data, "ctrl+alt+a")) this.command("annotations toggle");
    else if (matchesKey(data, "ctrl+alt+n")) this.command("nvim");
    // Dialogue history uses Pi's transcript vocabulary and honours remapped keybindings.
    else if (is("tui.altScreen.pageUp", "tui.editor.pageUp")) this.scrollChat(-this.page());
    else if (is("tui.altScreen.pageDown", "tui.editor.pageDown")) this.scrollChat(this.page());
    else if (is("tui.altScreen.halfPageUp")) this.scrollChat(-Math.max(1, Math.floor(this.page() / 2)));
    else if (is("tui.altScreen.halfPageDown")) this.scrollChat(Math.max(1, Math.floor(this.page() / 2)));
    else if (is("tui.altScreen.lineUp")) this.scrollChat(-1);
    else if (is("tui.altScreen.lineDown")) this.scrollChat(1);
    else if (is("tui.altScreen.top")) this.setChatTop(0);
    else if (is("tui.altScreen.bottom")) { this.followLatest(); this.refresh(); }
    else if (is("tui.altScreen.previousPrompt")) this.jumpPrompt(-1);
    else if (is("tui.altScreen.nextPrompt")) this.jumpPrompt(1);
    // Model navigation never consumes printable text, so drafts and IME composition stay in the Input.
    else if (matchesKey(data, "shift+up")) this.pageModel(-1);
    else if (matchesKey(data, "shift+down")) this.pageModel(1);
    else if (matchesKey(data, "shift+tab")) this.step(-1, true);
    else if (is("tui.input.tab")) this.step(1, true);
    else if (is("tui.select.up")) this.step(-1, false);
    else if (is("tui.select.down")) this.step(1, false);
    else if (!draft.trim() && (is("tui.input.submit") || data === "\n")) this.activate();
    else if (!draft && matchesKey(data, "right")) { const kind = this.ensureModel()?.kind; if (kind === "overview" || kind === "claim") this.activate(); }
    else if (!draft && matchesKey(data, "left")) this.back();
    else { this.input.handleInput(data); this.refresh(); }
  }

  private page(): number { return Math.max(1, (this.chat?.height ?? 10) - 1); }
  /** Issue a host command; the cached model view is stale until rebuilt from the new state. */
  private command(text: string): void { this.remember(text); this.actions.ask(text); this.model = undefined; this.refresh(); }
  private remember(text: string): void { const match = text.match(EVIDENCE); if (match) this.opened = Number(match[1] ?? 1) - 1; }
  /**
   * Which ordered entry (signature → tests → evidence) is shown. The backend opens the actual list object,
   * so identity decides; a value-equal clone (restored state) uses the occurrence this pane opened, else the first match.
   */
  private shownIndex(list: Evidence[], shown: Evidence): number {
    const exact = list.indexOf(shown); if (exact >= 0) return exact;
    const opened = this.opened !== undefined ? list[this.opened] : undefined;
    if (opened && sameEvidence(opened, shown)) return this.opened!;
    return list.findIndex(e => sameEvidence(e, shown));
  }
  private kindOf(learning: Learning): ViewKind {
    if (learning.evidenceView) return "evidence";
    if (selectedClaim(learning)) return "claim";
    return "overview";
  }
  private ensureModel(): ModelView | undefined {
    if (this.model) return this.model.view;
    const learning = this.current(); if (!learning) return undefined;
    const view = this.build(learning, 60); this.sync(view); return view;
  }
  private step(delta: number, cycle: boolean): void {
    const view = this.ensureModel(); if (!view) return;
    if (view.kind === "evidence") {
      if (!cycle) { this.scrollModel(delta); return; }
      const learning = this.current(); if (!learning) return;
      const claim = selectedClaim(learning); const list = claim ? claimEvidence(claim) : []; if (list.length < 2) return;
      const index = Math.max(0, this.shownIndex(list, learning.evidenceView!)); this.command(`evidence ${(index + delta + list.length) % list.length + 1}`);
      return;
    }
    if (!cycle && this.model?.view === view) { this.read(view, delta); return; }
    const items = view.items; if (!items.length) return;
    const index = items.findIndex(i => i.key === this.cursorKey);
    // A highlight scrolled out of sight is revealed before it moves, so a keypress never acts unseen.
    if (index >= 0 && this.model && !this.model.visible.has(index)) { this.reveal = true; this.refresh(); return; }
    const next = cycle ? (index + delta + items.length) % items.length : clamp(index + delta, 0, items.length - 1);
    this.cursorKey = items[next]!.key; this.reveal = true; this.refresh();
  }
  /**
   * ↑/↓ read the model continuously: the adjacent row is selected only once it is on screen (or the very next line),
   * otherwise the viewport moves one line. Long details are never skipped to reach a control, with or without controls.
   */
  private read(view: ModelView, delta: number): void {
    const { lines, items } = view; const height = this.model!.height;
    const top = clamp(this.modelScroll, 0, Math.max(0, lines.length - height)); const bottom = top + height;
    const heads = items.map((_, i) => lines.findIndex(l => l.item === i));
    const cursor = items.findIndex(i => i.key === this.cursorKey);
    const seen = cursor >= 0 && heads[cursor]! >= top && heads[cursor]! < bottom;
    // An off-screen highlight is not a starting point: selection resumes from what is on screen.
    const next = delta > 0 ? (seen ? cursor + 1 : heads.findIndex(h => h >= top)) : (seen ? cursor - 1 : heads.findLastIndex(h => h < bottom));
    const head = heads[next];
    if (head !== undefined && head >= top - 1 && head <= bottom) {
      let last = head; while (lines[last + 1]?.item === next) last++;
      this.cursorKey = items[next]!.key;
      this.modelScroll = head < top ? head : last >= bottom ? Math.min(head, last - height + 1) : top;
    } else this.modelScroll = clamp(top + delta, 0, Math.max(0, lines.length - height));
    this.model!.visible = this.headsIn(view, this.modelScroll, height); this.refresh();
  }
  /** Shift+↑/↓ page the model by its own height (one line overlaps), leaving the dialogue and highlight alone. */
  private pageModel(direction: -1 | 1): void {
    const view = this.ensureModel(); const model = this.model; if (!view || !model || model.view !== view) return;
    this.modelScroll = clamp(this.modelScroll + direction * Math.max(1, model.height - 1), 0, Math.max(0, view.lines.length - model.height));
    model.visible = this.headsIn(view, this.modelScroll, model.height); this.refresh();
  }
  /** Items reachable by Enter: those whose first row is on screen. */
  private headsIn(view: ModelView, top: number, height: number): Set<number> {
    const visible = new Set<number>();
    view.lines.forEach((line, row) => { if (line.item !== undefined && row >= top && row < top + height && view.lines[row - 1]?.item !== line.item) visible.add(line.item); });
    return visible;
  }
  private activate(): void {
    const view = this.ensureModel(); if (!view) return;
    if (view.kind === "evidence") { this.back(); return; }
    const index = view.items.findIndex(i => i.key === this.cursorKey);
    if (index < 0) return;
    if (this.model && !this.model.visible.has(index)) { this.reveal = true; this.refresh(); return; }
    const command = view.items[index]!.command; if (!command) return;
    if (command === "model") this.followLatest();
    this.command(command);
  }
  private back(): void {
    const learning = this.current();
    if (learning && this.kindOf(learning) !== "overview") this.leave("back");
  }
  /** Leave the current view and highlight the item just left, decided now rather than at the next render. */
  private leave(command: "back" | "overview"): void {
    const learning = this.current();
    const claim = learning && selectedClaim(learning);
    let target: { view: string; cursor: string } | undefined;
    if (learning && claim && learning.evidenceView && command === "back") target = { view: `claim:${claim.id}`, cursor: `evidence:${this.shownIndex(claimEvidence(claim), learning.evidenceView) + 1}` };
    else if (claim) target = { view: "overview", cursor: `claim:${claim.id}` };
    this.command(command);
    const now = learning && (this.kindOf(learning) === "overview" ? "overview" : selectedClaim(learning) && !learning.evidenceView ? `claim:${learning.selectedClaim}` : undefined);
    // Below a long detail the row just left is revealed, not hidden under the top of the view.
    if (target && now === target.view) { this.viewKey = target.view; this.cursorKey = target.cursor; this.modelScroll = 0; this.reveal = true; }
  }
  private scrollModel(delta: number): void { this.modelScroll = Math.max(0, this.modelScroll + delta); this.refresh(); }
  private scrollChat(delta: number): void {
    const chat = this.chat; if (!chat) return;
    this.setChatTop(chat.top + delta);
  }
  private setChatTop(top: number): void {
    const chat = this.chat; const learning = this.current(); if (!chat || !learning) return;
    const max = Math.max(0, chat.total - chat.height);
    top = clamp(top, 0, max);
    if (top >= max) this.followLatest();
    else {
      if (this.follow || this.anchorLearning !== learning) this.seen = this.signature(learning);
      this.follow = false; this.anchorLearning = learning;
      let block = 0; while (block + 1 < chat.starts.length && chat.starts[block + 1]! <= top) block++;
      const turn = chat.turns[block];
      this.anchor = turn ? { turn, line: top - chat.starts[block]!, abs: top } : { line: 0, abs: top };
    }
    chat.top = top; this.refresh();
  }
  private jumpPrompt(direction: -1 | 1): void {
    const chat = this.chat; if (!chat) return;
    const target = direction < 0 ? [...chat.prompts].reverse().find(p => p < chat.top) ?? 0 : chat.prompts.find(p => p > chat.top);
    if (target === undefined) { this.followLatest(); this.refresh(); } else this.setChatTop(target);
  }
  private regionAt(x: number | undefined, y: number | undefined): "model" | "chat" {
    const g = this.geometry; if (!g || typeof x !== "number" || typeof y !== "number") return "chat";
    const inside = (b: Box) => g.wide ? x >= b.left && x < b.right : y >= b.top && y < b.bottom;
    return inside(g.model) ? "model" : "chat";
  }
  private signature(learning: Learning): string { return `${learning.turns.length}:${learning.turns.at(-1)?.timestamp ?? 0}:${this.partial?.length ?? -1}:${this.error.length}`; }

  /** Build the model region for one committed view; pure presentation of backend state. */
  private build(learning: Learning, width: number): ModelView {
    const th = this.theme; const clean = terminalText;
    const lines: Line[] = []; const items: Item[] = [];
    const raw = (text: string) => { lines.push({ text }); };
    const text = (value: string, color?: Color, w = width) => { for (const line of wrapTextWithAnsi(clean(value), w)) lines.push({ text: color ? th.fg(color, line) : line }); };
    const item = (key: string, command: string, label: string[]) => { const index = items.push({ key, command }) - 1; label.forEach((l, i) => lines.push({ text: l, item: index, head: i === 0 })); };
    const wrapped = (value: string, color?: Color) => wrapTextWithAnsi(clean(value), width - 2).map(l => color ? th.fg(color, l) : l);
    const markdown = (value: string) => { for (const line of new Markdown(clean(value), 0, 0, getMarkdownTheme()).render(width)) raw(line); };
    const tag = (claim: Claim) => claim.status === "inferred" ? th.fg("warning", "推論") : th.fg("muted", "現状");
    const kindLabel = (claim: Claim) => KINDS.find(([k]) => k === claim.kind)?.[1] ?? claim.kind;
    const claims = learning.claims ?? [];
    const claim = selectedClaim(learning);
    const running = this.actions.running();

    if (learning.evidenceView) {
      const shown = learning.evidenceView;
      const list = claim ? claimEvidence(claim) : [shown];
      const index = this.shownIndex(list, shown);
      const label = claim && index >= 0 ? evidenceLabel(claim, index) : "根拠";
      const position = index >= 0 ? `${index + 1}/${list.length}` : "";
      raw(th.fg("accent", clean(`${label} · ${shortRef(shown.ref)}:${shown.path}:${shown.start}-${shown.end}`)));
      text("固定snapshotの正確な引用（照合済み）", "muted");
      text("引用は主張の正しさを証明しません", "muted");
      raw("");
      if (shown.annotations?.length) text(`AI注釈: ${learning.annotationsVisible === false ? "非表示" : "解釈（未保証）"} · Ctrl+Alt+A 切替`, "warning");
      const digits = String(shown.end).length;
      shown.quote.split("\n").forEach((line, i) => {
        if (learning.annotationsVisible !== false) for (const a of shown.annotations ?? []) if (a.start === shown.start + i) {
          const wrapped = wrapTextWithAnsi(clean(`AI解釈 L${a.start}-${a.end} · ${a.text}`), width);
          wrapped.slice(0, 3).forEach((part, j) => raw(th.fg("warning", j === 2 && wrapped.length > 3 ? truncateToWidth(`${part}…`, width, "…") : part)));
        }
        hardWrap(clean(line).replace(/\t/g, "  "), Math.max(4, width - digits - 3)).forEach((part, j) => raw(th.fg("dim", j ? `${" ".repeat(digits)} ┆ ` : `${String(shown.start + i).padStart(digits)} │ `) + part));
      });
      return { kind: "evidence", key: `evidence:${claim?.id ?? ""}:${index + 1}`, crumb: `全体 › ${claim?.id ?? "主張"} › ${label} ${position}`, pinned: [], lines, items, destination: `${claim?.id ?? "主張"}（${label}${position ? ` ${position}` : ""} を表示中）` };
    }
    if (claim) {
      raw(`${th.fg("accent", kindLabel(claim))} · ${tag(claim)} · ${th.fg("dim", clean(claim.id))}`);
      for (const line of wrapTextWithAnsi(clean(claim.statement), width)) raw(th.bold(line));
      text(claim.status === "inferred" ? "AIの解釈。引用があっても意味は未保証" : "引用で裏付けた現在の振る舞い（意味は解釈）", claim.status === "inferred" ? "warning" : "muted");
      if (claim.detail) { raw(""); markdown(claim.detail); }
      const challenge = claimChallenge(learning);
      if (claim.challenge) {
        raw("");
        if (challenge) {
          raw(th.fg("accent", "問い（任意 · 答えなくても先へ進めます）"));
          text(challenge);
          text("答えるなら入力欄へ書いて Enter。", "muted");
          item("action:skip", "skip", wrapped("この問いをスキップ"));
          item("action:quiet", "quiet", wrapped("問いをすべて出さない（quiet）", "muted"));
        } else if (!learning.questions) item("action:questions-on", "questions on", wrapped("問いは非表示中 · 再開する", "muted"));
        else text("この問いはスキップしました。", "muted");
      }
      const evidence = claimEvidence(claim);
      raw("");
      raw(`${th.fg("accent", `根拠 ${evidence.length}件`)} ${th.fg("muted", "署名 → テスト → 根拠")}`);
      if (!evidence.length) text("引用はありません（推論）。根拠を尋ねるなら入力欄へ。", "muted");
      evidence.forEach((e, i) => { const kind = evidenceLabel(claim, i); item(`evidence:${i + 1}`, `evidence ${i + 1}`, [fit(`${i + 1} ${kind}${" ".repeat(7 - visibleWidth(kind))}${clean(`${shortRef(e.ref)}:${e.path}:${e.start}-${e.end}`)}`, width - 2)]); });
      if (!claim.tests?.length) text("守るテストの引用はありません（存在しないとは限りません）。", "muted");
      if (claim.relations.length) {
        raw(""); raw(th.fg("accent", "関係"));
        for (const r of claim.relations) {
          const target = claims.find(c => c.id === r.to);
          item(`relation:${r.to}`, `select ${r.to}`, [fit(`${RELATIONS[r.type]} → ${clean(r.to)} ${th.fg("muted", clean(target?.statement ?? ""))}`, width - 2)]);
        }
      }
      return { kind: "claim", key: `claim:${claim.id}`, crumb: `全体 › ${kindLabel(claim)} › ${claim.id}`, pinned: [], lines, items, preferred: evidence.length ? "evidence:1" : items[0]?.key, destination: `${claim.id}「${claim.statement}」` };
    }
    if (claims.length) {
      if (learning.modelSummary) text(learning.modelSummary);
      text("現状=引用あり · 推論=AIの解釈（意味は未保証）", "muted");
      for (const [kind, label] of KINDS) {
        const group = claims.filter(c => c.kind === kind); if (!group.length) continue;
        raw(""); raw(th.fg("mdHeading", `${label} ${group.length}`));
        // The statement is the overview's content: up to two lines; the ID is secondary and only shown with room.
        for (const c of group) {
          const room = width - 2 - 5;
          const parts = wrapTextWithAnsi(clean(c.statement), room);
          const shown = parts.slice(0, 2); if (parts.length > 2) shown[1] = truncateToWidth(`${shown[1]}…`, room, "…");
          const id = clean(c.id); const last = shown.length - 1;
          const label = shown.map((l, i) => `${i ? "     " : `${tag(c)} `}${l}`);
          if (width >= 64 && visibleWidth(shown[last]!) + visibleWidth(id) + 2 <= room) label[last] = fit(label[last]!, width - 3 - visibleWidth(id)) + " " + th.fg("dim", id);
          item(`claim:${c.id}`, `select ${c.id}`, label);
        }
      }
      raw("");
      if (learning.interactions && !learning.interactionIssue) item("action:diagram", "diagram", wrapped("相互作用図をブラウザで開く（推論・公開なし）"));
      else text(learning.interactionIssue ?? "相互作用図は未記録です。model で明示的に再生成できます。", "muted");
      item("action:model", running ? "" : "model", wrapped(running ? "生成・回答中… 進捗は会話欄（Ctrl+C で中止）" : "モデルを作り直す（置き換え · GPT呼出し）", "muted"));
    } else {
      raw(th.bold("モデルはまだありません"));
      text("概念・ルール・境界・振る舞い・判断理由を、固定した対象から根拠付きで生成します。変更がないrepositoryでも使えます。生成中は Ctrl+C で中止できます。", "muted");
      raw("");
      item("action:model", running ? "" : "model", running ? wrapped("生成・回答中… 進捗は会話欄（Ctrl+C で中止）") : wrapped("モデルを生成する（GPT呼出し）").map(l => th.bold(l)));
    }
    // A prospective change is a hypothesis: kept in its own block, never mixed into current claims.
    if (learning.proposal) {
      raw("");
      raw(th.bold(th.fg("warning", "仮説 · 未実装の変更案（現状の事実ではありません）")));
      text(learning.proposal);
      item("action:proposal-clear", "proposal clear", wrapped("仮説を解除", "muted"));
    }
    if (!learning.questions) { raw(""); item("action:questions-on", "questions on", wrapped("問いは非表示中 · 再開する", "muted")); }
    return { kind: "overview", key: "overview", crumb: claims.length ? "全体 · モデル" : "全体", pinned: [], lines, items, preferred: items.find(i => i.key.startsWith("claim:"))?.key ?? "action:model", destination: "全体", model: claims.map(c => c.id).join("\n") };
  }
  /** Keep the UI highlight stable per committed view, returning to the item just left. */
  private sync(view: ModelView): void {
    if (view.key !== this.viewKey) {
      const previous = this.viewKey; this.viewKey = view.key; this.modelScroll = 0; this.reveal = false;
      let preferred = view.preferred;
      if (view.kind === "overview" && previous && /^claim:/.test(previous)) preferred = previous;
      if (view.kind === "claim" && previous?.startsWith("evidence:")) preferred = `evidence:${previous.split(":").at(-1)}`;
      this.cursorKey = view.items.some(i => i.key === preferred) ? preferred : view.items[0]?.key;
    }
    // A newly generated (or replaced) model starts at its first claim, not on the action that produced it.
    if (view.model !== undefined && view.model !== this.modelIds) { if (this.modelIds !== undefined) { this.cursorKey = view.preferred; this.modelScroll = 0; } this.modelIds = view.model; }
    if (!view.items.some(i => i.key === this.cursorKey)) this.cursorKey = view.items.some(i => i.key === view.preferred) ? view.preferred : view.items[0]?.key;
  }
  private modelRows(view: ModelView, width: number, height: number, rows: Map<number, number>, origin: number): string[] {
    const th = this.theme;
    const pinned = view.pinned.slice(0, Math.max(0, height - 1));
    const body = height - pinned.length;
    const cursor = view.items.findIndex(i => i.key === this.cursorKey);
    const max = Math.max(0, view.lines.length - body);
    if (this.reveal && cursor >= 0) {
      const first = view.lines.findIndex(l => l.item === cursor);
      let last = first; while (view.lines[last + 1]?.item === cursor) last++;
      if (cursor === 0 && last < body) this.modelScroll = 0;
      else if (first < this.modelScroll) this.modelScroll = first;
      else if (last >= this.modelScroll + body) this.modelScroll = last - body + 1;
    }
    this.reveal = false;
    this.modelScroll = clamp(this.modelScroll, 0, max);
    const out = pinned.map(line => ` ${fit(line, width)} `);
    for (let r = 0; r < body; r++) {
      const line = view.lines[this.modelScroll + r];
      const bar = this.scrollbar(view.lines.length, body, this.modelScroll, r);
      if (!line) { out.push(` ${" ".repeat(Math.max(0, width))}${bar}`); continue; }
      if (line.item === undefined) { out.push(` ${fit(line.text, width)}${bar}`); continue; }
      rows.set(origin + pinned.length + r, line.item);
      const selected = line.item === cursor;
      const marker = selected && line.head ? th.fg("accent", "▸ ") : "  ";
      const cell = fit(marker + line.text, width);
      out.push(` ${selected ? th.bg("selectedBg", cell) : cell}${bar}`);
    }
    // An item is reachable by Enter only when its first row is on screen.
    this.model = { view, height: body, visible: this.headsIn(view, this.modelScroll, body) };
    return out;
  }
  /** Model reading position beside the crumb, like the dialogue's ↑/↓ status; shown only when the model overflows. */
  private modelTitle(crumb: string, width: number): string {
    const model = this.model; const left = ` ${crumb}`;
    if (!model || model.view.lines.length <= model.height) return fit(left, width);
    const below = Math.max(0, model.view.lines.length - model.height - this.modelScroll);
    const room = width - visibleWidth(left) - 2;
    const status = [`↑${this.modelScroll}行 ↓${below}行 · Shift+↑↓ ページ`, `↑${this.modelScroll}行 ↓${below}行`].find(s => visibleWidth(s) <= room);
    return status ? fit(left, width - visibleWidth(status) - 1) + this.theme.fg(below ? "muted" : "dim", status) + " " : fit(left, width);
  }
  private scrollbar(count: number, height: number, top: number, row: number): string {
    if (count <= height || height < 2) return " ";
    const thumb = Math.max(1, Math.round(height * height / count));
    const position = Math.round(top / (count - height) * (height - thumb));
    return row >= position && row < position + thumb ? this.theme.fg("scrollbarThumb", "┃") : " ";
  }
  private turnLines(turn: Turn, width: number): string[] {
    const cached = this.turnCache.get(turn); if (cached?.width === width) return cached.lines;
    const th = this.theme; const clean = terminalText;
    const lines: string[] = [];
    const plain = (value: string, color?: Color) => { for (const part of clean(value).split("\n")) for (const line of wrapTextWithAnsi(part, width)) lines.push(color ? th.fg(color, line) : line); };
    if (turn.role === "user") {
      const label = turn.intent === "model" ? "あなた · モデル生成を依頼" : turn.intent === "map" ? "あなた · 旧マップ生成を依頼" : turn.intent === "proposal" ? "あなた · 変更案（仮説として相談）" : "あなた";
      lines.push(th.bold(th.fg(turn.intent === "proposal" ? "warning" : "accent", label)));
      plain(turn.text, turn.intent === "model" || turn.intent === "map" ? "muted" : undefined);
    } else if (turn.role === "assistant") {
      lines.push(th.bold(`学習AI${turn.intent === "model" ? " · モデル生成" : turn.intent === "proposal" ? " · 仮説への回答（未実装）" : ""}`));
      lines.push(...new Markdown(clean(turn.text), 0, 0, getMarkdownTheme()).render(width));
    } else {
      const question = turn.text.startsWith("任意の理解確認");
      lines.push(th.bold(th.fg(question ? "accent" : "muted", question ? "問い（任意）" : "状態")));
      plain(turn.text, question ? undefined : "muted");
    }
    const meta: string[] = [];
    if (turn.usage) meta.push(`${turn.usage.totalTokens} tokens · ${turn.model ?? ""}${turn.stopReason && turn.stopReason !== "stop" ? ` · ${turn.stopReason}` : ""}`);
    if (turn.read?.length) {
      const count = (...status: string[]) => turn.read!.filter(r => status.includes(r.status)).length;
      const missing = count("unavailable", "excluded", "uncaptured", "budget");
      meta.push(`根拠 送信${count("sent")} · 取得${count("fetched")}${count("searched") ? ` · 検索${count("searched")}` : ""}${missing ? ` · 読めず${missing}` : ""}`);
    }
    if (turn.styleSkill) meta.push("yomiyasu文体指示");
    if (meta.length) plain(meta.join(" · "), "dim");
    lines.push("");
    this.turnCache.set(turn, { width, lines });
    return lines;
  }
  private chatRows(learning: Learning, width: number, height: number, fullscreen: boolean): { rows: string[]; status: string } {
    const th = this.theme;
    const all: string[] = []; const starts: number[] = []; const turns: (Turn | undefined)[] = []; const prompts: number[] = [];
    for (const turn of learning.turns) {
      starts.push(all.length); turns.push(turn);
      if (turn.role === "user") prompts.push(all.length);
      all.push(...this.turnLines(turn, width));
    }
    if (this.partial !== undefined) {
      starts.push(all.length); turns.push(undefined);
      const fetching = this.partial.startsWith("固定根拠");
      all.push(th.bold(fetching ? th.fg("muted", "根拠を取得中") : "学習AI · 回答中…"));
      if (fetching) for (const line of wrapTextWithAnsi(terminalText(this.partial), width)) all.push(th.fg("muted", line));
      else all.push(...new Markdown(terminalText(this.partial || "…"), 0, 0, getMarkdownTheme()).render(width));
    }
    if (this.error) {
      starts.push(all.length); turns.push(undefined);
      all.push(th.bold(th.fg("error", "エラー")));
      for (const line of wrapTextWithAnsi(terminalText(this.error), width)) all.push(th.fg("error", line));
    }
    if (!all.length) for (const line of ["選択中の主張や全体について、入力欄から自由に質問できます。", "これからの変更案は「proposal 内容」で仮説として相談できます。"]) all.push(...wrapTextWithAnsi(line, width).map(l => th.fg("muted", l)));
    const max = Math.max(0, all.length - height);
    let top = max;
    if (!this.follow) {
      if (this.anchorLearning !== learning || !this.anchor) this.followLatest();
      else if (this.anchor.turn) { const block = turns.indexOf(this.anchor.turn); top = block < 0 ? 0 : starts[block]! + this.anchor.line; }
      else top = this.anchor.abs;
    }
    top = clamp(top, 0, max);
    this.chat = { total: all.length, height, top, starts, turns, prompts };
    const fresh = !this.follow && this.signature(learning) !== this.seen;
    // The scroll affordance sits on the dialogue itself; regular mode never promises the wheel.
    const status = this.follow ? (max ? `最新 · ${fullscreen ? "ホイール/" : ""}PgUp で遡る` : "") : `↑${top}行 ↓${max - top}行 · ${fresh ? "新着 " : ""}Ctrl+End`;
    const rows: string[] = [];
    for (let r = 0; r < height; r++) rows.push(` ${fit(all[top + r] ?? "", width)}${this.scrollbar(all.length, height, top, r)}`);
    return { rows, status: fresh ? th.fg("warning", status) : th.fg("muted", status) };
  }
  /** One border line with left/right labels: ╭─ title ───── tail ─╮ */
  private edge(left: string, right: string, width: number, title: string, tail: string, color: Color): string {
    const B = (s: string) => this.theme.fg(color, s);
    let t = title ? ` ${title} ` : ""; let r = tail ? ` ${tail} ` : "";
    const room = width - 2;
    if (visibleWidth(t) + visibleWidth(r) > room) r = "";
    if (visibleWidth(t) > room) t = truncateToWidth(t, room, "…");
    return B(left + "─") + t + B("─".repeat(Math.max(0, room - visibleWidth(t) - visibleWidth(r)))) + r + B("─" + right);
  }
  private segment(width: number, left: string, right: string, color: Color): string {
    if (width < 3) return this.theme.fg(color, "─".repeat(Math.max(0, width)));
    const B = (s: string) => this.theme.fg(color, s);
    let t = left ? ` ${left} ` : ""; let r = right ? ` ${right} ` : "";
    if (visibleWidth(t) + visibleWidth(r) > width - 2) r = "";
    if (visibleWidth(t) > width - 2) t = truncateToWidth(t, width - 2, "…");
    return B("─") + t + B("─".repeat(Math.max(0, width - 2 - visibleWidth(t) - visibleWidth(r)))) + r + B("─");
  }
  render(width: number): string[] {
    if (width < 4) return [truncateToWidth("理解", width)];
    const th = this.theme; const clean = terminalText;
    const inner = width - 2;
    const total = Math.max(8, Math.floor(this.tui.terminal.rows * .96));
    const color: Color = this.focused ? "accent" : "border";
    const B = (s: string) => th.fg(color, s);
    const row = (s: string) => B("│") + fit(s, inner) + B("│");
    this.input.focused = this.focused;
    const inputLine = ` ${this.input.render(inner - 1)[0] ?? ""}`;
    const learning = this.current();
    if (!learning) {
      this.geometry = undefined; this.model = undefined; this.chat = undefined;
      return [this.edge("╭", "╮", inner, th.bold("理解"), "", color), row(" 理解対象が未選択です。Ctrl+T で選択できます。"), row(inputLine), this.edge("╰", "╯", inner, th.fg("muted", "Ctrl+T 対象 · Alt+S 閉じる"), "", color)];
    }
    const running = this.actions.running();
    const fullscreen = (this.tui as { mode?: string }).mode === "fullscreen";
    const scope = learning.scope; const request = scope.request;
    const label = request.kind === "module" ? `module ${request.module}` : request.kind === "pr" ? `PR #${request.number}` : request.kind === "branch" ? `branch ${request.ref}${request.base ? ` ← ${request.base}` : " / 全体"}` : request.kind === "changes" ? "未commit分 / HEAD → 作業状態" : request.kind === "commit" ? `commit ${request.ref.slice(0, 12)}` : "repository 全体";
    const fresh = learning.stale === "stale" ? th.fg("warning", "作業状態が変化（refreshで新しい対象）") : learning.stale === "unknown" ? th.fg("muted", "鮮度未確認") : th.fg("muted", "根拠一致");
    const optional = [`head ${scope.head.slice(0, 8)}`, `scope ${scope.id.slice(0, 8)}`].map(s => th.fg("dim", s));
    const tags = [running ? th.fg("warning", "回答中") : "", !learning.questions ? th.fg("muted", "問いオフ") : "", learning.proposal ? th.fg("warning", "仮説あり") : ""].filter(Boolean);
    const tail = this.focused ? th.fg("accent", "学習入力") : th.fg("muted", "通常入力 · Alt+S で戻る");
    let header = [th.bold("理解"), clean(label), fresh, ...tags, ...optional];
    while (header.length > 3 && visibleWidth(header.join(" · ")) + visibleWidth(tail) + 6 > inner) header = header.slice(0, -1);
    const out = [this.edge("╭", "╮", inner, header.join(" · "), tail, color)];

    const wide = inner >= 100;
    const kind = this.kindOf(learning);
    const leftW = wide ? clamp(Math.round(inner * (kind === "evidence" ? .58 : .46)), 40, inner - 41) : inner;
    const chatW = wide ? inner - leftW - 1 : inner;
    const modelW = Math.max(2, leftW - 2); const chatContent = Math.max(2, chatW - 2);
    const view = this.build(learning, modelW); this.sync(view);
    const content = Math.max(2, total - (wide ? 5 : 6));
    const modelH = wide ? content : clamp(Math.round(content * .55), 1, content - 1);
    const chatH = wide ? content : content - modelH;
    const items = new Map<number, number>();
    const crumb = th.bold(th.fg("accent", clean(view.crumb)));
    const chatTitle = `${th.bold("会話")} ${th.fg("muted", "· 実装AIには送られません")}`;
    if (wide) {
      const model = this.modelRows(view, modelW, content, items, 2);
      const chat = this.chatRows(learning, chatContent, content, fullscreen);
      const statusW = visibleWidth(chat.status);
      out.push(B("│") + this.modelTitle(crumb, leftW) + B("│") + fit(` ${chatTitle}`, chatW - statusW - 1) + chat.status + " " + B("│"));
      for (let r = 0; r < content; r++) out.push(B("│") + fit(model[r]!, leftW) + B("│") + fit(chat.rows[r]!, chatW) + B("│"));
      this.geometry = { wide, model: { top: 1, bottom: 2 + content, left: 1, right: 1 + leftW }, chat: { top: 1, bottom: 2 + content, left: 2 + leftW, right: 1 + inner }, items };
    } else {
      const model = this.modelRows(view, modelW, modelH, items, 2);
      out.push(B("│") + this.modelTitle(crumb, inner) + B("│"));
      for (const line of model) out.push(B("│") + fit(line, inner) + B("│"));
      const chat = this.chatRows(learning, chatContent, chatH, fullscreen);
      out.push(B("├") + this.segment(inner, chatTitle, chat.status, color) + B("┤"));
      for (const line of chat.rows) out.push(B("│") + fit(line, inner) + B("│"));
      this.geometry = { wide, model: { top: 1, bottom: 2 + modelH, left: 1, right: 1 + inner }, chat: { top: 2 + modelH, bottom: 3 + modelH + chatH, left: 1, right: 1 + inner }, items };
    }
    const draft = this.input.getValue();
    const destination = `${th.fg("muted", "宛先")} ${clean(view.destination)}${running ? th.fg("warning", " · 回答中（Ctrl+C 中止）") : ""}`;
    const proposalHint = th.fg("dim", "変更案は proposal 内容");
    if (wide) out.push(B("├") + this.segment(leftW, destination, "", color) + B("┴") + this.segment(chatW, "", draft ? "" : proposalHint, color) + B("┤"));
    else out.push(B("├") + this.segment(inner, destination, "", color) + B("┤"));
    out.push(row(inputLine));
    // Ordered by priority: the border truncates from the right on narrow terminals.
    const reading = view.kind === "evidence";
    // An overflowing claim/overview is read with ↑↓ (controls are taken as they come into view); Tab jumps between controls.
    const long = !!this.model && view.lines.length > this.model.height;
    const hints = [
      running ? "Ctrl+C 中止" : "",
      draft.trim() ? "Enter 送信" : reading ? "Enter/← 戻る" : this.cursorKey?.startsWith("action:") ? "Enter 実行" : view.items.length ? "Enter 開く" : "",
      view.kind === "evidence" ? "Tab 次の根拠 · ↑↓ 行" : long ? (view.items.length ? "↑↓ 読む · Tab 選択" : "↑↓ 読む") : view.items.length ? "↑↓/Tab 選択" : "",
      view.kind === "evidence" ? "Ctrl+Alt+N Neovim" : "",
      view.kind === "claim" && !draft ? "← 戻る" : "",
      view.kind !== "overview" ? "Ctrl+O 全体" : "",
      "Alt+S 閉じる",
      // The dialogue divider also carries its own PgUp/Ctrl+End affordance.
      "PgUp/PgDn 会話",
      "Ctrl+T 対象",
    ].filter(Boolean);
    out.push(this.edge("╰", "╯", inner, th.fg("muted", hints.join(" · ")), "", color));
    return out;
  }
}
