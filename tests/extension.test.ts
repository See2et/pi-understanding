import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import understanding from "../src/extension.ts";
import { collectScope, pinnedFile } from "../src/scope.ts";
import { ENTRY, freshLearning, freshState, type State } from "../src/learning.ts";
import { UnderstandingPane } from "../src/pane.ts";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { TUI, OverlayHandle } from "@earendil-works/pi-tui";

test("/u and Alt+S open confirmed no-diff repository without inference; model, selection, evidence, quiet and proposal commands preserve boundaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "understanding-model-extension-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(path.join(root, "main.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    const shortcuts = new Map<string, Parameters<ExtensionAPI["registerShortcut"]>[1]>();
    const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
    const branch: { type: string; customType: string; data: State }[] = []; let calls = 0, confirmations = 0; const notices: string[] = [];
    let completed: (() => void) | undefined;
    const ctx = { cwd: root, mode: "rpc", hasUI: true, model: { id: "gpt-test", provider: "test" }, modelRegistry: { streamSimple: (_model: unknown, context: { tools: unknown[]; messages: unknown[] }) => {
      calls++; assert.deepEqual(context.tools, []); const text = JSON.stringify(context);
      if (calls === 2) assert.match(text, /PROPOSAL_HYPOTHESIS/);
      const stream = createAssistantMessageEventStream();
      const answer = { role: "assistant", api: "openai-responses", provider: "test", model: "gpt-test", content: [{ type: "text", text: JSON.stringify(calls === 1 ? { reply: "値を持つモデルです。", modelSummary: "固定値です。", claims: [{ id: "value-rule", kind: "rule", statement: "値は1です。", status: "fact", evidence: [{ path: "main.ts", ref: "worktree", start: 1, end: 1, quote: "export const value = 1;", annotations: [{ start: 1, end: 1, text: "固定値を公開する。" }] }], relations: [], challenge: "値を予測してください。" }] } : { reply: "変更案は仮説です。" }) }], stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as AssistantMessage;
      stream.push({ type: "done", reason: "stop", message: answer }); stream.end(answer); return stream;
    } }, sessionManager: { getBranch: () => branch }, ui: { setStatus: () => {}, notify: (text: string) => notices.push(text), select: async () => "repository — コード全体", confirm: async () => { confirmations++; return true; } } } as unknown as ExtensionCommandContext;
    understanding({ registerCommand: (name: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => commands.set(name, definition), registerShortcut: (name: string, definition: Parameters<ExtensionAPI["registerShortcut"]>[1]) => shortcuts.set(name, definition), registerTool: () => {}, getCommands: () => [], on: (name: string, handler: (event: unknown, context: ExtensionContext) => Promise<void>) => events.set(name, handler), appendEntry: (customType: string, data: State) => { branch.push({ type: "custom", customType, data }); const current = data.active && data.scopes[data.active]; if (current && !current.pending && current.turns.at(-1)?.role === "assistant") { completed?.(); completed = undefined; } } } as unknown as ExtensionAPI);
    await events.get("session_start")!({}, ctx);
    await shortcuts.get("alt+s")!.handler(ctx); assert.equal(confirmations, 1); assert.equal(calls, 0);
    await commands.get("u")!.handler("", ctx); assert.equal(calls, 0); assert.ok(notices.some(n => n.includes("model")));
    const reply = new Promise<void>(resolve => { completed = resolve; }); await commands.get("u")!.handler("model", ctx); await reply;
    const state = () => branch.at(-1)!.data; const learning = () => state().scopes[state().active!]!;
    assert.equal(learning().claims?.[0]!.id, "value-rule"); assert.equal(learning().scope.sources.length, 0, "session entry contains only snapshot reference");
    await commands.get("u")!.handler("select value-rule", ctx); await commands.get("u")!.handler("evidence 1", ctx);
    assert.equal(learning().evidenceView?.quote, "export const value = 1;");
    assert.deepEqual(learning().evidenceView?.annotations, [{ start: 1, end: 1, text: "固定値を公開する。" }]);
    await commands.get("u")!.handler("annotations off", ctx); assert.equal(learning().annotationsVisible, false); assert.equal(calls, 1);
    await commands.get("u")!.handler("nvim export", ctx);
    const handoff = notices.at(-1)!.split("\n")[0]!.split(": ")[1]!;
    try { const exported = JSON.parse(await readFile(handoff, "utf8")); assert.equal(exported.source, "export const value = 1;\n"); assert.equal(exported.annotationsVisible, false); assert.deepEqual(exported.evidence.annotations, learning().evidenceView?.annotations); }
    finally { await rm(path.dirname(handoff), { recursive: true, force: true }); }
    await commands.get("u")!.handler("annotations on", ctx); assert.equal(learning().annotationsVisible, true); assert.equal(calls, 1);
    await commands.get("u")!.handler("back", ctx); assert.equal(learning().selectedClaim, "value-rule"); assert.equal(learning().evidenceView, undefined);
    await commands.get("u")!.handler("skip", ctx); await commands.get("u")!.handler("quiet", ctx);
    assert.deepEqual(learning().skippedChallenges, ["value-rule"]); assert.equal(learning().questions, false); assert.equal(calls, 1);
    const proposal = new Promise<void>(resolve => { completed = resolve; }); await commands.get("u")!.handler("proposal 値を2にする", ctx); await proposal;
    assert.equal(learning().proposal, "値を2にする"); assert.equal(learning().claims?.[0]!.statement, "値は1です。");
    await commands.get("u")!.handler("proposal clear", ctx); await commands.get("u")!.handler("overview", ctx);
    assert.equal(learning().proposal, undefined); assert.equal(learning().selectedClaim, undefined); assert.equal(calls, 2);
    await events.get("session_shutdown")!({}, ctx);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
      registerShortcut: () => {},
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

test("explicit preview command invokes only owned helper names; scope and shutdown boundaries clean up, with no automatic publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "understanding-preview-extension-"));
  const oldPath = process.env.PATH;
  let shutdown: (() => Promise<void>) | undefined;
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(path.join(root, "main.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=QA", "-c", "user.email=qa@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    const scope = await collectScope(root, { kind: "repository" }); const learning = freshLearning(scope);
    learning.map = [{ flow: "read", responsibility: "owner", symbol: "value", contract: "constant", tests: "unverified", evidence: [{ path: "main.ts", ref: "worktree", start: 1, end: 1, quote: "export const value = 1;" }] }];
    const state = freshState(scope.repository); state.active = scope.id; state.scopes[scope.id] = learning;
    const branch = [{ type: "custom", customType: ENTRY, data: state }];
    const bin = path.join(root, "fake-bin"), log = path.join(root, "calls.jsonl"), failRemove = path.join(root, "fail-remove"), holdRemove = path.join(root, "hold-remove"), removeEntered = path.join(root, "remove-entered"); await mkdir(bin);
    await writeFile(path.join(bin, "home-preview"), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n'); if(args[0] === 'remove' && fs.existsSync(${JSON.stringify(failRemove)})) { process.stderr.write('fixture removal denied'); process.exit(1); } if(args[0] === 'url') process.stdout.write('https://fixture.ts.net:8443/'); if(args[0] === 'remove' && fs.existsSync(${JSON.stringify(holdRemove)})) { fs.writeFileSync(${JSON.stringify(removeEntered)}, 'entered'); const timer = setInterval(() => { if(!fs.existsSync(${JSON.stringify(holdRemove)})) { clearInterval(timer); } }, 5); }\n`);
    await chmod(path.join(bin, "home-preview"), 0o755); process.env.PATH = `${bin}:${oldPath}`;
    let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
    const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>(); const notices: string[] = [];
    let learnerCalls = 0;
    const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
    const answer: AssistantMessage = { role: "assistant", api: "openai-responses", provider: "test", model: "gpt-test", content: [{ type: "text", text: JSON.stringify({ reply: "controlled response" }) }], stopReason: "stop", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const completeStreams = async () => {
      for (const stream of streams.splice(0)) { stream.push({ type: "text_delta", contentIndex: 0, delta: '{"reply":"controlled response"}', partial: answer }); stream.push({ type: "done", reason: "stop", message: answer }); stream.end(answer); }
      await delay(0);
    };
    const context = { cwd: root, mode: "rpc", hasUI: true, model: { id: "gpt-test", provider: "test" }, modelRegistry: { streamSimple: () => { learnerCalls++; const stream = createAssistantMessageEventStream(); streams.push(stream); return stream; } }, sessionManager: { getBranch: () => branch }, ui: { notify: (text: string) => { notices.push(text); }, setStatus: () => {} } } as unknown as ExtensionCommandContext;
    understanding({ registerCommand: (_name: string, definition: typeof command) => { command = definition; }, registerShortcut: () => {}, registerTool: () => {}, on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => { events.set(name, handler); }, appendEntry: (customType: string, data: typeof state) => { branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI);
    shutdown = () => events.get("session_shutdown")!({}, context);
    await events.get("session_start")!({}, context);
    await command.handler("overview", context); await command.handler("dive 1", context); await command.handler("open", context);
    await assert.rejects(() => readFile(log), /ENOENT/);
    await command.handler("diagram preview", context); assert.ok(notices.some(text => /https:\/\/fixture\.ts\.net:8443\/document-/.test(text)));
    await command.handler("scope repository", context);
    await command.handler("diagram preview", context); await shutdown();
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
    assert.deepEqual(calls.map(args => args[0]), ["add", "url", "remove", "add", "url", "remove"]);
    assert.equal(calls[0]![1], calls[2]![1]); assert.equal(calls[3]![1], calls[5]![1]); assert.notEqual(calls[0]![1], calls[3]![1]);
    // Cleanup still owns its name even when a transition restores no learning scope.
    branch.splice(0, branch.length, { type: "custom", customType: ENTRY, data: state });
    await events.get("session_start")!({}, context);
    await command.handler("diagram preview", context);
    await writeFile(failRemove, "deny");
    branch.length = 0;
    await events.get("session_tree")!({}, context);
    assert.ok(notices.some(text => /fixture removal denied/.test(text)));
    await rm(failRemove);
    await command.handler("diagram stop", context);
    assert.equal(notices.at(-1), "所有するpreviewを停止しました。");
    const retried = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]).slice(6);
    assert.deepEqual(retried.map(args => args[0]), ["add", "url", "remove", "remove"]);
    assert.equal(retried[0]![1], retried[2]![1]); assert.equal(retried[0]![1], retried[3]![1]);
    // A command may arrive while another command is awaiting boundary cleanup.
    branch.splice(0, branch.length, { type: "custom", customType: ENTRY, data: state });
    await events.get("session_start")!({}, context);
    await command.handler("diagram preview", context);
    await writeFile(holdRemove, "hold");
    const changing = command.handler("scope module main.ts", context);
    try {
      let entered = false;
      for (let attempt = 0; attempt < 100 && !entered; attempt++) {
        entered = await readFile(removeEntered).then(() => true, () => false);
        if (!entered) await delay(10);
      }
      assert.ok(entered, "scope transition must reach owned removal before concurrent request");
      const during = command.handler("diagram preview", context);
      await command.handler("ask boundary-question", context);
      await command.handler("map", context);
      await rm(holdRemove);
      await Promise.all([changing, during]);
      await completeStreams();
      assert.equal(learnerCalls, 0, "learner admission must stay closed for the complete transition");
      assert.ok(!branch.at(-1)!.data.scopes[scope.id]!.turns.some(turn => turn.text === "boundary-question"));
      const boundaryCalls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]).slice(10);
      assert.deepEqual(boundaryCalls.map(args => args[0]), ["add", "url", "remove"], "no old-scope publication may queue behind transition cleanup");
      assert.equal(boundaryCalls[0]![1], boundaryCalls[2]![1]);
      await assert.rejects(fetch(`http://127.0.0.1:${boundaryCalls[0]![2]}/`));
      assert.equal(branch.at(-1)!.data.scopes[branch.at(-1)!.data.active!]!.scope.request.kind, "module");
      await command.handler("ask after-boundary", context);
      assert.equal(learnerCalls, 1, "new scope can start learner inference after transition");
      await completeStreams();
      // Ctrl+T closes/remounts the pane while cancellation changes the active scope.
      initTheme("dark", false);
      const panes: UnderstandingPane[] = [];
      let reopened!: () => void;
      const mountedAgain = new Promise<void>(resolve => { reopened = resolve; });
      const tui = { terminal: { columns: 120, rows: 36 }, requestRender: () => {} } as unknown as TUI;
      const interactive = { ...context, mode: "tui", ui: { ...context.ui, select: async () => "repository — コード全体", confirm: async () => true, custom: (factory: (tui: TUI, th: typeof theme, kb: unknown, done: () => void) => UnderstandingPane, options: { onHandle: (handle: OverlayHandle) => void }) => new Promise<void>(done => {
        const pane = factory(tui, theme, {}, done); panes.push(pane);
        options.onHandle({ focus: () => { pane.focused = true; }, unfocus: () => { pane.focused = false; }, setHidden: () => {} } as unknown as OverlayHandle);
        if (panes.length > 1) reopened();
      }) } } as unknown as ExtensionCommandContext;
      await command.handler("open", interactive);
      await command.handler("ask pane-partial", interactive);
      streams[0]!.push({ type: "text_delta", contentIndex: 0, delta: '{"reply":"OLD-SCOPE-PARTIAL', partial: answer });
      await delay(0);
      assert.ok(panes[0]!.partial?.includes("OLD-SCOPE-PARTIAL"));
      panes[0]!.handleInput("scope-change-draft");
      const draftEditor = panes[0]!.view().editor;
      panes[0]!.handleInput("\x14");
      await Promise.race([mountedAgain, delay(2000).then(() => { throw new Error("Ctrl+T must reopen confirmed target"); })]);
      assert.equal(panes[1]!.view().input, "scope-change-draft");
      assert.equal(panes[1]!.view().editor, draftEditor, "native unsent draft survives target selection");
      assert.equal(panes[1]!.partial, undefined, "old-scope streaming text must not remount in new scope");
      assert.ok(!panes[1]!.render(116).join("\n").includes("OLD-SCOPE-PARTIAL"));
      await completeStreams();
      assert.equal(panes[1]!.partial, undefined, "late old stream completion remains invalid");
    } finally { await rm(holdRemove, { force: true }); await changing; }
  } finally { await shutdown?.(); process.env.PATH = oldPath; await rm(root, { recursive: true, force: true }); }
});
