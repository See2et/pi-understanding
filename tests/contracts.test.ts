import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectScope, pinnedFile, fingerprint, safePath, evidenceText, LIMITS, type Scope, type Source } from "../src/scope.ts";
import { freshLearning, freshState, restore, ENTRY, learningContext, LearningRunner } from "../src/learning.ts";
import { diagramHtml } from "../src/diagram.ts";
import { validateClaims } from "../src/model.ts";
import { interactionFixture } from "./interaction-fixture.ts";
import { parseScope } from "../src/extension.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

export async function fixture(): Promise<{ root: string; base: string; head: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "understanding-contract-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src/main.ts"), "export function submit() { return 1; }\n");
  await writeFile(path.join(root, "README.md"), "# User flow\nSubmit request\n");
  git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
  await writeFile(path.join(root, "src/main.ts"), "export function submit() { return 2; }\n");
  git("add", "."); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
  return { root, base, head, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const usage = { input: 5, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export function response(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "test", model: "gpt-test", usage, stopReason, timestamp: Date.now(), errorMessage: stopReason === "error" ? "native failure fixture" : undefined };
}

test("scope identity isolates roots/modules, commit has explicit parent, worktree evidence is immutable and stale", async () => {
  const f = await fixture(); const other = await fixture();
  try {
    const repo = await collectScope(f.root, { kind: "repository" });
    const repeat = await collectScope(f.root, { kind: "repository" }); assert.equal(repo.id, repeat.id);
    const module = await collectScope(f.root, { kind: "module", module: "src" }); assert.notEqual(repo.id, module.id);
    const another = await collectScope(other.root, { kind: "repository" }); assert.notEqual(repo.id, another.id);
    const historical = await collectScope(f.root, { kind: "commit", ref: f.head, parent: f.base });
    assert.equal((await pinnedFile(historical, "src/main.ts", f.base)).text, "export function submit() { return 1; }\n");
    await assert.rejects(() => collectScope(f.root, { kind: "commit", ref: f.head, parent: f.head }), /immediate parent/);
    const before = (await pinnedFile(repo, "src/main.ts", "worktree")).text;
    await writeFile(path.join(f.root, "src/main.ts"), "changed during implementation\n");
    assert.notEqual(await fingerprint(f.root, repo.request), repo.fingerprint);
    assert.equal((await pinnedFile(repo, "src/main.ts", "worktree")).text, before);
    assert.notEqual((await collectScope(f.root, repo.request)).id, repo.id);
    assert.equal((await pinnedFile(historical, "src/main.ts")).text, "export function submit() { return 2; }\n");
  } finally { await f.cleanup(); await other.cleanup(); }
});

test("read boundary rejects traversal, unsafe refs, secrets and symlinks; collection remains tracked-only", async () => {
  const f = await fixture();
  try {
    for (const p of ["../outside", "/etc/passwd", "src/../../auth.json", "src\\main.ts", "a\nb", "HEAD:foo", "a//b"]) assert.throws(() => safePath(p));
    const scope = await collectScope(f.root, { kind: "commit", ref: f.head, parent: f.base });
    await assert.rejects(() => pinnedFile(scope, "../outside"));
    await assert.rejects(() => pinnedFile(scope, "src/main.ts", "HEAD"), /not pinned/);
    await assert.rejects(() => pinnedFile(scope, ".env"), /excluded/);
    await writeFile(path.join(f.root, "untracked.ts"), "untracked sensitive text");
    await symlink("/etc/passwd", path.join(f.root, "link"));
    execFileSync("git", ["add", "link"], { cwd: f.root });
    const worktree = await collectScope(f.root, { kind: "repository" });
    assert.ok(!worktree.sources.some(s => s.path === "link" || s.path === "untracked.ts"));
  } finally { await f.cleanup(); }
});

test("claim evidence checks exact ref, quote and range; prompt truthfully bounds source coverage", () => {
  const source: Source = { path: "src/main.ts", ref: "fixed", digest: "test", text: "line one\nline two\n" };
  const node = { id: "submit", kind: "behavior", statement: "return", status: "fact", relations: [], evidence: [{ path: source.path, ref: source.ref, start: 1, end: 2, quote: "line one\nline two" }] };
  assert.equal(validateClaims([node], [source]).length, 1);
  for (const evidence of [{ ...node.evidence[0], ref: "HEAD" }, { ...node.evidence[0], quote: "invented" }, { ...node.evidence[0], end: 200 }]) assert.throws(() => validateClaims([{ ...node, evidence: [evidence] }], [source]));
  const scope = { id: "id", request: { kind: "repository" }, sources: [source, { ...source, path: "huge", text: "x".repeat(LIMITS.promptBytes) }], files: ["src/main.ts", "huge"], omitted: 3 } as Scope;
  const evidence = evidenceText(scope); assert.equal(evidence.sent.length, 1); assert.equal(evidence.truncated, true); assert.match(evidence.text, /not analyzed/);
});

test("active branch state restoration does not import abandoned state or another repository", () => {
  const state = freshState("root-a"); state.active = "scope-a";
  const first = { type: "custom", customType: ENTRY, data: state };
  const abandoned = { type: "custom", customType: ENTRY, data: { ...state, active: "abandoned" } };
  assert.equal(restore([first], "root-a").active, "scope-a");
  assert.equal(restore([first, abandoned], "root-a").active, "abandoned");
  assert.equal(restore([first], "root-b").active, undefined);
  const restored = restore([first], "root-a"); restored.active = "edited"; assert.equal(state.active, "scope-a");
});

test("native learning streams with no tools or implementation messages, records failure/usage and cancellation; detached replies cannot persist", async () => {
  const f = await fixture();
  try {
    const learning = freshLearning(await collectScope(f.root, { kind: "repository" }));
    learning.turns.push({ role: "user", text: "learner-only", timestamp: 0 });
    const built = learningContext(learning, "my question"); assert.match(JSON.stringify(built), /learner-only/); assert.doesNotMatch(JSON.stringify(built), /main-chat-secret/);
    let saved = 0; let finish: (() => void) | undefined; let nativeCalls = 0;
    const context = { model: { id: "gpt-test", provider: "test" }, modelRegistry: { streamSimple: (_model: unknown, context: { tools: unknown[] }, options: { signal: AbortSignal }) => {
      nativeCalls++; assert.deepEqual(context.tools, []); assert.doesNotMatch(JSON.stringify(context), /main-chat-secret/);
      const stream = createAssistantMessageEventStream();
      finish = () => { stream.push({ type: "error", reason: "error", error: response("", "error") }); stream.end(response("", "error")); };
      options.signal.addEventListener("abort", () => { const msg = response("", "aborted"); stream.push({ type: "error", reason: "aborted", error: msg }); stream.end(msg); }, { once: true });
      return stream;
    } } } as unknown as ExtensionContext;
    const runner = new LearningRunner();
    const task = runner.ask(context, learning, "question", () => {}, () => saved++);
    assert.equal(runner.running, true); await assert.rejects(() => runner.ask(context, learning, "second", () => {}, () => {}), /回答中/);
    finish!(); await task; assert.equal(runner.running, false); assert.equal(learning.turns.at(-1)?.usage?.totalTokens, 13); assert.match(learning.turns.at(-1)!.text, /native failure fixture/);
    const abort = runner.ask(context, learning, "cancel", () => {}, () => saved++); runner.cancel(); await abort; assert.equal(learning.turns.at(-1)?.stopReason, "aborted");
    const detached = runner.ask(context, learning, "detach", () => {}, () => saved++); const atDetach = saved; runner.detach(); await detached; assert.equal(saved, atDetach); assert.equal(runner.running, false); assert.equal(nativeCalls, 3);
    await assert.rejects(() => runner.ask({ ...context, model: { id: "claude", provider: "anthropic" } } as unknown as ExtensionContext, learning, "blocked", () => {}, () => {}), /GPT/);
  } finally { await f.cleanup(); }
});

test("HTML is static escaped SVG, never learner dialogue or arbitrary generated JS", async () => {
  const f = await fixture();
  try {
    const { learning } = interactionFixture();
    learning.turns.push({ role: "user", text: "learner-private-text", timestamp: 0 });
    learning.interactions!.entities[0]!.label = '<script>alert("x")</script>';
    learning.interactions!.interactions[0]!.detail = '<img src=x onerror="x">';
    learning.claims![0]!.signature!.quote = "</pre><script>x</script>";
    const html = diagramHtml(learning); assert.doesNotMatch(html, /<script|<img|learner-private-text/); assert.match(html, /&lt;script&gt;/); assert.match(html, /script-src 'none'/); assert.match(html, /<svg/);
  } finally { await f.cleanup(); }
});

test("explicit command grammar keeps scope separate from focus and rejects inferred parents", () => {
  assert.deepEqual(parseScope("module path with spaces"), { kind: "module", module: "path with spaces" });
  assert.throws(() => parseScope("commit HEAD")); assert.throws(() => parseScope("focus src/main.ts"));
});
