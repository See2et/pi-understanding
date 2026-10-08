import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { freshLearning, LearningRunner, learningContext, loadYomiyasu, parseReply, validateMap } from "../src/learning.ts";
import { validateClaims, selectClaim, selectedClaim, modelOverview, modelBack, openClaimEvidence, claimChallenge, skipChallenge } from "../src/model.ts";
import { hash, type Scope, type Source } from "../src/scope.ts";
import { storeSnapshot } from "../src/snapshot.ts";

const source: Source = { path: "src/domain.ts", ref: "worktree", digest: hash("export const fixed = 1;"), text: "export const fixed = 1;" };
const evidence = { path: source.path, ref: source.ref, start: 1, end: 1, quote: source.text };
const claim = { id: "fixed-value", kind: "rule", statement: "値は1です。", status: "fact", evidence: [evidence], signature: evidence, tests: [evidence], relations: [], challenge: "値を予測してください。" };
const scope = (): Scope => ({ id: "fixed-scope", repository: "repo", root: "/unused-repo", request: { kind: "repository" }, base: "base", head: "head", snapshot: "fixed-snapshot", files: [source.path], sources: [source], omitted: 0, capturedAt: 0, fingerprint: "fixed" });
const message = (payload: unknown): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: JSON.stringify(payload) }], api: "openai-responses", provider: "test", model: "gpt-test", timestamp: 0, stopReason: "stop", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
function provider(answer: (context: unknown, call: number) => unknown) {
  let calls = 0;
  const context = { model: { provider: "test", id: "gpt-test" }, modelRegistry: { streamSimple: (_model: unknown, context: { tools: unknown[] }) => {
    assert.deepEqual(context.tools, []);
    const stream = createAssistantMessageEventStream(); const result = message(answer(context, ++calls));
    stream.push({ type: "done", reason: "stop", message: result }); stream.end(result); return stream;
  } } } as unknown as ExtensionContext;
  return { context, calls: () => calls };
}

test("claim evidence/signatures/tests share exact validation, original range numbering, real relations and explicit interpretation", () => {
  assert.equal(validateClaims([claim], [source])[0]!.id, claim.id);
  for (const field of ["evidence", "signature", "tests"]) {
    const bad = { ...evidence, quote: "polished but not original" };
    assert.throws(() => validateClaims([{ ...claim, [field]: field === "signature" ? bad : [bad] }], [source]), /exact source/);
  }
  assert.throws(() => validateClaims([{ ...claim, relations: [{ to: "missing", type: "depends" }] }], [source]), /real claims/);
  assert.throws(() => validateClaims([{ ...claim, evidence: [] }], [source]), /exact evidence/);
  assert.equal(validateClaims([{ ...claim, status: "inferred", evidence: [], signature: undefined, tests: [] }], [source])[0]!.status, "inferred");
  const partial = { ...source, text: "original line 50\noriginal line 51", startLine: 50 };
  const proof = { ...evidence, start: 50, end: 51, quote: partial.text };
  assert.equal(validateClaims([{ ...claim, evidence: [proof], signature: undefined, tests: [] }], [partial])[0]!.evidence[0]!.start, 50);
  assert.equal(validateMap([{ flow: "f", responsibility: "r", symbol: "s", contract: "c", tests: "t", evidence: [proof] }], [partial])[0]!.evidence[0]!.start, 50);
  assert.throws(() => parseReply(JSON.stringify({ reply: "x", need: [{ path: "x", start: 1, end: 200, why: "x" }] }), []), /bounded exact/);
});

