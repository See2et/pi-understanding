import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateEvidence, validateClaims, ANNOTATION_LIMITS, type Evidence } from "../src/model.ts";
import { freshState, freshLearning, persistedState, restore, ENTRY, LEGACY_ENTRY, learningContext, parseReply } from "../src/learning.ts";
import { hash, type Scope } from "../src/scope.ts";

const code = "outside before\nfunction decide(value) {\n  if (!value) return;\n  return value;\n}\noutside after\n";
const source = { path: "src/decide.ts", ref: "worktree", text: code, digest: hash(code) };
const evidence: Evidence = { path: source.path, ref: source.ref, start: 2, end: 5, quote: code.split("\n").slice(1, 5).join("\n"), annotations: [{ start: 2, end: 3, text: "値がなければ処理を終える。" }, { start: 4, end: 5, text: "受け取った値をそのまま返す。" }] };
const claim = { id: "decision", kind: "behavior", status: "fact", statement: "値を返す", evidence: [evidence], relations: [] };
const scope: Scope = { id: "scope", repository: "repository", root: "/unused", snapshot: "snapshot", request: { kind: "repository" }, base: "base", head: "head", capturedAt: 0, fingerprint: "fixed", omitted: 0, files: [source.path], sources: [source] };

test("annotations are separate bounded original-range interpretations, not quote edits; partial sources and legacy evidence remain valid", () => {
  const result = validateEvidence(evidence, [source]);
  assert.equal(result.quote, evidence.quote); assert.deepEqual(result.annotations, evidence.annotations);
  assert.deepEqual(validateEvidence(evidence, [{ ...source, text: evidence.quote, startLine: 2 }]), result);
  assert.equal(validateEvidence({ ...evidence, annotations: undefined }, [source]).annotations, undefined);
  const annotation = evidence.annotations![0]!;
  for (const annotations of [null, {}, Array(7).fill(annotation), [{ ...annotation, start: 1 }], [{ ...annotation, end: 6 }], [{ ...annotation, start: 2.5 }], [annotation, annotation], [...evidence.annotations!].reverse(), [{ ...annotation, text: " " }], [{ ...annotation, text: "line\nbreak" }], [{ ...annotation, text: "line\u2028break" }], [{ ...annotation, text: "　" }], [{ ...annotation, text: "\x1b]52;c;bad\x07" }], [{ ...annotation, text: "\u009b2J" }], [{ ...annotation, text: "字".repeat(161) }]]) {
    assert.throws(() => validateEvidence({ ...evidence, annotations }, [source]), /[Aa]nnotation/);
  }
  const max = { ...evidence, annotations: [{ start: 2, end: 2, text: "x".repeat(480) }, { start: 3, end: 3, text: "x".repeat(480) }, { start: 4, end: 4, text: "x".repeat(480) }] };
  assert.equal(validateEvidence(max, [source]).annotations!.length, 3);
  assert.throws(() => validateEvidence({ ...max, annotations: [...max.annotations, { start: 5, end: 5, text: "x" }] }, [source]), /budget/);
  assert.throws(() => validateEvidence({ ...evidence, quote: evidence.quote + " // annotation" }, [source]), /exact source/);
});

test("same-evidence duplicates share canonical annotations across signature/tests/claims, rejecting conflicts and model persistence overflow", () => {
  const legacy = { ...evidence, annotations: undefined };
  const claims = validateClaims([{ ...claim, signature: legacy, tests: [legacy] }, { ...claim, id: "other", evidence: [legacy] }], [source]);
  const annotations = claims[0]!.evidence[0]!.annotations;
  assert.deepEqual(claims[0]!.signature!.annotations, annotations); assert.deepEqual(claims[0]!.tests![0]!.annotations, annotations); assert.deepEqual(claims[1]!.evidence[0]!.annotations, annotations);
  assert.throws(() => validateClaims([{ ...claim, signature: { ...evidence, annotations: [{ start: 2, end: 3, text: "different" }] } }], [source]), /Conflicting/);
  const big = { ...evidence, annotations: [{ start: 2, end: 3, text: "x".repeat(480) }] };
  const many = Array.from({ length: 20 }, (_, i) => ({ ...claim, id: `c${i}`, evidence: Array(6).fill(big) }));
  assert.throws(() => validateClaims(many, [source]), /model persistence budget/);
  assert.equal(ANNOTATION_LIMITS.modelBytes, 12_000);
});

test("generation protocol validates annotations and v2 preserves them without copying whole source; old and corrupt annotations restore safely", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "understanding-annotations-"));
  try {
    const learning = freshLearning(structuredClone(scope));
    learning.claims = parseReply(JSON.stringify({ reply: "説明", modelSummary: "分岐", claims: [claim] }), [source]).claims;
    learning.selectedClaim = "decision"; learning.evidenceView = learning.claims![0]!.evidence[0]; learning.annotationsVisible = false;
    assert.match(learningContext(learning, "GENERATE_MODEL").systemPrompt, /semantic chunk annotations/);
    const state = freshState(scope.repository); state.active = scope.id; state.scopes[scope.id] = learning;
    const saved = persistedState(state, root); assert.deepEqual(saved.scopes[scope.id]!.scope.sources, []);
    const restored = restore([{ type: "custom", customType: ENTRY, data: saved }], scope.repository, root).scopes[scope.id]!;
    assert.deepEqual(restored.evidenceView!.annotations, evidence.annotations); assert.equal(restored.evidenceView!.quote, evidence.quote); assert.equal(restored.annotationsVisible, false); assert.equal(restored.scope.sources[0]!.text, code);
    const old = structuredClone(saved); old.version = 1;
    for (const e of [old.scopes[scope.id]!.claims![0]!.evidence[0]!, old.scopes[scope.id]!.evidenceView!]) delete e.annotations;
    assert.equal(restore([{ type: "custom", customType: LEGACY_ENTRY, data: old }], scope.repository, root).scopes[scope.id]!.evidenceView!.annotations, undefined);
    const full = structuredClone(saved);
    const maximum = { ...evidence, annotations: [{ start: 2, end: 3, text: "x".repeat(300) }, { start: 4, end: 5, text: "y".repeat(300) }] };
    full.scopes[scope.id]!.claims = validateClaims(Array.from({ length: 20 }, (_, i) => ({ ...claim, id: `c${i}`, evidence: [maximum] })), [source]);
    full.scopes[scope.id]!.evidenceView = maximum;
    assert.deepEqual(restore([{ type: "custom", customType: ENTRY, data: full }], scope.repository, root).scopes[scope.id]!.evidenceView!.annotations, maximum.annotations, "selected view does not double-charge the model annotation budget on restore");
    const corrupt = structuredClone(saved); corrupt.scopes[scope.id]!.evidenceView!.annotations![0]!.end = 500;
    const rejected = restore([{ type: "custom", customType: ENTRY, data: corrupt }], scope.repository, root).scopes[scope.id]!;
    assert.equal(rejected.evidenceView!.annotations, undefined); assert.equal(rejected.evidenceView!.quote, evidence.quote); assert.match(rejected.turns.at(-1)!.text, /注釈.*検証/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
