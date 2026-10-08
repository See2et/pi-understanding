import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import understanding from "../src/extension.ts";
import { ENTRY, freshLearning, freshState } from "../src/learning.ts";
import { hash, repositoryIdentity } from "../src/scope.ts";
import { pluginRoot, neovimLaunchArgs } from "../src/neovim.ts";
import { UnderstandingPane } from "../src/pane.ts";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

test("public /u nvim and pane shortcut share exclusive stop/inherit/start lifecycle, preserve pane draft/navigation, and restore on failures", async () => {
  initTheme();
  const keys = ["PI_UNDERSTANDING_NVIM_SERVER", "PI_UNDERSTANDING_NVIM_TERMINAL", "PI_UNDERSTANDING_NVIM_BINARY"];
  const previous = keys.map(k => process.env[k]); keys.forEach(k => delete process.env[k]);
  const identity = await repositoryIdentity(pluginRoot);
  const text = "outside before\nconst pinned = true;\noutside after\n";
  const source = { path: "fixed.ts", ref: "worktree", text, digest: hash(text) };
  const learning = freshLearning({ id: "fixed", repository: identity.repository, root: identity.root, snapshot: "snapshot", request: { kind: "repository" }, base: "base", head: "head", capturedAt: 0, fingerprint: "immutable", omitted: 0, files: [source.path], sources: [source] });
  learning.selectedClaim = "selected";
  learning.evidenceView = { path: source.path, ref: source.ref, start: 2, end: 2, quote: "const pinned = true;", annotations: [{ start: 2, end: 2, text: "固定値を宣言する。" }] };
  learning.turns = [{ role: "user", text: "PRIVATE DIALOGUE", timestamp: 0 }];
  const state = freshState(identity.repository); state.active = learning.scope.id; state.scopes[state.active] = learning;
  const events = new Map<string, (e: unknown, c: ExtensionContext) => Promise<void>>();
  let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
  const notices: string[] = [], order: string[] = [], handoffs: string[] = [];
  let pane!: UnderstandingPane, stopped = false, failure: Error | undefined, interactive = true;
  let deferLaunch: (() => void) | undefined, hold = false;
  const tui = { requestRender: (force?: boolean) => { if (force) order.push("render"); }, stop: () => { order.push("stop"); stopped = true; }, start: () => { order.push("start"); stopped = false; } } as unknown as TUI;
  const custom: ExtensionUIContext["custom"] = (factory, options) => new Promise((resolve, reject) => {
    let mounted = false, isPane = false;
    const done = (value: unknown) => { assert.ok(mounted, "custom completion must not pop the existing pane before its own overlay mounts"); if (!isPane) order.push("done"); resolve(value as never); };
    Promise.resolve(factory(tui, theme, {} as never, done)).then(component => {
      if (component instanceof UnderstandingPane) {
        pane = component; mounted = true; isPane = true;
        let hidden = false;
        options?.onHandle?.({ setHidden: (value: boolean) => { hidden = value; }, isHidden: () => hidden, focus: () => { pane.focused = true; }, isFocused: () => pane.focused, unfocus: () => { pane.focused = false; } } as never);
      } else {
        assert.equal(options?.overlay, true); assert.equal((options?.overlayOptions as { nonCapturing?: boolean }).nonCapturing, true);
        mounted = true; order.push("mounted");
        const launch = () => options?.onHandle?.({} as never);
        if (hold) deferLaunch = launch; else launch();
      }
    }).catch(reject);
  });
  const context = { cwd: pluginRoot, mode: "tui", hasUI: true, sessionManager: { getBranch: () => [{ type: "custom", customType: ENTRY, data: state }] }, ui: { custom, notify: (message: string) => notices.push(message), setStatus: () => {} } } as unknown as ExtensionCommandContext;
  understanding({ registerCommand: (_name: string, definition: typeof command) => { command = definition; }, registerShortcut: () => {}, registerTool: () => {}, on: (name: string, handler: (e: unknown, c: ExtensionContext) => Promise<void>) => events.set(name, handler), appendEntry: () => { throw new Error("Neovim must not persist or mutate learning state"); } } as unknown as ExtensionAPI, {
    interactive: () => interactive,
    run: (binary, args, env) => {
      assert.equal(stopped, true, "terminal ownership must be released before launch"); order.push("launch");
      assert.equal(binary, "nvim"); assert.deepEqual(args, neovimLaunchArgs());
      handoffs.push(env.PI_UNDERSTANDING_NVIM_HANDOFF!);
      if (failure) throw failure;
    },
  });
  try {
    await events.get("session_start")!({}, context);
    await command.handler("open", context); await new Promise(resolve => setImmediate(resolve));
    pane.handleInput("LEARNER UNSENT"); pane.handleInput("\x1b[5~");
    const view = pane.view(), editor = view.editor, stateBefore = JSON.stringify(state);
    const checkRetained = () => { assert.equal(pane.view().editor, editor); assert.deepEqual(pane.view(), view); assert.equal(pane.focused, true); assert.equal(JSON.stringify(state), stateBefore); assert.equal(stopped, false); };
    await command.handler("nvim", context);
    assert.deepEqual(order, ["mounted", "stop", "launch", "start", "render", "done"]); checkRetained();
    const actual = JSON.parse(await readFile(handoffs[0]!, "utf8")); assert.equal(actual.source, text); assert.deepEqual(actual.evidence, learning.evidenceView); assert.doesNotMatch(JSON.stringify(actual), /PRIVATE DIALOGUE/);
    for (const error of [new Error("spawn ENOENT"), new Error("Neovim exited with code 1"), new Error("Neovim terminated by SIGTERM")]) {
      failure = error; order.length = 0;
      await command.handler("nvim", context);
      assert.deepEqual(order, ["mounted", "stop", "launch", "start", "render", "done"]); assert.match(notices.at(-1)!, new RegExp(error.message)); checkRetained();
      await assert.rejects(readFile(handoffs.at(-1)!), /ENOENT/, "failed launch removes private handoff");
    }
    failure = undefined; order.length = 0;
    const notified = new Promise<void>(resolve => { const original = context.ui.notify; context.ui.notify = (...args) => { original(...args); resolve(); }; });
    pane.handleInput("\x1b[110;7u"); await notified;
    assert.deepEqual(order, ["mounted", "stop", "launch", "start", "render", "done"]); checkRetained();
    order.length = 0; interactive = false;
    await command.handler("nvim", context); assert.match(notices.at(-1)!, /対話TUIとTTY/); assert.deepEqual(order, []);
    interactive = true;
    await command.handler("nvim", { ...context, mode: "rpc", hasUI: true });
    assert.match(notices.at(-1)!, /対話TUIとTTY/); assert.deepEqual(order, [], "RPC with UI must never take over or launch a hidden terminal process");
    process.env.PI_UNDERSTANDING_NVIM_BINARY = "/no-such-nvim";
    await command.handler("nvim", context); assert.match(notices.at(-1)!, /executable unavailable/); assert.deepEqual(order, []); delete process.env.PI_UNDERSTANDING_NVIM_BINARY;
    hold = true;
    const pending = command.handler("nvim", context);
    while (!deferLaunch) await new Promise(resolve => setImmediate(resolve));
    await command.handler("nvim", context); assert.match(notices.at(-1)!, /処理中/);
    await events.get("session_shutdown")!({}, context); deferLaunch(); await pending;
    assert.deepEqual(order, ["mounted", "done"], "stale request must not suspend or launch");
  } finally {
    for (const file of handoffs) await rm(path.dirname(file), { recursive: true, force: true });
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
  }
});
