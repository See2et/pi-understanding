import { test } from "node:test";
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { type TUI, type OverlayHandle } from "@earendil-works/pi-tui";
import { freshLearning, LearningRunner, learningContext, dive, overview, restore, ENTRY, validateMap } from "../src/learning.ts";
import { UnderstandingPane, terminalText } from "../src/pane.ts";
import { referenceSnippet } from "../src/reference.ts";
import { diagramHtml } from "../src/diagram.ts";
import type { Scope } from "../src/scope.ts";

function fixture() {
  const source = { path: "main.ts", ref: "worktree", digest: "fixed", text: Array.from({ length: 80 }, (_, i) => `pinned line ${i + 1}`).join("\n") };
  const learning = freshLearning({ id: "id", repository: "repo", root: "/repo", base: "base", head: "head", snapshot: "snapshot", request: { kind: "repository" }, sources: [source], files: [source.path], omitted: 0 } as Scope);
  const node = { flow: "送信", responsibility: "handler", symbol: "submit()", contract: "fail explicitly", tests: "unverified", evidence: [{ path: source.path, ref: source.ref, start: 50, end: 51, quote: "pinned line 50\npinned line 51" }] };
  learning.map = [node];
  return { learning, node, source };
}

test("explicit generation owns map replacement; asks, dive and return retain IDs, old maps and selection reset", async () => {
  const { learning, node, source } = fixture();
  const old = restore([{ type: "custom", customType: ENTRY, data: { version: 1, repository: "repo", active: "id", scopes: { id: learning } } }], "repo").scopes.id!;
  assert.deepEqual(validateMap(old.map, [source]), old.map);
  dive(learning, 1); const map = structuredClone(learning.map);
  let intent = "";
  const ctx = { model: { id: "gpt-test", provider: "test" }, modelRegistry: { streamSimple: (_model: unknown, context: unknown) => {
    intent = JSON.stringify(context);
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", api: "openai-responses", provider: "test", model: "gpt-test", timestamp: 0, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: [{ type: "text", text: JSON.stringify({ reply: "map summary", map: [{ ...node, stage: "結果", stageReason: "返却する段階", importanceReason: "失敗を理解する" }] }) }] } as AssistantMessage;
    stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
  } } } as unknown as ExtensionContext;
  const runner = new LearningRunner();
  await runner.ask(ctx, learning, "please generate a map naturally", () => {}, () => {});
  assert.deepEqual(learning.map, map); assert.equal(learning.selectedPoint, 1); assert.match(intent, /DIALOGUE intent/);
  overview(learning); assert.deepEqual(learning.map, map); assert.equal(learning.selectedPoint, undefined);
  assert.throws(() => dive(learning, 2)); dive(learning, 1);
  await runner.ask(ctx, learning, "explicit map", () => {}, () => {}, "map");
  assert.equal(learning.selectedPoint, undefined); assert.equal(learning.map[0]!.stage, "結果"); assert.equal(learning.mapSummary, "map summary");
  assert.throws(() => validateMap([{ ...node, stageReason: "x".repeat(501) }], [source]), /stageReason/);
});

test("selected point reaches the learner context without changing the map or scope, and overview clears it", () => {
  const { learning, node, source } = fixture();
  learning.map.push({ ...node, flow: "別の重要点", symbol: "other()", evidence: [{ path: source.path, ref: source.ref, start: 70, end: 70, quote: "pinned line 70" }] });
  const snapshot = structuredClone(learning.scope);
  const map = structuredClone(learning.map);
  dive(learning, 2);
  const context = learningContext(learning, "ここが失敗すると？");
  const input = JSON.stringify(context.messages);
  assert.match(input, /Selected map point/);
  assert.match(input, /M2/);
  assert.match(input, /別の重要点/);
  assert.match(input, /other\(\)/);
  assert.match(input, /pinned line 70/);
  assert.deepEqual(learning.scope, snapshot);
  assert.deepEqual(learning.map, map);
  overview(learning);
  assert.match(JSON.stringify(learningContext(learning, "全体の役割は？").messages), /Selected map point: none/);
});

test("pinned snippet defaults to selected evidence; explicit ranges/all and legacy path/ref forms; no live source", async () => {
  const { learning } = fixture(); dive(learning, 1);
  const snippet = await referenceSnippet(learning, "");
  assert.match(snippet, /worktree:main.ts:50-51/); assert.match(snippet, /50: pinned line 50/); assert.doesNotMatch(snippet, /52: pinned/);
  assert.match(await referenceSnippet(learning, "main.ts head"), /50-51/);
  assert.match(await referenceSnippet(learning, "main.ts head 10-12"), /10: pinned line 10/);
  assert.match(await referenceSnippet(learning, "main.ts all"), /80: pinned line 80/);
  overview(learning); assert.match(await referenceSnippet(learning, "main.ts"), /1-40/);
  await assert.rejects(() => referenceSnippet(learning, "main.ts 79-90"), /outside/);
  await assert.rejects(() => referenceSnippet(learning, "not-captured.ts"), /not captured/);
});

test("stable minimap stays visible across chat; direct dive renders exact quote and Ctrl+O preserves unsent draft", () => {
  initTheme("dark", false);
  const { learning } = fixture();
  const pane = new UnderstandingPane({ terminal: { columns: 120, rows: 48 }, requestRender: () => {} } as TUI, theme, () => learning, { ask: text => { if (text === "overview") overview(learning); }, cancel: () => {}, close: () => {}, running: () => false });
  let hidden = false;
  pane.handle = { focus: () => { pane.focused = true; }, unfocus: () => { pane.focused = false; }, setHidden: (value: boolean) => { hidden = value; } } as OverlayHandle;
  pane.focus(); pane.handleInput("draft");
  const before = terminalText(pane.render(115).join("\n"));
  learning.turns.push({ role: "assistant", text: "long chat\n".repeat(100), timestamp: 0 });
  assert.match(terminalText(pane.render(115).join("\n")), /全体図: M1/);
  assert.match(before, /重要性の理由は未記録/);
  dive(learning, 1); const detail = terminalText(pane.render(115).join("\n"));
  assert.match(detail, /▶M1/); assert.match(detail, /worktree:main.ts:50-51/); assert.match(detail, /pinned line 50/);
  pane.handleInput("\x0f"); assert.equal(learning.selectedPoint, undefined); assert.equal(pane.view().input, "draft");
  pane.release(); assert.equal(hidden, true); pane.focus(); assert.equal(hidden, false); assert.equal(pane.view().input, "draft");
  const html = diagramHtml(learning);
  assert.match(html, /id="M1"/); assert.match(html, /href="#M1"/); assert.match(html, /href="#overview"/); assert.match(html, /pinned line 50/);
  assert.doesNotMatch(html, /<script|long chat|https?:\/\/[^" ]+\.js/);
  const twelve = fixture(); twelve.learning.map = Array.from({ length: 12 }, (_, i) => ({ ...twelve.node, stage: `段階${i}${"長いラベル".repeat(20)}` }));
  const small = new UnderstandingPane({ terminal: { columns: 80, rows: 24 }, requestRender: () => {} } as TUI, theme, () => twelve.learning, { ask: () => {}, cancel: () => {}, close: () => {}, running: () => false });
  const compact = terminalText(small.render(76).join("\n"));
  for (let i = 1; i <= 12; i++) assert.ok(compact.includes(`M${i}`), `navigation target M${i} remains visible despite long stages`);
});