test("model generation is explicit, existing repository needs no changes, dialogue/proposal preserve model and selection", async () => {
  const learning = freshLearning(scope());
  const generated = provider(() => ({ reply: "現在のルールです。", modelSummary: "固定値を持ちます。", claims: [claim] }));
  const runner = new LearningRunner();
  await runner.ask(generated.context, learning, "既存全体", () => {}, () => {}, "model");
  assert.equal(learning.claims?.[0]?.id, "fixed-value"); assert.equal(learning.scope.request.kind, "repository");
  selectClaim(learning, "fixed-value"); assert.equal(selectedClaim(learning)?.statement, claim.statement);
  assert.equal(openClaimEvidence(learning).quote, source.text); modelBack(learning); assert.equal(learning.selectedClaim, claim.id);
  assert.equal(claimChallenge(learning), claim.challenge); skipChallenge(learning); assert.equal(claimChallenge(learning), undefined);
  learning.questions = false; assert.equal(claimChallenge(learning), undefined);
  const model = structuredClone(learning.claims);
  await runner.ask(generated.context, learning, "ここについて自由質問", () => {}, () => {});
  assert.deepEqual(learning.claims, model); assert.equal(learning.selectedClaim, claim.id);
  const proposal = provider(context => { assert.match(JSON.stringify(context), /HYPOTHESIS|PROPOSAL_HYPOTHESIS/); assert.match(JSON.stringify(context), /specification opinion/); return { reply: "これは未実装の仮説です。" }; });
  await runner.ask(proposal.context, learning, "値を2にする案", () => {}, () => {}, "proposal");
  assert.deepEqual(learning.claims, model); assert.equal(learning.proposal, "値を2にする案");
  modelOverview(learning); assert.equal(learning.selectedClaim, undefined); assert.equal(learning.evidenceView, undefined);
  assert.match(JSON.stringify(learningContext(learning, "全体")), /Selected model claim.*null/);
});

test("second round reads previously untransmitted large captured content from identical snapshot bytes with original line numbers", async () => {
  const full = Array.from({ length: 250 }, (_, i) => `line-${i + 1} ${"x".repeat(150)}`).join("\n");
  const large: Source = { path: "src/large.ts", ref: "worktree", text: full, digest: hash(full) };
  const pinned = scope(); pinned.sources = [large]; pinned.files = [large.path]; pinned.localSnapshot = storeSnapshot(pinned, pinned.sources);
  // Restore-like source-free memory proves the second read uses disk, not mutable worktree or initial prompt.
  pinned.sources = [];
  const learning = freshLearning(pinned);
  const quote = full.split("\n")[199]!;
  const fake = provider((context, call) => {
    const text = JSON.stringify(context);
    if (call === 1) { assert.ok(!text.includes(quote)); return { reply: "追加根拠が必要です。", need: [{ path: large.path, ref: "worktree", start: 200, end: 200, why: "規則の実装" }] }; }
    assert.ok(text.includes(`200: ${quote}`));
    return { reply: "根拠を確認しました。", modelSummary: "固定内容の規則です。", claims: [{ ...claim, signature: undefined, tests: [], evidence: [{ path: large.path, ref: "worktree", start: 200, end: 200, quote }] }] };
  });
  await new LearningRunner().ask(fake.context, learning, "モデル", () => {}, () => {}, "model");
  assert.equal(fake.calls(), 2); assert.equal(learning.claims?.[0]!.evidence[0]!.start, 200);
  assert.ok(learning.turns.at(-1)?.read?.some(r => r.status === "fetched" && r.start === 200 && r.digest === large.digest));
  assert.equal(learning.turns.filter(t => t.usage).reduce((n, t) => n + t.usage!.totalTokens, 0), 6);
});

test("legacy uncaptured and excluded reads fail honestly, no live refresh; cancellation during retrieval discards continuation", async () => {
  const learning = freshLearning(scope());
  const fake = provider((context, call) => call === 1 ? { reply: "確認します。", need: [{ path: "missing.ts", start: 1, end: 1, why: "missing" }, { path: ".env", start: 1, end: 1, why: "not allowed" }] } : (() => { assert.match(JSON.stringify(context), /uncaptured/); assert.match(JSON.stringify(context), /excluded/); return { reply: "未捕捉と除外のため確認できません。" }; })());
  await new LearningRunner().ask(fake.context, learning, "根拠", () => {}, () => {});
  assert.equal(fake.calls(), 2); assert.equal(learning.claims, undefined);
  const cancelLearning = freshLearning(scope()); const runner = new LearningRunner();
  const fetching = provider(() => ({ reply: "取得", need: [{ path: source.path, start: 1, end: 1, why: "read" }] }));
  let saves = 0; let savesAtDetach = 0;
  await runner.ask(fetching.context, cancelLearning, "cancel", partial => { if (partial?.startsWith("固定根拠")) { runner.detach(); savesAtDetach = saves; } }, () => saves++);
  assert.equal(fetching.calls(), 1); assert.equal(saves, savesAtDetach); assert.equal(cancelLearning.claims, undefined);
});

