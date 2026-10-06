import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { collectScope, pinnedFile, fingerprint } from "../src/scope.ts";
import { targets, chooseTarget } from "../src/targets.ts";
import understanding from "../src/extension.ts";

async function repo() {
  const root = await mkdtemp(path.join(tmpdir(), "understanding-targets-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-qb", "main"); git("config", "user.name", "QA"); git("config", "user.email", "qa@example.invalid");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/main.ts"), "base\n"); await writeFile(path.join(root, "src/deleted.ts"), "remove me\n");
  git("add", "."); git("commit", "-qm", "baseline");
  return { root, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}
test("uncommitted scope includes distinct staged and working versions, untracked sources and deletion evidence without changing Git state", async () => {
  const f = await repo();
  try {
    await writeFile(path.join(f.root, "src/main.ts"), "staged\n"); f.git("add", "src/main.ts");
    await writeFile(path.join(f.root, "src/main.ts"), "base\n"); // Working content matches HEAD, but index still differs.
    await writeFile(path.join(f.root, "src/new.ts"), "new source\n");
    await writeFile(path.join(f.root, ".env.local"), "secret\n");
    await rm(path.join(f.root, "src/deleted.ts"));
    const before = f.git("status", "--porcelain");
    const scope = await collectScope(f.root, { kind: "changes" });
    assert.equal((await pinnedFile(scope, "src/main.ts", "index")).text, "staged\n");
    assert.equal((await pinnedFile(scope, "src/main.ts", "worktree")).text, "base\n");
    assert.equal((await pinnedFile(scope, "src/deleted.ts", scope.base)).text, "remove me\n");
    assert.equal((await pinnedFile(scope, "src/new.ts", "worktree")).text, "new source\n");
    assert.ok(!scope.files.some(file => file.startsWith(".env")));
    assert.equal(f.git("status", "--porcelain"), before);
    await writeFile(path.join(f.root, "src/new.ts"), "changed again\n");
    assert.notEqual(await fingerprint(f.root, scope.request), scope.fingerprint);
    assert.equal((await pinnedFile(scope, "src/new.ts", "worktree")).text, "new source\n");
  } finally { await f.cleanup(); }
});
test("local branch browsing needs no remembered refs, fixes contents/comparison and detects branch movement", async () => {
  const f = await repo();
  try {
    f.git("checkout", "-qb", "feature");
    await writeFile(path.join(f.root, "src/main.ts"), "feature\n"); f.git("add", "."); f.git("commit", "-qm", "Explain feature");
    const candidates = await targets(f.root, "branch"); assert.ok(candidates.some(c => c.label.includes("Explain feature")));
    const scope = await collectScope(f.root, { kind: "branch", ref: "feature", base: "main" });
    assert.notEqual(scope.base, scope.head);
    assert.equal((await pinnedFile(scope, "src/main.ts")).text, "feature\n");
    const full = await collectScope(f.root, { kind: "branch", ref: "feature" }); assert.equal(full.base, full.head); assert.notEqual(full.id, scope.id);
    const commits = await targets(f.root, "commit"); assert.ok(commits.some(c => c.label.includes("Explain feature")));
    f.git("commit", "--allow-empty", "-qm", "advance branch");
    assert.notEqual(await fingerprint(f.root, scope.request), scope.fingerprint);
    assert.equal((await pinnedFile(scope, "src/main.ts")).text, "feature\n");
    await assert.rejects(() => collectScope(f.root, { kind: "branch", ref: "--bad" }));
    const chosen = await chooseTarget({ cwd: f.root, hasUI: true, ui: { select: async (_title: string, values: string[]) => values[0] } } as unknown as ExtensionContext);
    assert.deepEqual(chosen, { kind: "changes" });
  } finally { await f.cleanup(); }
});
test("AI-assisted target selection confirms frozen scope, never discloses learner dialogue, and rejects noninteractive mutation", async () => {
  const f = await repo();
  try {
    const definitions = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
    const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
    const entries: unknown[] = []; let approve = false; let confirmations = 0;
    const api = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => events.set(name, handler), registerCommand: () => {}, registerShortcut: () => {}, registerTool: (def: Parameters<ExtensionAPI["registerTool"]>[0]) => definitions.set(def.name, def), appendEntry: (_type: string, data: unknown) => entries.push(structuredClone(data)) } as unknown as ExtensionAPI;
    understanding(api);
    const ctx = { cwd: f.root, hasUI: true, mode: "rpc", sessionManager: { getBranch: () => [] }, ui: { notify: () => {}, setStatus: () => {}, confirm: async (_title: string, text: string) => { confirmations++; assert.match(text, /snapshot/); return approve; } } } as unknown as ExtensionToolContext;
    await events.get("session_start")!({}, ctx);
    const select = definitions.get("select_understanding_scope")!;
    const params = { specification: "changes", reason: "User wants uncommitted work" };
    await select.execute("denied", params, undefined, undefined, ctx); assert.equal(entries.length, 0);
    approve = true; const result = await select.execute("approved", params, undefined, undefined, ctx);
    assert.equal(entries.length, 1); assert.equal(confirmations, 2); assert.doesNotMatch(JSON.stringify(result), /turns|learner-only/);
    await assert.rejects(() => select.execute("no-ui", params, undefined, undefined, { ...ctx, hasUI: false }), /確認UI/);
  } finally { await f.cleanup(); }
});
