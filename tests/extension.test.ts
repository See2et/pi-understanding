import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import understanding from "../src/extension.ts";
import { collectScope, pinnedFile } from "../src/scope.ts";
import { ENTRY } from "../src/learning.ts";

test("production PR metadata path pins base/head without changing HEAD/index/worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "understanding-pr-"));
  const oldPath = process.env.PATH;
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q"); git("config", "user.name", "QA"); git("config", "user.email", "qa@example.invalid");
    await writeFile(path.join(root, "main.ts"), "base\n"); git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
    await writeFile(path.join(root, "main.ts"), "head\n"); git("add", "."); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
    const bin = path.join(root, "fake-bin"); await mkdir(bin);
    await writeFile(path.join(bin, "gh"), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ baseRefOid: base, headRefOid: head, url: "https://github.com/See2et/qa/pull/1" }))});\n`);
    await chmod(path.join(bin, "gh"), 0o755); process.env.PATH = `${bin}:${oldPath}`;
    const status = git("status", "--porcelain");
    const scope = await collectScope(root, { kind: "pr", number: "1" });
    assert.equal(scope.head, head); assert.equal(scope.base, base); assert.equal(scope.advertisedBase, base);
    assert.equal((await pinnedFile(scope, "main.ts", base)).text, "base\n");
    assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("status", "--porcelain"), status);
    await assert.rejects(() => collectScope(root, { kind: "pr", number: "--evil" }), /numeric/);
  } finally { process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); }
});

test("publication tool cannot read learner dialogue; one optional question per milestone; handoff requires editor and confirmation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "understanding-extension-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(path.join(root, "main.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
    let tool!: Parameters<ExtensionAPI["registerTool"]>[0];
    const branch: { type: string; customType: string; data: unknown }[] = [];
    const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
    const sent: string[] = [];
    const api = {
      registerCommand: (_name: string, options: typeof command) => { command = options; },
      registerTool: (definition: typeof tool) => { tool = definition; },
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => { events.set(event, handler); },
      appendEntry: (customType: string, data: unknown) => { branch.push({ type: "custom", customType, data: structuredClone(data) }); },
      sendUserMessage: (text: string) => { sent.push(text); },
    } as unknown as ExtensionAPI;
    understanding(api);
    let approved = false;
    let confirmations = 0;
    const ctx = { cwd: root, mode: "rpc", hasUI: true, sessionManager: { getBranch: () => branch }, ui: { notify: () => {}, setStatus: () => {}, confirm: async () => { confirmations++; return approved; }, editor: async () => "explicitly approved implementation request" } } as unknown as ExtensionCommandContext;
    await events.get("session_start")!({}, ctx);
    await command.handler("scope repository", ctx);
    assert.equal(branch.at(-1)?.customType, ENTRY);
    const saved = branch.at(-1)!.data as { active: string; scopes: Record<string, { turns: unknown[]; asked: string[] }> };
    const id = saved.active;
    await command.handler("questions on", ctx);
    const params = { scope_id: id, milestone_id: "agreed-milestone", milestone: "pre", requirement: "agreed", change: "planned", tests: "not run", focus: "main.ts", question: "この保証が必要な理由は？" };
    const toolCtx = { ...ctx, tools: [], executeTool: async () => { throw new Error("No implementation tool may run"); } } as ExtensionToolContext;
    const result = await tool.execute("qa", params, undefined, undefined, toolCtx);
    await tool.execute("qa-repeat", params, undefined, undefined, toolCtx);
    const final = branch.at(-1)!.data as typeof saved;
    assert.equal(final.scopes[id]!.asked.length, 1);
    assert.equal(final.scopes[id]!.turns.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /turns|learner dialogue.*:/);
    await assert.rejects(() => tool.execute("qa-wrong", { ...params, scope_id: "wrong" }, undefined, undefined, toolCtx), /mismatch/);
    assert.deepEqual(sent, []);
    await command.handler("handoff", ctx); assert.deepEqual(sent, []); assert.equal(confirmations, 1);
    approved = true; await command.handler("handoff", ctx); assert.deepEqual(sent, ["explicitly approved implementation request"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
