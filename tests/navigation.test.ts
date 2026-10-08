import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, readFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LearningRunner, learningContext, restore, persistedState, freshState, ENTRY, LEGACY_ENTRY, parseReply } from "../src/learning.ts";
import { validateInteractions, selectClaim, modelOverview } from "../src/model.ts";
import { referenceSnippet } from "../src/reference.ts";
import { diagramHtml, openDiagram } from "../src/diagram.ts";
import { interactionFixture } from "./interaction-fixture.ts";

test("bounded interaction graph reuses exact canonical evidence, validates IDs/endpoints/types and never converts claim relations", () => {
  const { claims, interactions, source } = interactionFixture();
  assert.deepEqual(validateInteractions(interactions, claims), interactions);
  assert.equal(validateInteractions(undefined, claims), undefined);
  for (const mutate of [
    (g: typeof interactions) => { g.entities[0]!.id = g.entities[1]!.id; },
    (g: typeof interactions) => { g.interactions[0]!.to = "missing"; },
    (g: typeof interactions) => { g.interactions[0]!.evidence[0]!.claim = "missing"; },
    (g: typeof interactions) => { g.interactions[0]!.evidence[0]!.evidence = 99; },
    (g: typeof interactions) => { g.entities[0]!.evidence = []; },
    (g: typeof interactions) => { g.interactions[0]!.evidence.push(g.interactions[0]!.evidence[0]!); },
    (g: typeof interactions) => { g.entities[0]!.label = "x".repeat(121); },
    (g: typeof interactions) => { g.entities[0]!.kind = "concept" as typeof g.entities[0]["kind"]; },
    (g: typeof interactions) => { g.interactions[0]!.status = "verified" as typeof g.interactions[0]["status"]; },
    (g: typeof interactions) => { g.interactions = Array(49).fill(g.interactions[0]); },
  ]) { const graph = structuredClone(interactions); mutate(graph); assert.throws(() => validateInteractions(graph, claims)); }
  const unsafeClaims = structuredClone(claims); const unsafeGraph = structuredClone(interactions);
  unsafeClaims[0]!.id = 'x"onclick="bad'; unsafeGraph.entities[0]!.evidence[0]!.claim = unsafeClaims[0]!.id;
  assert.throws(() => validateInteractions(unsafeGraph, unsafeClaims), /existing exact claim evidence/);
  const oversized = structuredClone(claims); oversized[0]!.signature!.quote = "x".repeat(48_000); oversized[0]!.evidence[0]!.quote = Array(8).fill("x".repeat(7_000)).join("\n");
  assert.throws(() => validateInteractions(interactions, oversized), /persistence budget/);
  const parsed = parseReply(JSON.stringify({ reply: "model", claims, interactions }), [source]);
  assert.deepEqual(parsed.interactions, interactions);
  const bad = structuredClone(claims); bad[0]!.signature!.quote = "invented";
  assert.throws(() => parseReply(JSON.stringify({ reply: "model", claims: bad, interactions }), [source]), /exact source/);
  assert.throws(() => parseReply(JSON.stringify({ reply: "model", interactions }), [source]), /existing exact claim evidence/);
});

test("single explicit model owner commits graph with claims; ordinary dialogue/proposals and invalid generation retain both", async () => {
  const { learning, claims, interactions } = interactionFixture();
  let payload: unknown = { reply: "生成", modelSummary: "summary", claims, interactions }; let calls = 0;
  const ctx = { model: { id: "gpt-test", provider: "test" }, modelRegistry: { streamSimple: () => {
    calls++; const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", api: "openai-responses", provider: "test", model: "gpt-test", timestamp: 0, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: [{ type: "text", text: JSON.stringify(payload) }] } as AssistantMessage;
    stream.push({ type: "done", reason: "stop", message }); stream.end(message); return stream;
  } } } as unknown as ExtensionContext;
  const runner = new LearningRunner();
  await runner.ask(ctx, learning, "model", () => {}, () => {}, "model");
  selectClaim(learning, "entry"); const graph = structuredClone(learning.interactions), prior = structuredClone(learning.claims);
  for (const intent of ["dialogue", "proposal"] as const) await runner.ask(ctx, learning, "question", () => {}, () => {}, intent);
  assert.deepEqual(learning.interactions, graph); assert.deepEqual(learning.claims, prior); assert.equal(learning.selectedClaim, "entry");
  diagramHtml(learning); assert.equal(calls, 3, "viewing does not invoke models");
  modelOverview(learning); // Supply the whole fixed source again, not only selected signature lines.
  payload = { reply: "invalid", modelSummary: "replacement", claims, interactions: { ...interactions, interactions: [{ ...interactions.interactions[0], to: "missing" }] } };
  await runner.ask(ctx, learning, "model", () => {}, () => {}, "model");
  assert.deepEqual(learning.interactions, graph); assert.deepEqual(learning.claims, prior);
  payload = { reply: "graph unavailable", modelSummary: "conceptual only", claims };
  await runner.ask(ctx, learning, "model", () => {}, () => {}, "model");
  assert.equal(learning.interactions, undefined); assert.throws(() => diagramHtml(learning), /まだありません/);
});

