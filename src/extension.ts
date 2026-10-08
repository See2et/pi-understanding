import { spawnSync } from "node:child_process";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectScope, repositoryIdentity, fingerprint, type ScopeRequest } from "./scope.ts";
import { ENTRY, freshState, freshLearning, restore, persistedState, loadYomiyasu, LearningRunner, type LearningIntent, type State, type Learning, type Publication } from "./learning.ts";
import { selectClaim, modelBack, openClaimEvidence, skipChallenge, modelOverview, modelOverviewText } from "./model.ts";
import { snapshotStorageRoot } from "./snapshot.ts";
import { UnderstandingPane, terminalText, FOCUS_SHORTCUT, type PaneView } from "./pane.ts";
import { openDiagram, diagramHtml } from "./diagram.ts";
import { DiagramPreview } from "./preview.ts";
import { referenceSnippet } from "./reference.ts";
import { openNeovim } from "./neovim.ts";
import { chooseTarget, targetMetadata } from "./targets.ts";

export const HELP = `理解ペインは通常チャットとは別のGPT会話です。通常チャットの内容は読みません。
/u と Alt+S — 開く（通常入力の下書き保持）。変更なしのrepositoryも理解対象です。
/u model — モデル全体像を明示生成（概念・ルール・境界・振る舞い・理由）。問いは任意。
/u select CLAIM_ID | evidence N | back | overview — 主張・固定根拠・戻る（推論なし）
/u annotations on|off|toggle — 原文とは別のAI注釈の表示切替（Ctrl+Alt+A）
/u nvim [export] — 選択根拠を固定file全体・同じ注釈付きでNeovimへ（Ctrl+Alt+N）。設定不要で今のterminalに表示、:qaでPiへ戻る。exportは手動受渡し
/u quiet | questions on|off | skip — 問いを非表示 / 選択した問いをスキップ
/u proposal 内容 | proposal clear — これからの変更案を仮説として相談 / 仮説を解除
/u info | storage — 固定対象とprivate local保存の情報
/u 質問文 — 選択した主張について自由質問（全体像は変更しません）
/understand [open|toggle|focus|close|wide] — ほぼ全画面の学習表示 / 隠して通常入力
/understand scope — 未commit分・branch・最近のcommit・PRを一覧で選択
/understand targets — AIに相談するための候補情報
/understand scope changes — HEADと未commit分の固定比較
/understand scope branch REF [BASE] — branch全体、または分岐後の変更
/understand scope repository — tracked worktreeを固定
/understand scope module path — module配下を固定
/understand scope commit REF PARENT — 明示した親との差分
/understand scope pr NUMBER — ghのPR情報と固定Gitオブジェクト
/understand scopes — このbranchに保存したスコープへ戻る
/understand check | refresh — 鮮度確認 / 明示更新（自動更新しません）
/understand ask 質問 — 学習AIを呼ぶ（モデルは置き換えません）
/understand focus 対象 — 焦点のみ変更
/understand reference [path [base|head|index] [all|START-END]] — 選択根拠のsnippet、または先頭40行
/understand questions on|off — milestoneの任意の理解確認
/understand handoff — 内容を編集・確認して実装チャットへ明示送信
/u diagram — 現在モデルの相互作用図（module/function/data-store）をlocal browserで開く
/understand diagram preview | stop — 明示的なtailnet HTTPS公開 / 所有する公開とserverの停止
/understand reset | forget — 会話消去 / 現在スコープを削除
Ctrl+Alt+U: 学習表示・入力 ↔ 非表示・通常入力（両方の下書きを保持）。open/focus/wideは同じ学習表示です。
学習入力: select ID / evidence N / overview、Ctrl+O 全体へ、Ctrl+T 対象選択、Esc/Ctrl+G/Ctrl+D 隠す、Ctrl+C 学習中止、PgUp/PgDn 履歴。
横幅・高さ96%のOverlay。12行未満では非表示。モデルと相互作用図は明示modelだけで更新し、会話や図を開く操作では変えません。map/diveは廃止しました。previewには既存home-previewとHTTPS/operator設定が必要です（Funnelではありません）。`;
export function parseScope(args: string): ScopeRequest {
  if (args === "repository") return { kind: "repository" };
  if (args === "changes") return { kind: "changes" };
  const branch = args.match(/^branch\s+(\S+)(?:\s+(\S+))?$/);
  if (branch) return { kind: "branch", ref: branch[1]!, ...(branch[2] ? { base: branch[2] } : {}) };
  if (args.startsWith("module ")) return { kind: "module", module: args.slice(7).trim() };
  const commit = args.match(/^commit\s+(\S+)\s+(\S+)$/);
  if (commit) return { kind: "commit", ref: commit[1]!, parent: commit[2]! };
  const pr = args.match(/^pr\s+(\d+)$/);
  if (pr) return { kind: "pr", number: pr[1]! };
  throw new Error("scope changes | branch REF [BASE] | repository | module PATH | commit REF PARENT | pr NUMBER");
}
type TerminalLaunch = (binary: string, args: string[], env: NodeJS.ProcessEnv) => void;
const runTerminal: TerminalLaunch = (binary, args, env) => {
  const result = spawnSync(binary, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Neovim terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`Neovim exited with code ${result.status}`);
};
/** Optional adapters keep the public command's terminal lifecycle verifiable without a hidden process. */
export default function understanding(pi: ExtensionAPI, terminal: { interactive?: () => boolean; run?: TerminalLaunch } = {}): void {
  let ctx: ExtensionContext | undefined;
  let state: State = freshState("");
  let pane: UnderstandingPane | undefined;
  let finish: (() => void) | undefined;
  let generation = 0;
  let stateTransitions = 0;
  const transition = async <T>(action: () => Promise<T>): Promise<T> => {
    stateTransitions++;
    try { return await action(); } finally { stateTransitions--; }
  };
  const runner = new LearningRunner(() => { try { return loadYomiyasu(pi.getCommands?.() ?? []); } catch { return { issue: "ホストの有効skill一覧を取得できません。yomiyasuは未読込、学習は継続します。" }; } });
  const preview = new DiagramPreview();
  let retainedView: PaneView | undefined;
  const current = (): Learning | undefined => state.active ? state.scopes[state.active] : undefined;
  const save = () => {
    const l = current();
    if (l) {
      let removed = 0;
      while (l.turns.length > 40 || l.turns.reduce((n, t) => n + t.text.length, 0) > 60_000) { l.turns.shift(); removed++; }
      if (removed) l.turns.unshift({ role: "notice", text: `保存上限のため以前の${removed}件を省略しました。`, timestamp: Date.now() });
    }
    pi.appendEntry(ENTRY, persistedState(state));
  };
  const close = () => { retainedView = pane?.view() ?? retainedView; finish?.(); finish = undefined; pane = undefined; };
  const hide = () => pane?.release();
  const detachLearning = () => {
    generation++;
    const l = current();
    if (l?.pending) { l.pending = false; l.turns.push({ role: "notice", text: "スコープ・branch・sessionの変更で学習呼出しを中止しました。確定した使用量は取得できていません。", timestamp: Date.now() }); save(); }
    runner.detach();
    // Native drafts survive remounts; streamed output and navigation belong to the old scope.
    if (retainedView) retainedView = { ...retainedView, partial: undefined, error: "", offset: 0, followChat: false };
    pane?.redraw(); pane?.navigate();
    return preview.stop();
  };
  const cleanup = () => transition(async () => { close(); retainedView = undefined; await detachLearning(); });
  const notify = (message: string, kind: "info" | "warning" | "error" = "info") => ctx?.ui.notify(terminalText(message), kind);
  const redraw = (partial?: string) => pane?.redraw(partial);
  let neovimBusy = false;
  const launchNeovim = async (learning: Learning, context: ExtensionContext, mode: "open" | "export") => {
    if (neovimBusy) throw new Error("Neovim受渡しの処理中です。終了後に再実行してください。");
    neovimBusy = true;
    const ticket = generation;
    const stillCurrent = () => ticket === generation && ctx === context;
    try {
      const interactive = context.mode === "tui" && context.hasUI && (terminal.interactive?.() ?? (process.stdin.isTTY && process.stdout.isTTY));
      const inPlace = interactive ? async (binary: string, args: string[], env: NodeJS.ProcessEnv) => {
        let owner!: TUI;
        let complete!: (result: { error?: unknown }) => void;
        // Mount first: done() before an overlay mounts would pop the retained learning pane.
        const result = await context.ui.custom<{ error?: unknown }>((tui, _theme, _kb, done) => {
          owner = tui; complete = done;
          return { render: () => [], invalidate: () => {} };
        }, { overlay: true, overlayOptions: { nonCapturing: true }, onHandle: () => {
          let error: unknown;
          let suspended = false;
          try {
            if (!stillCurrent()) throw new Error("対象が変わったためNeovim受渡しを中止しました。");
            suspended = true;
            owner.stop();
            process.stdout.write("\x1b[2J\x1b[H");
            // Synchronous inherited stdio: Pi cannot consume input/render or dispatch another takeover until exit.
            (terminal.run ?? runTerminal)(binary, args, env);
          } catch (failure) { error = failure; }
          finally {
            try { if (suspended) { owner.start(); owner.requestRender(true); } }
            catch (failure) { error = error ?? failure; }
            finally { complete({ error }); }
          }
        } });
        if (result.error) throw result.error;
      } : undefined;
      const message = await openNeovim(learning, mode, stillCurrent, inPlace);
      if (stillCurrent()) notify(message);
    } finally { neovimBusy = false; }
  };
  const showDiagram = async (learning: Learning, mode: string) => {
    if (mode === "diagram stop") { await preview.stop(); notify("所有するpreviewを停止しました。"); return; }
    if (mode === "diagram") { notify(await openDiagram(learning)); return; }
    if (mode !== "diagram preview") throw new Error("diagram | diagram preview | diagram stop");
    const ticket = generation;
    const html = diagramHtml(learning); // Unavailable/invalid fails before starting any server.
    const url = await preview.start(html);
    if (url && ticket === generation) notify(`Tailnet限定preview（コード引用を含みます / 会話なし）: ${url}\n停止: /u diagram stop`);
  };
  const ask = (prompt: string, intent: LearningIntent = "dialogue") => {
    if (stateTransitions) { notify("対象切替の処理中です。完了後に再実行してください。", "warning"); return; }
    const learning = current(); const context = ctx;
    if (!learning || !context) { notify("先にscopeを明示選択してください。", "warning"); return; }
    prompt = prompt.trim();
    if (/^(?:map|dive)(?:\s|$)/i.test(prompt)) { notify("map/diveは廃止しました。/u model と /u diagram を使ってください。", "warning"); return; }
    if (/^diagram(?:\s|$)/.test(prompt)) { void showDiagram(learning, prompt).catch(error => notify(String(error), "error")); return; }
    const claim = prompt.match(/^(?:select|claim)\s+([A-Za-z][A-Za-z0-9_-]*)$/);
    const evidence = prompt.match(/^evidence(?:\s+(\d+))?$/);
    const annotations = prompt.match(/^annotations(?:\s+(on|off|toggle))?$/);
    if (prompt === "nvim" || prompt === "nvim export") {
      void launchNeovim(learning, context, prompt.endsWith("export") ? "export" : "open").catch(error => notify(String(error), "error"));
      return;
    }
    if (annotations || claim || evidence || ["overview", "back", "skip", "quiet", "questions on", "questions off", "proposal clear"].includes(prompt)) {
      try {
        if (annotations) learning.annotationsVisible = annotations[1] === "on" ? true : annotations[1] === "off" ? false : learning.annotationsVisible === false;
        else if (claim) selectClaim(learning, claim[1]!);
        else if (evidence) openClaimEvidence(learning, evidence[1] ? Number(evidence[1]) : 1);
        else if (prompt === "back") modelBack(learning);
        else if (prompt === "skip") skipChallenge(learning);
        else if (prompt === "quiet" || prompt === "questions off") learning.questions = false;
        else if (prompt === "questions on") learning.questions = true;
        else if (prompt === "proposal clear") learning.proposal = undefined;
        else modelOverview(learning);
        pane?.navigate(); save(); redraw();
      } catch (error) { notify(String(error), "error"); }
      return;
    }
    if (prompt === "reference" || prompt.startsWith("reference ")) {
      const ticket = generation;
      void referenceSnippet(learning, prompt.slice(10)).then(text => { if (ticket !== generation) return; learning.turns.push({ role: "notice", text, timestamp: Date.now() }); save(); redraw(); }).catch(error => notify(String(error), "error"));
      return;
    }
    if (prompt === "model") { intent = "model"; prompt = "この固定対象の概念・ルール・境界・状態と振る舞い・判断理由のモデル全体像を、関連と正確な根拠付きで生成してください。実装コードとテストを必要に応じて固定snapshotから追加取得してください。"; }
    else if (prompt.startsWith("proposal ")) { intent = "proposal"; prompt = prompt.slice(9); }
    if (!prompt) return;
    if (intent === "dialogue" || intent === "proposal") pane?.followDialogue(); else pane?.navigate();
    void runner.ask(context, learning, prompt, redraw, save, intent).catch(error => { if (pane) { pane.error = String(error); redraw(); } notify(String(error), "error"); });
  };
  const open = (context: ExtensionContext, focus = true, wide = true, view: PaneView | undefined = retainedView): void => {
    if (context.mode !== "tui") { notify("ペインはTUI専用です。scope/check/model/ask/diagramは非TUIでも利用できます。", "warning"); return; }
    if (pane) { pane.handle?.setHidden(false); if (focus) pane.focus(); return; }
    if (view && !runner.running) view = { ...view, partial: undefined };
    let created: UnderstandingPane | undefined;
    void context.ui.custom<void>((tui, theme, _kb, done) => {
      finish = () => done();
      created = new UnderstandingPane(tui, theme, current, { ask, cancel: () => runner.cancel(), close: hide, choose: () => { const ticket = generation; close(); void chooseTarget(context).then(request => request && ticket === generation ? applyScope(request, context, true) : undefined).then(() => { if (ticket === generation || ctx === context) open(context, true); }).catch(error => notify(String(error), "error")); }, running: () => runner.running, layout: (nextWide, nextFocus) => {
        if (pane !== created) return;
        const previous = created?.view(); close(); open(context, nextFocus, nextWide, previous);
      } }, wide, view);
      pane = created;
      return created;
    }, { overlay: true, overlayOptions: () => created?.options() ?? { nonCapturing: true }, onHandle: handle => { if (created) { created.handle = handle; if (focus) created.focus(); } } }).catch(error => notify(String(error), "error")).finally(() => { if (pane === created) { pane = undefined; finish = undefined; } });
  };
  const rebuild = (context: ExtensionContext) => transition(async () => {
    try { await cleanup(); } catch (error) { notify(String(error), "error"); } ctx = context;
    try {
      const identity = await repositoryIdentity(context.cwd);
      state = restore(context.sessionManager.getBranch(), identity.repository);
      for (const l of Object.values(state.scopes)) {
        l.stale = l.scope.fingerprint === "immutable" ? "current" : "unknown";
        if (l.pending) { l.pending = false; l.turns.push({ role: "notice", text: "前の学習呼出しは中断されています。再送は手動です。使用量は未確定です。", timestamp: Date.now() }); }
      }
      context.ui.setStatus("understanding", "理解: /u · Alt+S");
    } catch { state = freshState(""); }
  });
  pi.on("session_start", async (_event, context) => { await rebuild(context); });
  pi.on("session_before_tree", async () => { await cleanup(); });
  pi.on("session_tree", async (_event, context) => { await rebuild(context); });
  pi.on("session_shutdown", async () => { try { await cleanup(); } catch (error) { notify(String(error), "error"); } ctx = undefined; });
  pi.on("model_select", (_event, context) => { ctx = context; });
  // UI-only freshness hint. No every-edit question or inference.
  pi.on("agent_settled", async (_event, context) => {
    const l = current(); const ticket = generation;
    if (!l || l.scope.fingerprint === "immutable") return;
    try { const now = await fingerprint(l.scope.root, l.scope.request); if (ticket !== generation) return; l.stale = now === l.scope.fingerprint ? "current" : "stale"; redraw(); } catch { l.stale = "unknown"; redraw(); }
    ctx = context;
  });
  const selectRequest = (context: ExtensionContext) => chooseTarget(context);
  async function applyScope(request: ScopeRequest, context: ExtensionContext, confirm = false, reason = "") {
    const ticket = generation;
    if (confirm && !context.hasUI) throw new Error("対象の変更にはユーザーの確認UIが必要です。");
    const scope = await collectScope(context.cwd, request);
    if (ticket !== generation) return undefined;
    if (confirm) {
      // Pi dialogs live in the ordinary editor container, below custom overlays.
      const suspended = pane;
      const hidden = suspended?.handle?.isHidden() ?? false;
      const focused = suspended?.focused ?? false;
      suspended?.handle?.setHidden(true);
      let approved = false;
      try {
        approved = await context.ui.confirm("この固定範囲を理解対象にしますか？", `${reason ? `理由: ${reason}\n` : ""}${JSON.stringify(request)}\n${scope.root}\nbase ${scope.base}\nhead ${scope.head}\nsnapshot ${scope.snapshot}\n収集${scope.sources.length} / 未収集${scope.omitted}`);
      } finally {
        if (ticket === generation && pane === suspended && suspended) {
          suspended.handle?.setHidden(hidden);
          if (focused && !hidden) suspended.focus();
        }
      }
      if (!approved) return undefined;
    }
    if (ticket !== generation) return undefined;
    if (!state.scopes[scope.id] && Object.keys(state.scopes).length >= 6) throw new Error("保存スコープは6件までです。/understand forget で削除してください。");
    return transition(async () => {
      const boundary = generation + 1; await detachLearning(); if (boundary !== generation) return undefined;
      state.repository = scope.repository; state.scopes[scope.id] ??= freshLearning(scope); state.active = scope.id; save(); redraw();
      return scope;
    });
  }
  pi.registerShortcut(FOCUS_SHORTCUT, {
    description: "通常入力 ↔ 学習入力（下書き保持）",
    handler: async context => {
      ctx = context;
      if (!current()) { notify("先に /understand scope で理解対象を選択してください。", "warning"); return; }
      if (pane?.handle?.isFocused()) pane.release();
      else open(context, true);
    },
  });
  pi.registerShortcut("alt+s", {
    description: "モデル理解を開く / 通常入力へ（下書き保持）",
    handler: async context => {
      ctx = context;
      try {
        if (!current()) {
          const ticket = generation; const request = await selectRequest(context);
          if (!request || ticket !== generation || !await applyScope(request, context, true)) return;
        }
        if (pane?.handle?.isFocused()) pane.release(); else open(context, true);
      } catch (error) { notify(String(error), "error"); }
    },
  });
  const commandDefinition: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "固定対象のモデル理解 / model・select・evidence・proposal・handoff（変更不要）",
    handler: async (args, context) => {
      ctx = context;
      const command = args.trim();
      const ticket = generation;
      try {
        if (/^(?:map|dive)(?:\s|$)/i.test(command)) { notify("map/diveは廃止しました。/u model と /u diagram を使ってください。", "warning"); return; }
        if (command === "help") { notify(HELP); return; }
        if (command === "targets") { notify(JSON.stringify(await targetMetadata(context.cwd), null, 2)); return; }
        if (command === "close") { runner.cancel(); hide(); return; }
        // Cleanup belongs to the preview resource, not the current learning scope.
        if (command === "diagram stop") { await preview.stop(); notify("所有するpreviewを停止しました。"); return; }
        if (command === "toggle" && pane && !pane.handle?.isHidden()) { hide(); return; }
        if (command === "" || command === "open" || command === "toggle" || command === "focus" || command === "wide") {
          if (!current()) {
            if (!context.hasUI) throw new Error("先に /understand scope repository などで明示選択してください。");
            const request = await selectRequest(context); if (!request || ticket !== generation) return;
            if (!await applyScope(request, context, true)) return;
          }
          open(context);
          if (!current()?.claims?.length) notify(modelOverviewText(current()!));
          return;
        }
        if (command === "scopes") {
          if (!context.hasUI) { notify(Object.values(state.scopes).map(l => `${l.scope.id} ${l.scope.request.kind}`).join("\n")); return; }
          const choices = Object.values(state.scopes).map(l => `${l.scope.id.slice(0, 12)} ${l.scope.request.kind} ${l.scope.head.slice(0, 12)}`);
          const choice = await context.ui.select("保存スコープ（現在のsession branch）", choices);
          if (!choice || ticket !== generation) return;
          await transition(async () => {
            const boundary = generation + 1; await detachLearning(); if (boundary !== generation) return;
            state.active = Object.keys(state.scopes).find(id => choice.startsWith(id.slice(0, 12))); save(); redraw();
          }); return;
        }
        if (command === "scope" || command.startsWith("scope ") || command === "refresh") {
          const request = command === "refresh" ? current()?.scope.request : command === "scope" ? await selectRequest(context) : parseScope(command.slice(6));
          if (!request || ticket !== generation) return;
          const scope = await applyScope(request, context, command === "scope"); if (!scope) return;
          open(context); notify(`固定スコープ ${scope.id}\nbase ${scope.base}\nhead ${scope.head}\n収集${scope.sources.length} / 未収集${scope.omitted}`); return;
        }
        if (stateTransitions) throw new Error("対象切替の処理中です。完了後に再実行してください。");
        const l = current(); if (!l) throw new Error("先にscopeを明示選択してください。");
        if (command === "check") { const now = await fingerprint(l.scope.root, l.scope.request); if (ticket !== generation) return; l.stale = now === l.scope.fingerprint ? "current" : "stale"; save(); redraw(); notify(`根拠の状態: ${l.stale}。PR/commitは固定履歴です。PR先端の更新はrefreshのみ。`); }
        else if (command === "nvim" || command === "nvim export") { await launchNeovim(l, context, command.endsWith("export") ? "export" : "open"); }
        else if (/^annotations(?:\s+(?:on|off|toggle))?$/.test(command)) { ask(command); }
        else if (command === "model") { open(context); ask("model"); }
        else if (command === "info") { notify(JSON.stringify({ request: l.scope.request, id: l.scope.id, base: l.scope.base, head: l.scope.head, snapshot: l.scope.snapshot, capturedAt: l.scope.capturedAt, stale: l.stale, proposal: l.proposal, localSnapshot: l.scope.localSnapshot }, null, 2)); }
        else if (command === "storage") { notify(`Private local snapshots: ${snapshotStorageRoot()}\n保存時は本文をsessionへ複製せず参照を記録します。自動削除はしません。手動削除すると保存済みscopeの追加根拠取得はできなくなります。sessionには会話と引用が残ります。`); }
        else if (/^(?:select|claim)\s+/.test(command) || /^evidence(?:\s+\d+)?$/.test(command) || ["back", "skip", "quiet", "proposal clear"].includes(command) || command.startsWith("proposal ")) { open(context); ask(command); }
        else if (command.startsWith("ask ")) { open(context); ask(command.slice(4)); }
        else if (command === "overview") { ask(command); open(context); }
        else if (command.startsWith("focus ")) { l.focus = command.slice(6).slice(0, 2000); save(); redraw(); }
        else if (command === "reference" || command.startsWith("reference ")) {
          const text = await referenceSnippet(l, command.slice(10));
          if (ticket !== generation) return;
          l.turns.push({ role: "notice", text, timestamp: Date.now() }); save(); redraw(); notify(text.split("\n")[0]!);
        } else if (command === "questions on" || command === "questions off") { l.questions = command.endsWith("on"); save(); redraw(); notify(`任意理解確認: ${l.questions ? "on" : "off"}`); }
        else if (command === "reset") { if (!context.hasUI || !await context.ui.confirm("学習会話とモデルを消去しますか？", "固定スコープと根拠は保持します。")) return; if (ticket !== generation) return; await transition(async () => { const boundary = generation + 1; await detachLearning(); if (boundary !== generation) return; state.scopes[l.scope.id] = freshLearning(l.scope); save(); redraw(); }); }
        else if (command === "forget") { if (!context.hasUI || !await context.ui.confirm("現在の学習スコープを削除しますか？", l.scope.id)) return; if (ticket !== generation) return; await transition(async () => { const boundary = generation + 1; await detachLearning(); if (boundary !== generation) return; delete state.scopes[l.scope.id]; state.active = undefined; save(); close(); }); }
        else if (/^diagram(?:\s|$)/.test(command)) { await showDiagram(l, command); }
        else if (command === "handoff") {
          if (!context.hasUI) throw new Error("引き渡しは対話UIでの編集・確認が必要です。");
          const text = await context.ui.editor("実装AIへ渡す内容（学習会話は自動添付しません）", `学習スコープ ${l.scope.id}\n${l.scope.root}\nbase ${l.scope.base}\nhead ${l.scope.head}\nsnapshot ${l.scope.snapshot}\n焦点: ${l.focus}\n\n実装AIへの依頼:\n`);
          if (!text?.trim() || ticket !== generation) return;
          if (await context.ui.confirm("以下を通常チャットへ送信しますか？", text) && ticket === generation) pi.sendUserMessage(text, { deliverAs: "followUp" });
        } else { open(context); ask(command); }
      } catch (error) { notify(String(error), "error"); }
    },
  };
  pi.registerCommand("understand", commandDefinition);
  pi.registerCommand("u", commandDefinition);
  pi.registerTool({
    name: "understanding_targets", label: "理解対象の候補",
    description: "Discover current branch, uncommitted change metadata, local branches and recent commits so the user need not remember refs. PR network listing only with include_pr=true explicitly requested by user. No learner dialogue. Ask user about ambiguous intent; use select_understanding_scope only after discussion.",
    parameters: Type.Object({ include_pr: Type.Optional(Type.Boolean()) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    execute: async (_id, params, _signal, _update, context) => { const details = await targetMetadata(context.cwd, params.include_pr === true); return { content: [{ type: "text", text: JSON.stringify(details) }], details }; },
  });
  pi.registerTool({
    name: "select_understanding_scope", label: "理解対象を確認して選択",
    description: "Propose an explicit scope after discussing user intent. Always opens confirmation showing the frozen target and comparison; never silently switches. specification uses the grammar changes | branch REF [BASE] | repository | module PATH | commit REF PARENT | pr NUMBER. No learner dialogue or code changes. If uncertain, ask user first.",
    parameters: Type.Object({ specification: Type.String({ maxLength: 1000 }), reason: Type.String({ maxLength: 2000 }) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    execute: async (_id, params, _signal, _update, context) => {
      ctx = context;
      if (!context.hasUI) throw new Error("ユーザーの確認UIなしには理解対象を変更しません。");
      const scope = await applyScope(parseScope(params.specification), context, true, params.reason);
      if (scope) open(context);
      return { content: [{ type: "text", text: scope ? `User confirmed scope ${scope.id}.` : "Selection cancelled; scope unchanged." }], details: scope ? { scope_id: scope.id, request: scope.request, base: scope.base, head: scope.head } : undefined };
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
