import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import understanding from "../src/extension.ts";
import { freshLearning, freshState, ENTRY } from "../src/learning.ts";
import { hash, repositoryIdentity, type Scope } from "../src/scope.ts";
import { neovimHandoff, openNeovim, writeNeovimHandoff, pluginRoot, serverExpression, NVIM_LAUNCH, neovimLaunchArgs, type NeovimHandoff } from "../src/neovim.ts";
import type { Evidence } from "../src/model.ts";

const exec = promisify(execFile);
const code = "outside-before\nfunction decide(value) {\n  if (!value) return;\n  return value;\n}\n-- vim: set modifiable: \n'); vim.g.handoff_injected = true; --\noutside-after\n";
const source = { path: "src/quote'; vim.g.handoff_injected = true; --.ts", ref: "worktree", text: code, digest: hash(code) };
const evidence: Evidence = { path: source.path, ref: source.ref, start: 2, end: 5, quote: code.split("\n").slice(1, 5).join("\n"), annotations: [{ start: 2, end: 3, text: "値がなければ処理を終える。" }, { start: 4, end: 5, text: "'); vim.g.handoff_injected = true; --" }] };
const scope = (): Scope => ({ id: "fixed-scope", repository: "repo", root: "/unused", snapshot: "snapshot-identity", request: { kind: "repository" }, base: "base", head: "head", capturedAt: 0, fingerprint: "fixed", omitted: 0, files: [source.path], sources: [source] });
const isolated = path.join(pluginRoot, ".evidence/neovim/isolated");
const environment = () => ({ ...process.env, XDG_CONFIG_HOME: path.join(isolated, "config"), XDG_DATA_HOME: path.join(isolated, "data"), XDG_STATE_HOME: path.join(isolated, "state"), NVIM_LOG_FILE: path.join(pluginRoot, ".evidence/neovim/nvim.log") });

async function fixtureHandoff() {
  const data = await neovimHandoff(scope(), evidence);
  const file = await writeNeovimHandoff(data);
  return { data, file, directory: path.dirname(file) };
}

async function verifyStartup(file: string, failReadonly = false) {
  const result = await exec("nvim", ["--headless", ...neovimLaunchArgs(), "-c", "lua dofile(vim.env.PI_UNDERSTANDING_TEST_STARTUP_CHECK)"], {
    timeout: 20_000, env: { ...environment(), PI_UNDERSTANDING_NVIM_PLUGIN: pluginRoot, PI_UNDERSTANDING_NVIM_HANDOFF: file,
      PI_UNDERSTANDING_TEST_STARTUP_CHECK: path.join(pluginRoot, "tests/neovim-startup.lua"), PI_UNDERSTANDING_TEST_FAIL_READONLY: failReadonly ? "1" : "0" },
  });
  assert.doesNotMatch(result.stderr, /E\d+:|stack traceback|assertion failed/i, "startup must not conceal Neovim/Lua errors");
  assert.equal(JSON.parse(result.stdout).status, "STARTUP_CONTRACT_OK");
  return result;
}