test("historical map-only/current source-free models restore without conversion or deletion; malformed graph remains preserved but unavailable", async () => {
  const { learning } = interactionFixture(); const state = freshState(learning.scope.repository); state.active = learning.scope.id; state.scopes[learning.scope.id] = learning;
  const historic = structuredClone(state); historic.version = 1;
  const old = historic.scopes[learning.scope.id]!;
  old.map = [{ flow: "historic-map", evidence: [{ quote: "legacy-original", annotations: [{ unrecognized: true }] }] }]; old.selectedPoint = 1; old.mapSummary = "historic summary";
  old.claims = undefined; old.interactions = undefined;
  const before = structuredClone(historic);
  const restored = restore([{ type: "custom", customType: LEGACY_ENTRY, data: historic }], state.repository).scopes[learning.scope.id]!;
  assert.deepEqual(historic, before); assert.deepEqual(restored.map, old.map); assert.equal(restored.selectedPoint, 1); assert.equal(restored.mapSummary, old.mapSummary);
  assert.equal(restored.claims, undefined); assert.equal(restored.interactions, undefined); assert.throws(() => diagramHtml(restored), /まだありません/);
  assert.doesNotMatch(JSON.stringify(learningContext(restored, "質問")), /historic-map|legacy-original|Selected map point/);
  const root = await mkdtemp(path.join(tmpdir(), "interaction-restore-"));
  try {
    const saved = persistedState(state, root);
    const current = restore([{ type: "custom", customType: ENTRY, data: saved }], state.repository, root).scopes[learning.scope.id]!;
    assert.deepEqual(current.interactions, learning.interactions); assert.match(diagramHtml(current), /注文IDに決済結果を保存/);
    const corrupt = structuredClone(saved); corrupt.scopes[learning.scope.id]!.interactions!.interactions[0]!.to = "missing";
    const unavailable = restore([{ type: "custom", customType: ENTRY, data: corrupt }], state.repository, root).scopes[learning.scope.id]!;
    assert.deepEqual(unavailable.interactions, corrupt.scopes[learning.scope.id]!.interactions);
    assert.deepEqual(unavailable.claims, learning.claims); assert.throws(() => diagramHtml(unavailable), /検証に失敗/);
    const claimsOnly = structuredClone(saved); delete claimsOnly.scopes[learning.scope.id]!.interactions;
    assert.throws(() => diagramHtml(restore([{ type: "custom", customType: ENTRY, data: claimsOnly }], state.repository, root).scopes[learning.scope.id]!), /まだありません/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("static directed lanes, entity/detail/claim/evidence anchors and identity exclude conversations and hypotheses", () => {
  const { learning } = interactionFixture(); learning.turns.push({ role: "user", text: "private-dialogue", timestamp: 0 }); learning.proposal = "private-proposal";
  const html = diagramHtml(learning);
  for (const text of ["MODULE", "FUNCTION", "DATA STORE", "reads", "writes", "calls", "marker-end", 'id="entity-checkout"', 'href="#interaction-save-receipt"', 'id="evidence-storage-3"', 'href="#claim-storage"', "固定対象", "snapshot", "unknown", "意味の正しさを保証しません", "await save(id, receipt)"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script|private-dialogue|private-proposal|id="M\d/);
  assert.match(html, /script-src 'none'/);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(id), `anchor exists: ${id}`);
});

test("local diagram uses private file and existing opener only; unavailable model fails before opener; no implicit sharing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "interaction-open-")), oldPath = process.env.PATH;
  const log = path.join(root, "opened.jsonl");
  try {
    const bin = path.join(root, "bin"); await mkdir(bin);
    const opener = path.join(bin, process.platform === "darwin" ? "open" : "xdg-open");
    await writeFile(opener, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`); await chmod(opener, 0o755); process.env.PATH = `${bin}:${oldPath}`;
    const { learning } = interactionFixture();
    const file = await openDiagram(learning);
    try { assert.deepEqual(JSON.parse((await readFile(log, "utf8")).trim()), [file]); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700); assert.match(await readFile(file, "utf8"), /相互作用図/); }
    finally { await rm(path.dirname(file), { recursive: true, force: true }); }
    learning.interactions = undefined; await assert.rejects(openDiagram(learning), /まだありません/);
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
  } finally { process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); }
});

test("pinned reference defaults to selected claim evidence; explicit ranges/all never use retired point selection", async () => {
  const { learning } = interactionFixture(); selectClaim(learning, "storage");
  assert.match(await referenceSnippet(learning, ""), /src\/checkout.ts:1-1/);
  assert.match(await referenceSnippet(learning, "src/checkout.ts head 4-6"), /4:   const order/);
  assert.match(await referenceSnippet(learning, "src/checkout.ts all"), /8: }/);
  modelOverview(learning); learning.selectedPoint = 1;
  await assert.rejects(referenceSnippet(learning, ""), /select/);
  await assert.rejects(referenceSnippet(learning, "src/not-captured.ts"), /not captured/);
});
