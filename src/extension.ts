import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectScope, repositoryIdentity, fingerprint, pinnedFile, type ScopeRequest } from "./scope.ts";
import { ENTRY, freshState, freshLearning, restore, LearningRunner, addReference, type State, type Learning, type Publication } from "./learning.ts";
import { UnderstandingPane, terminalText, type PaneView } from "./pane.ts";
import { openDiagram } from "./diagram.ts";

export const HELP = `理解ペインは通常チャットとは別のGPT会話です。通常チャットの内容は読みません。
/understand [open|toggle|focus|close|wide] — 背景表示 / 入力先変更
/understand scope — 選択画面
/understand scope repository — tracked worktreeを固定
/understand scope module path — module配下を固定
/understand scope commit REF PARENT — 明示した親との差分
/understand scope pr NUMBER — ghのPR情報と固定Gitオブジェクト
/understand scopes — このbranchに保存したスコープへ戻る
/understand check | refresh — 鮮度確認 / 明示更新（自動更新しません）
/understand map | ask 質問 — 学習AIを呼ぶ
/understand focus 対象 — 焦点のみ変更
/understand reference path [base|head] — 固定内容の行番号表示
/understand questions on|off — milestoneの任意の理解確認
/understand handoff — 内容を編集・確認して実装チャットへ明示送信
/understand diagram — 根拠付きマップのみHTML保存・表示
/understand reset | forget — 会話消去 / 現在スコープを削除
学習入力: Esc/Ctrl+G 通常入力、Ctrl+C 学習中止、Ctrl+D 閉じる、Ctrl+O 広表示、PgUp/PgDn 履歴。
110列未満では背景ペインを隠します。focusで広表示。ペインは重ね表示で、通常チャットの幅は変えません。`;
export function parseScope(args: string): ScopeRequest {
  if (args === "repository") return { kind: "repository" };
  if (args.startsWith("module ")) return { kind: "module", module: args.slice(7).trim() };
  const commit = args.match(/^commit\s+(\S+)\s+(\S+)$/);
  if (commit) return { kind: "commit", ref: commit[1]!, parent: commit[2]! };
  const pr = args.match(/^pr\s+(\d+)$/);
  if (pr) return { kind: "pr", number: pr[1]! };
  throw new Error("scope repository | module PATH | commit REF PARENT | pr NUMBER");
}
export default function understanding(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let state: State = freshState("");
  let pane: UnderstandingPane | undefined;
  let finish: (() => void) | undefined;
  let generation = 0;
  const runner = new LearningRunner();
  const current = (): Learning | undefined => state.active ? state.scopes[state.active] : undefined;
  const save = () => {
    const l = current();
    if (l) {
      let removed = 0;
      while (l.turns.length > 40 || l.turns.reduce((n, t) => n + t.text.length, 0) > 60_000) { l.turns.shift(); removed++; }
      if (removed) l.turns.unshift({ role: "notice", text: `保存上限のため以前の${removed}件を省略しました。`, timestamp: Date.now() });
    }
    pi.appendEntry(ENTRY, structuredClone(state));
  };
  const close = () => { finish?.(); finish = undefined; pane = undefined; };
  const detachLearning = () => {
    generation++;
    const l = current();
    if (l?.pending) { l.pending = false; l.turns.push({ role: "notice", text: "スコープ・branch・sessionの変更で学習呼出しを中止しました。確定した使用量は取得できていません。", timestamp: Date.now() }); save(); }
    runner.detach();
  };
  const cleanup = () => { detachLearning(); close(); };
  const notify = (message: string, kind: "info" | "warning" | "error" = "info") => ctx?.ui.notify(terminalText(message), kind);
  const redraw = (partial?: string) => pane?.redraw(partial);
  const ask = (prompt: string) => {
    const learning = current(); const context = ctx;
    if (!learning || !context) { notify("先にscopeを明示選択してください。", "warning"); return; }
    void runner.ask(context, learning, prompt, redraw, save).catch(error => { if (pane) { pane.error = String(error); redraw(); } notify(String(error), "error"); });
  };
  const open = (context: ExtensionContext, focus = false, wide = false, view?: PaneView): void => {
    if (context.mode !== "tui") { notify("ペインはTUI専用です。scope/check/map/askは非TUIでも利用できます。", "warning"); return; }
    if (pane) { pane.handle?.setHidden(false); if (focus) pane.focus(); return; }
    let created: UnderstandingPane | undefined;
    void context.ui.custom<void>((tui, theme, _kb, done) => {
      finish = () => done();
      created = new UnderstandingPane(tui, theme, current, { ask, cancel: () => runner.cancel(), close, running: () => runner.running, layout: (nextWide, nextFocus) => {
        if (pane !== created) return;
        const previous = created?.view(); close(); open(context, nextFocus, nextWide, previous);
      } }, wide, view);
      pane = created;
      return created;
    }, { overlay: true, overlayOptions: () => created?.options() ?? { nonCapturing: true }, onHandle: handle => { if (created) { created.handle = handle; if (focus) created.focus(); } } }).catch(error => notify(String(error), "error")).finally(() => { if (pane === created) { pane = undefined; finish = undefined; } });
  };
  const rebuild = async (context: ExtensionContext) => {
    cleanup(); ctx = context;
    try {
      const identity = await repositoryIdentity(context.cwd);
      state = restore(context.sessionManager.getBranch(), identity.repository);
      for (const l of Object.values(state.scopes)) {
        l.stale = l.scope.fingerprint === "immutable" ? "current" : "unknown";
        if (l.pending) { l.pending = false; l.turns.push({ role: "notice", text: "前の学習呼出しは中断されています。再送は手動です。使用量は未確定です。", timestamp: Date.now() }); }
      }
      context.ui.setStatus("understanding", state.active ? "理解: /understand open" : undefined);
    } catch { state = freshState(""); }
  };
  pi.on("session_start", async (_event, context) => { await rebuild(context); });
  pi.on("session_before_tree", () => { cleanup(); });
  pi.on("session_tree", async (_event, context) => { await rebuild(context); });
  pi.on("session_shutdown", () => { cleanup(); ctx = undefined; });
  pi.on("model_select", (_event, context) => { ctx = context; });
  // UI-only freshness hint. No every-edit question or inference.
  pi.on("agent_settled", async (_event, context) => {
    const l = current(); const ticket = generation;
    if (!l || l.scope.fingerprint === "immutable") return;
    try { const now = await fingerprint(l.scope.root, l.scope.request); if (ticket !== generation) return; l.stale = now === l.scope.fingerprint ? "current" : "stale"; redraw(); } catch { l.stale = "unknown"; redraw(); }
    ctx = context;
  });
  async function selectRequest(context: ExtensionCommandContext): Promise<ScopeRequest | undefined> {
    const kind = await context.ui.select("明示的な学習スコープ", ["repository", "module", "commit", "pr"]);
    if (!kind) return undefined;
    if (kind === "repository") return { kind };
    const value = await context.ui.input(kind === "module" ? "repository-relative module path" : kind === "commit" ? "REF PARENT（親を明示）" : "GitHub PR NUMBER");
    if (!value) return undefined;
    return parseScope(`${kind} ${value}`);
  }
  pi.registerCommand("understand", {
    description: "固定スコープの独立学習 / scope・map・focus・refresh・handoff・diagram",
    handler: async (args, context) => {
      ctx = context;
      const command = args.trim();
      const ticket = generation;
      try {
        if (command === "help") { notify(HELP); return; }
        if (command === "close") { runner.cancel(); close(); return; }
        if (command === "toggle" && pane) { const hidden = !pane.handle?.isHidden(); if (hidden) pane.release(); pane.handle?.setHidden(hidden); return; }
        if (command === "" || command === "open" || command === "toggle" || command === "focus" || command === "wide") {
          if (!current()) {
            if (!context.hasUI) throw new Error("先に /understand scope repository などで明示選択してください。");
            const request = await selectRequest(context); if (!request || ticket !== generation) return;
            const scope = await collectScope(context.cwd, request); if (ticket !== generation) return;
            if (!state.scopes[scope.id] && Object.keys(state.scopes).length >= 6) throw new Error("保存スコープは6件までです。/understand forget で削除してください。");
            detachLearning(); state.repository = scope.repository; state.scopes[scope.id] ??= freshLearning(scope); state.active = scope.id; save();
          }
          if (command === "wide" && pane) { const view = pane.view(); close(); open(context, true, true, view); }
          else open(context, command === "focus", command === "wide");
          return;
        }
        if (command === "scopes") {
          if (!context.hasUI) { notify(Object.values(state.scopes).map(l => `${l.scope.id} ${l.scope.request.kind}`).join("\n")); return; }
          const choices = Object.values(state.scopes).map(l => `${l.scope.id.slice(0, 12)} ${l.scope.request.kind} ${l.scope.head.slice(0, 12)}`);
          const choice = await context.ui.select("保存スコープ（現在のsession branch）", choices);
          if (!choice || ticket !== generation) return;
          detachLearning(); state.active = Object.keys(state.scopes).find(id => choice.startsWith(id.slice(0, 12))); save(); redraw(); return;
        }
        if (command === "scope" || command.startsWith("scope ") || command === "refresh") {
          const request = command === "refresh" ? current()?.scope.request : command === "scope" ? await selectRequest(context) : parseScope(command.slice(6));
          if (!request || ticket !== generation) return;
          const scope = await collectScope(context.cwd, request); if (ticket !== generation) return;
          if (!state.scopes[scope.id] && Object.keys(state.scopes).length >= 6) throw new Error("保存スコープは6件までです。/understand forget で不要なスコープを削除してください。");
          detachLearning(); state.repository = scope.repository; state.scopes[scope.id] ??= freshLearning(scope); state.active = scope.id; save(); redraw(); open(context); notify(`固定スコープ ${scope.id}\nbase ${scope.base}\nhead ${scope.head}\n収集${scope.sources.length} / 未収集${scope.omitted}`); return;
        }
        const l = current(); if (!l) throw new Error("先にscopeを明示選択してください。");
        if (command === "check") { const now = await fingerprint(l.scope.root, l.scope.request); if (ticket !== generation) return; l.stale = now === l.scope.fingerprint ? "current" : "stale"; save(); redraw(); notify(`根拠の状態: ${l.stale}。PR/commitは固定履歴です。PR先端の更新はrefreshのみ。`); }
        else if (command === "map") { open(context); ask("利用者フロー→責任→重要な関数・契約・テストの小さい根拠付きマップを作成してください。理解質問は不要です。"); }
        else if (command.startsWith("ask ")) { open(context); ask(command.slice(4)); }
        else if (command.startsWith("focus ")) { l.focus = command.slice(6).slice(0, 2000); save(); redraw(); }
        else if (command.startsWith("reference ")) {
          const match = command.slice(10).match(/^(.*?)(?:\s+(base|head))?$/)!;
          const source = await pinnedFile(l.scope, match[1]!, match[2] === "base" ? l.scope.base : (l.scope.request.kind === "repository" || l.scope.request.kind === "module") ? "worktree" : l.scope.head);
          if (ticket !== generation) return;
          addReference(l, source); l.turns.push({ role: "notice", text: `${source.ref}:${source.path} sha256=${source.digest}\n${source.text.split("\n").map((line, i) => `${i + 1}: ${line}`).join("\n")}`, timestamp: Date.now() }); save(); redraw(); notify(`固定参照 ${source.ref}:${source.path}`);
        } else if (command === "questions on" || command === "questions off") { l.questions = command.endsWith("on"); save(); notify(`milestoneの任意理解確認: ${l.questions ? "on" : "off"}`); }
        else if (command === "reset") { if (!context.hasUI || !await context.ui.confirm("学習会話とマップを消去しますか？", "固定スコープと根拠は保持します。")) return; if (ticket !== generation) return; detachLearning(); state.scopes[l.scope.id] = freshLearning(l.scope); save(); redraw(); }
        else if (command === "forget") { if (!context.hasUI || !await context.ui.confirm("現在の学習スコープを削除しますか？", l.scope.id)) return; if (ticket !== generation) return; detachLearning(); delete state.scopes[l.scope.id]; state.active = undefined; save(); close(); }
        else if (command === "diagram") { notify(await openDiagram(l)); }
        else if (command === "handoff") {
          if (!context.hasUI) throw new Error("引き渡しは対話UIでの編集・確認が必要です。");
          const text = await context.ui.editor("実装AIへ渡す内容（学習会話は自動添付しません）", `学習スコープ ${l.scope.id}\n${l.scope.root}\nbase ${l.scope.base}\nhead ${l.scope.head}\nsnapshot ${l.scope.snapshot}\n焦点: ${l.focus}\n\n実装AIへの依頼:\n`);
          if (!text?.trim() || ticket !== generation) return;
          if (await context.ui.confirm("以下を通常チャットへ送信しますか？", text) && ticket === generation) pi.sendUserMessage(text, { deliverAs: "followUp" });
        } else throw new Error("不明な操作です。/understand help を参照してください。");
      } catch (error) { notify(String(error), "error"); }
    },
  });
  pi.registerTool({
    name: "publish_understanding", label: "理解への実装情報公開",
    description: "Publish agreed requirement/change/test claims and focus into an explicitly selected learning scope. Obtain the full scope_id from the user; do not guess or create scope. Does not read learner dialogue, invoke models, or request implementation decisions. Optional question is a single learning prompt, never a required product decision.",
    parameters: Type.Object({ scope_id: Type.String(), milestone_id: Type.String({ maxLength: 100 }), milestone: Type.Union([Type.Literal("pre"), Type.Literal("post")]), requirement: Type.String({ maxLength: 3000 }), change: Type.String({ maxLength: 3000 }), tests: Type.String({ maxLength: 3000 }), focus: Type.String({ maxLength: 2000 }), question: Type.Optional(Type.String({ maxLength: 1000 })) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    execute: async (_id, params) => {
      const l = current();
      if (!l || params.scope_id !== l.scope.id) throw new Error("Explicit active scope_id mismatch. Learning state and dialogue are not disclosed.");
      const publication: Publication = { milestone: params.milestone, requirement: params.requirement, change: params.change, tests: params.tests, focus: params.focus, question: params.question };
      l.publications.push(publication); l.publications = l.publications.slice(-8); l.focus = params.focus;
      const key = `${params.milestone_id}:${params.milestone}`;
      if (l.questions && params.question && !l.asked.includes(key) && l.asked.length < 100) { l.asked.push(key); l.turns.push({ role: "notice", text: `任意の理解確認（${params.milestone} / 製品判断ではありません）: ${params.question}`, timestamp: Date.now() }); }
      save(); redraw();
      return { content: [{ type: "text", text: "Implementation publication recorded. Learner dialogue remains private to learning; nothing was handed to implementation." }], details: { scope_id: params.scope_id, milestone_id: params.milestone_id, publication } };
    },
  });
}