test("real isolated headless Neovim shows whole pinned source, exact annotations, navigation, immutable buffers and rejects malformed/private-boundary failures", async () => {
  const { data, file, directory } = await fixtureHandoff();
  const artifact = path.join(pluginRoot, ".evidence/neovim"); await mkdir(artifact, { recursive: true });
  await rm(path.join(artifact, "headless-launch.txt"), { force: true });
  try {
    const live = path.join(directory, source.path); await mkdir(path.dirname(live), { recursive: true });
    await writeFile(live, "LIVE WORK MUST NOT BE READ OR MODIFIED\n");
    assert.equal((await lstat(directory)).mode & 0o777, 0o700); assert.equal((await lstat(file)).mode & 0o777, 0o600);
    const bad: string[] = [];
    const invalid = async (name: string, text: string) => { const f = path.join(directory, name); await writeFile(f, text, { mode: 0o600 }); bad.push(f); };
    await invalid("invalid-json", "{not JSON");
    for (const [name, transform] of [
      ["version", (d: NeovimHandoff) => { d.version = 2 as 1; }],
      ["digest", (d: NeovimHandoff) => { d.source += "changed"; }],
      ["quote", (d: NeovimHandoff) => { d.evidence.quote += "changed"; }],
      ["range", (d: NeovimHandoff) => { d.evidence.end = 500; }],
      ["annotation-range", (d: NeovimHandoff) => { d.evidence.annotations![0]!.start = 1; }],
      ["overlap", (d: NeovimHandoff) => { d.evidence.annotations![1]!.start = 3; }],
      ["control", (d: NeovimHandoff) => { d.evidence.annotations![0]!.text = "\x1b[2J"; }],
      ["line-separator", (d: NeovimHandoff) => { d.evidence.annotations![0]!.text = "line\u2028break"; }],
      ["blank-unicode", (d: NeovimHandoff) => { d.evidence.annotations![0]!.text = "　"; }],
      ["annotations-shape", (d: NeovimHandoff) => { (d.evidence as unknown as { annotations: unknown }).annotations = false; }],
      ["binding", (d: NeovimHandoff) => { d.identity.ref = "other"; }],
      ["identity-control", (d: NeovimHandoff) => { d.identity.path += "\n"; }],
      ["annotations-count", (d: NeovimHandoff) => { d.evidence.annotations = Array(7).fill(d.evidence.annotations![0]); }],
      ["annotation-text-budget", (d: NeovimHandoff) => { d.evidence.annotations![0]!.text = "x".repeat(481); }],
    ] as const) { const malformed = structuredClone(data); transform(malformed); await invalid(name, JSON.stringify(malformed)); }
    await invalid("oversized", "x".repeat(6_200_001));
    const unsafe = path.join(directory, "unsafe-permissions"); await copyFile(file, unsafe); await chmod(unsafe, 0o644); bad.push(unsafe);
    const alias = path.join(directory, "symlink"); await symlink(file, alias); bad.push(alias);
    bad.push(path.join(directory, "missing"));
    const hidden = path.join(directory, "hidden.json"); await writeFile(hidden, JSON.stringify({ ...data, annotationsVisible: false }), { mode: 0o600 });
    const legacy = path.join(directory, "legacy.json"); await writeFile(legacy, JSON.stringify({ ...data, evidence: { ...data.evidence, annotations: undefined } }), { mode: 0o600 });
    const manifest = path.join(directory, "manifest.json"), report = path.join(artifact, "headless-integration.json");
    await writeFile(manifest, JSON.stringify({ file, bad, hidden, legacy, report, forbidden_write: path.join(directory, "must-not-exist") }), { mode: 0o600 });
    const result = await exec("nvim", ["--headless", "-u", "NONE", "-i", "NONE", "-n", "-l", path.join(pluginRoot, "tests/neovim-integration.lua")], {
      cwd: directory, timeout: 20_000, maxBuffer: 200_000, env: { ...environment(), PI_UNDERSTANDING_TEST_PLUGIN: pluginRoot, PI_UNDERSTANDING_TEST_MANIFEST: manifest },
    });
    await writeFile(path.join(artifact, "headless-output.txt"), result.stdout + result.stderr);
    const launch = await verifyStartup(file);
    await writeFile(path.join(artifact, "headless-launch.txt"), "Production new-launch args verified after normal initialization\n" + launch.stdout + launch.stderr);
    assert.equal(await readFile(file, "utf8"), JSON.stringify(data), "handoff unchanged by Neovim");
    assert.equal(await readFile(live, "utf8"), "LIVE WORK MUST NOT BE READ OR MODIFIED\n", "current worktree source is neither read instead of fixed bytes nor mutated");
    const actual = JSON.parse(await readFile(report, "utf8")); assert.equal(actual.nonmutation, true); assert.equal(actual.failures.length, bad.length); assert.equal(actual.annotations.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new-launch verification rejects a deliberately failed required readonly invariant with a nonzero Neovim exit", async () => {
  const { file, directory } = await fixtureHandoff();
  const artifact = path.join(pluginRoot, ".evidence/neovim/headless-launch-failure-sensitivity.txt");
  await rm(artifact, { force: true });
  try {
    let failure = "";
    await assert.rejects(verifyStartup(file, true), (error: unknown) => {
      const actual = error as { code?: unknown; stderr?: string };
      assert.equal(actual.code, 1, "required Lua invariant failure must exit nonzero, not resolve or merely fail output parsing");
      assert.match(actual.stderr ?? "", /startup evidence buffer must be readonly and nonmodifiable/);
      failure = actual.stderr!;
      return true;
    });
    await writeFile(artifact, "Deliberately failed readonly invariant rejected with process exit 1\n" + failure);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("whole fixed source is mandatory; explicit export/launch configuration, missing binary/server and injection boundaries fail without live fallback", async () => {
  const learning = freshLearning(scope()); learning.evidenceView = evidence;
  const oldEnv = Object.fromEntries(["PI_UNDERSTANDING_NVIM_SERVER", "PI_UNDERSTANDING_NVIM_TERMINAL", "PI_UNDERSTANDING_NVIM_BINARY", "NVIM_LOG_FILE"].map(k => [k, process.env[k]]));
  try {
    for (const k of Object.keys(oldEnv)) delete process.env[k];
    process.env.NVIM_LOG_FILE = path.join(pluginRoot, ".evidence/neovim/nvim.log");
    await assert.rejects(openNeovim(learning), /明示設定/);
    process.env.PI_UNDERSTANDING_NVIM_SERVER = "/no-such-pi-understanding-server";
    process.env.PI_UNDERSTANDING_NVIM_BINARY = "/no-such-nvim";
    await assert.rejects(openNeovim(learning), /executable unavailable/);
    delete process.env.PI_UNDERSTANDING_NVIM_BINARY;
    await assert.rejects(openNeovim(learning), /handoff failed/);
    delete process.env.PI_UNDERSTANDING_NVIM_SERVER;
    process.env.PI_UNDERSTANDING_NVIM_TERMINAL = "not-json";
    await assert.rejects(openNeovim(learning), /JSON/);
    process.env.PI_UNDERSTANDING_NVIM_TERMINAL = '["/no-such-terminal","-e"]';
    await assert.rejects(openNeovim(learning), /handoff failed/);
    delete process.env.PI_UNDERSTANDING_NVIM_TERMINAL;
    await assert.rejects(openNeovim(learning, "export", () => false), /中止/);
    const text = await openNeovim(learning, "export"), file = text.split("\n")[0]!.split(": ")[1]!;
    try { const exported = JSON.parse(await readFile(file, "utf8")); assert.equal(exported.source, code); assert.deepEqual(exported.evidence.annotations, evidence.annotations); assert.ok(!("turns" in exported)); }
    finally { await rm(path.dirname(file), { recursive: true, force: true }); }
    const partial = { ...scope(), sources: [{ ...source, startLine: 2, text: evidence.quote }] };
    await assert.rejects(neovimHandoff(partial, evidence), /not captured/);
    await assert.rejects(neovimHandoff({ ...scope(), sources: [] }, evidence), /not captured/);
    await assert.rejects(neovimHandoff({ ...scope(), sources: [{ ...source, digest: "0".repeat(64) }] }, evidence), /Whole fixed/);
    const escaped = serverExpression("/tmp/quote' ; os.execute('bad')/evidence.json");
    assert.ok(escaped.endsWith("'/tmp/quote'' ; os.execute(''bad'')/evidence.json')"), "Vim string escaping, not command/Lua interpolation");
    assert.ok(!NVIM_LAUNCH.includes(source.path));
  } finally { for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test("public /u nvim command opens selected fixed evidence on an explicit real server, preserves user work/conversation and passes paths as data", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "understanding-nvim-server-"));
  const socket = path.join(dir, "server.sock"), artifact = path.join(pluginRoot, ".evidence/neovim");
  const oldServer = process.env.PI_UNDERSTANDING_NVIM_SERVER;
  const child = spawn("nvim", ["--headless", "-u", "NONE", "-i", "NONE", "-n", "--listen", socket, "-c", "lua vim.opt.runtimepath:prepend(vim.env.PI_UNDERSTANDING_TEST_PLUGIN); vim.api.nvim_buf_set_lines(0,0,-1,false,{'UNSAVED USER WORK'}); io.stderr:write('NVIM_TEST_READY\\n'); io.stderr:flush()"], {
    env: { ...environment(), PI_UNDERSTANDING_TEST_PLUGIN: pluginRoot }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", b => { output += b; });
  const files: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Neovim startup timeout: ${output}`)), 10_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Neovim exited ${code}: ${output}`)); });
      child.stderr.on("data", b => { output += b; if (output.includes("NVIM_TEST_READY")) { clearTimeout(timer); resolve(); } });
    });
    process.env.PI_UNDERSTANDING_NVIM_SERVER = socket;
    const identity = await repositoryIdentity(pluginRoot), pinned = scope(); pinned.repository = identity.repository; pinned.root = identity.root;
    const learning = freshLearning(pinned); learning.evidenceView = evidence;
    learning.turns = [{ role: "user", text: "PRIVATE LEARNER DIALOGUE", timestamp: 0 }];
    const state = freshState(identity.repository); state.active = pinned.id; state.scopes[pinned.id] = learning;
    let command!: Parameters<ExtensionAPI["registerCommand"]>[1]; const events = new Map<string, (event: unknown, context: ExtensionContext) => Promise<void>>(); const notices: string[] = [];
    understanding({ registerCommand: (_name: string, definition: typeof command) => { command = definition; }, registerShortcut: () => {}, registerTool: () => {}, on: (name: string, handler: (event: unknown, context: ExtensionContext) => Promise<void>) => events.set(name, handler), appendEntry: () => { throw new Error("Neovim open must not alter learning state"); } } as unknown as ExtensionAPI);
    const context = { cwd: pluginRoot, mode: "rpc", hasUI: false, sessionManager: { getBranch: () => [{ type: "custom", customType: ENTRY, data: state }] }, ui: { notify: (text: string) => notices.push(text), setStatus: () => {} } } as unknown as ExtensionCommandContext;
    await events.get("session_start")!({}, context);
    await command.handler("nvim", context);
    assert.match(notices.at(-1)!, /Neovimへ固定根拠を受渡しました/);
    files.push(notices.at(-1)!.split("\n")[0]!.split(": ")[1]!);
    const publicData = JSON.parse(await readFile(files[0]!, "utf8")); assert.equal(publicData.source, code); assert.doesNotMatch(JSON.stringify(publicData), /PRIVATE LEARNER/);
    // Real remote API observation, not a fake nvim executable or a mocked plugin.
    const observation = await exec("nvim", ["--server", socket, "--remote-expr", "luaeval('vim.json.encode({source=table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false), \"\\n\"),readonly=vim.bo.readonly,modifiable=vim.bo.modifiable,identity=vim.b.pi_understanding_identity,original=vim.api.nvim_buf_get_lines(1,0,-1,false),draft=vim.bo[1].modified})')"], { timeout: 10_000 });
    const observed = JSON.parse(observation.stdout); assert.equal(observed.source, code); assert.equal(observed.readonly, true); assert.equal(observed.modifiable, false); assert.deepEqual(observed.original, ["UNSAVED USER WORK"]); assert.equal(observed.draft, true);
    // A private handoff path containing Vim/Lua metacharacters survives the real RPC boundary.
    const quoted = path.join(dir, "private ' quote"); await mkdir(quoted, { mode: 0o700 }); const quotedFile = path.join(quoted, "evidence.json"); await writeFile(quotedFile, JSON.stringify(publicData), { mode: 0o600 });
    const opened = await exec("nvim", ["--server", socket, "--remote-expr", serverExpression(quotedFile)], { timeout: 10_000 }); assert.match(opened.stdout, /^\d+/);
    await mkdir(artifact, { recursive: true }); await writeFile(path.join(artifact, "server-command.json"), JSON.stringify({ publicCommand: "/u nvim", observed, quotedPathOpened: true, notices }, null, 2));
    assert.equal(JSON.stringify(state.scopes[pinned.id]!.turns), JSON.stringify(learning.turns));
    await events.get("session_shutdown")!({}, context);
  } finally {
    if (oldServer === undefined) delete process.env.PI_UNDERSTANDING_NVIM_SERVER; else process.env.PI_UNDERSTANDING_NVIM_SERVER = oldServer;
    const exited = new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); }); child.kill("SIGTERM"); await exited;
    for (const file of files) await rm(path.dirname(file), { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