test("read/search limits are enforced without executing model text, expanding module scope or replacing the model after exhaustion", async () => {
  const limited = scope(); limited.request = { kind: "module", module: "src" }; limited.files.push("outside.ts");
  const learning = freshLearning(limited);
  const search = provider((context, call) => call === 1 ? { reply: "固定範囲を検索", search: [{ text: "fixed =", why: "実装" }], need: [{ path: "outside.ts", start: 1, end: 1, why: "範囲外" }] } : (() => { const text = JSON.stringify(context); assert.match(text, /searched/); assert.match(text, /excluded\/outside scope/); assert.match(text, /1: export const fixed = 1;/); return { reply: "固定検索の根拠です。" }; })());
  await new LearningRunner().ask(search.context, learning, "検索", () => {}, () => {});
  assert.equal(search.calls(), 2); assert.ok(learning.turns.at(-1)?.read?.some(r => r.status === "searched"));
  const exhausted = provider(() => ({ reply: "more evidence", need: [{ path: source.path, start: 1, end: 1, why: "request" }] }));
  learning.claims = validateClaims([claim], [source]); const previous = structuredClone(learning.claims);
  await new LearningRunner().ask(exhausted.context, learning, "model with endless requests", () => {}, () => {}, "model");
  assert.equal(exhausted.calls(), 3); assert.deepEqual(learning.claims, previous); assert.match(learning.turns.at(-1)!.text, /Read round limit/);
  assert.throws(() => parseReply(JSON.stringify({ reply: "x", need: Array.from({ length: 7 }, () => ({ path: source.path, start: 1, end: 1, why: "x" })) }), [source]), /six/);
  const huge = { ...source, text: "x".repeat(25_000) }; huge.digest = hash(huge.text);
  const budgetLearning = freshLearning({ ...scope(), sources: [huge] });
  const budget = provider((context, call) => call === 1 ? { reply: "read", need: [{ path: source.path, start: 1, end: 1, why: "large" }] } : (() => { assert.match(JSON.stringify(context), /retrieval transmission budget/); return { reply: "取得上限です。" }; })());
  await new LearningRunner().ask(budget.context, budgetLearning, "budget", () => {}, () => {});
  assert.equal(budget.calls(), 2); assert.ok(budgetLearning.turns.at(-1)?.read?.some(r => r.status === "budget"));
});

test("effective yomiyasu instructions reach the native model only for the registered skill; JSON and exact quote protections remain", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "understanding-skill-"));
  try {
    await mkdir(path.join(root, "references"));
    const skill = path.join(root, "SKILL.md");
    await writeFile(skill, "---\nname: yomiyasu\ndescription: test\n---\n日本語のSTYLE-MARKER。意味を保持。`references/style.md`\n書き直した本文 / 変えたところ\npython3 lint.py");
    await writeFile(path.join(root, "references/style.md"), "REFERENCE-MARKER");
    const commands = [{ name: "skill:yomiyasu", source: "skill", sourceInfo: { path: skill, source: "test", scope: "temporary", origin: "top-level" } }] as SlashCommandInfo[];
    assert.deepEqual(loadYomiyasu([]), {});
    assert.deepEqual(loadYomiyasu([{ ...commands[0]!, source: "extension" }]), {});
    const instructions = loadYomiyasu(commands); assert.ok(instructions.text?.includes("REFERENCE-MARKER"));
    const learning = freshLearning(scope());
    const fake = provider(context => { const text = JSON.stringify(context); assert.match(text, /STYLE-MARKER/); assert.match(text, /NEVER rewrite JSON keys\/schema/); assert.match(text, /Do NOT impose rewrite-only headings/); return { reply: "読みやすい説明です。", modelSummary: "現状のモデルです。", claims: [claim] }; });
    await new LearningRunner(() => instructions).ask(fake.context, learning, "モデル", () => {}, () => {}, "model");
    assert.equal(learning.turns.at(-1)?.styleSkill, "yomiyasu-instructions-sent"); assert.equal(learning.claims?.[0]!.evidence[0]!.quote, source.text);
    const absent = provider(context => { assert.doesNotMatch(JSON.stringify(context), /STYLE-MARKER/); return { reply: "skillなしで継続" }; });
    await new LearningRunner().ask(absent.context, learning, "質問", () => {}, () => {});
    assert.equal(learning.turns.at(-1)?.styleSkill, undefined);
    await rm(skill); const failed = loadYomiyasu(commands); assert.equal(failed.text, undefined); assert.match(failed.issue!, /読み込めません/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
