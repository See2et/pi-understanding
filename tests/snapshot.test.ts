import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink, readdir, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { storeSnapshot, loadSnapshot } from "../src/snapshot.ts";
import { collectScope, pinnedFile, run, hash, type Source } from "../src/scope.ts";
import { freshState, freshLearning, persistedState, restore, ENTRY, LEGACY_ENTRY } from "../src/learning.ts";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "understanding-snapshot-"));
  const root = path.join(directory, "repo"), storage = path.join(directory, "private");
  await mkdir(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q"); await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/large.ts"), Array.from({ length: 300 }, (_, i) => `original ${i + 1} ${"x".repeat(150)}`).join("\n"));
  await writeFile(path.join(root, ".env"), "SECRET-MARKER");
  git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  return { directory, root, storage, git, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("large tracked repository snapshot reload is private, source-free in branch state, immutable after live edits, and writes no Git objects/index/refs", async () => {
  const f = await fixture();
  try {
    const before = { head: f.git("rev-parse", "HEAD"), refs: f.git("for-each-ref"), status: f.git("status", "--porcelain"), index: hash((await readFile(path.join(f.root, ".git/index"))).toString("hex")), objects: await readdir(path.join(f.root, ".git/objects"), { recursive: true }) };
    const scope = await collectScope(f.root, { kind: "repository" }, f.storage);
    const original = (await pinnedFile(scope, "src/large.ts", "worktree")).text;
    assert.ok(Buffer.byteLength(original) > 24_000); assert.ok(!scope.sources.some(s => s.path === ".env"));
    assert.deepEqual({ head: f.git("rev-parse", "HEAD"), refs: f.git("for-each-ref"), status: f.git("status", "--porcelain"), index: hash((await readFile(path.join(f.root, ".git/index"))).toString("hex")), objects: await readdir(path.join(f.root, ".git/objects"), { recursive: true }) }, before);
    assert.equal((await lstat(f.storage)).mode & 0o777, 0o700);
    const file = path.join(f.storage, `${scope.localSnapshot!.id}.json`);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    const state = freshState(scope.repository); state.active = scope.id; state.scopes[scope.id] = freshLearning(scope);
    const saved = persistedState(state, f.storage);
    assert.equal(saved.scopes[scope.id]!.scope.sources.length, 0); assert.ok(JSON.stringify(saved).length < original.length / 4);
    await writeFile(path.join(f.root, "src/large.ts"), "live new content\n");
    const restored = restore([{ type: "custom", customType: ENTRY, data: saved }], scope.repository, f.storage);
    assert.equal((await pinnedFile(restored.scopes[scope.id]!.scope, "src/large.ts", "worktree")).text, original);
    const sourceFree = { ...scope, sources: [] };
    assert.equal((await pinnedFile(sourceFree, "src/large.ts", "worktree", undefined, f.storage)).text, original);
    await rm(file);
    await assert.rejects(() => pinnedFile(sourceFree, "src/large.ts", "worktree", undefined, f.storage), /snapshot unavailable/);
    const missing = restore([{ type: "custom", customType: ENTRY, data: saved }], scope.repository, f.storage);
    assert.equal(missing.scopes[scope.id]!.scope.sources.length, 0); assert.match(missing.scopes[scope.id]!.turns.at(-1)!.text, /読み直しません/);
  } finally { await f.cleanup(); }
});

test("v1 migration retains only captured bytes, old map/drafts target identity and branch separation; does not invent uncaptured files", async () => {
  const f = await fixture();
  try {
    const scope = await collectScope(f.root, { kind: "repository" }, f.storage); delete scope.localSnapshot;
    scope.sources = scope.sources.slice(0, 1);
    const learning = freshLearning(scope); learning.focus = "legacy-focus"; learning.turns = [{ role: "user", text: "private dialogue", timestamp: 1 }];
    learning.mapSummary = "legacy-map, not a verified model"; learning.selectedPoint = 1;
    const state = { version: 1 as const, repository: scope.repository, active: scope.id, scopes: { [scope.id]: learning } };
    const before = structuredClone(state);
    const migrated = restore([{ type: "custom", customType: LEGACY_ENTRY, data: state }], scope.repository, f.storage);
    assert.equal(migrated.version, 2); assert.equal(migrated.scopes[scope.id]!.claims, undefined);
    assert.equal(migrated.scopes[scope.id]!.selectedPoint, 1); assert.equal(migrated.scopes[scope.id]!.focus, "legacy-focus");
    const saved = persistedState(migrated, f.storage); assert.deepEqual(state, before); assert.equal(saved.scopes[scope.id]!.scope.sources.length, 0);
    assert.equal(restore([{ type: "custom", customType: ENTRY, data: saved }], "other-repository", f.storage).active, undefined);
    assert.equal(restore([], scope.repository, f.storage).active, undefined);
    const old = before.scopes[scope.id]!.scope;
    await assert.rejects(() => pinnedFile(old, "never-captured.ts", "worktree"), /not captured/);
  } finally { await f.cleanup(); }
});

test("partial clone reads never fetch missing promisor blobs or mutate Git, and retain honest fixed coverage", async () => {
  const f = await fixture();
  try {
    const available = "export const available = true;\n";
    await writeFile(path.join(f.root, "src/available.ts"), available);
    f.git("add", "src/available.ts"); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "available source");
    f.git("config", "uploadpack.allowFilter", "true");
    const clone = path.join(f.directory, "partial");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${f.root}`, clone]);
    const git = (...args: string[]) => execFileSync("git", ["--no-lazy-fetch", ...args], { cwd: clone, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
    const missing = f.git("rev-parse", "HEAD:src/large.ts");
    assert.equal(git("config", "remote.origin.promisor"), "true");
    assert.throws(() => git("cat-file", "-e", missing), "fixture must actually lack the promisor blob");
    // Import one available blob before taking the baseline; the missing blob stays remote.
    execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: clone, input: available });
    const marker = path.join(f.directory, "fetch-attempted");
    const upload = path.join(f.directory, "upload-pack");
    await writeFile(upload, `#!/bin/sh\nprintf attempted >> '${marker}'\nexec git-upload-pack "$@"\n`, { mode: 0o700 });
    git("config", "remote.origin.uploadpack", upload);
    const image = async () => {
      const entries = (await readdir(path.join(clone, ".git"), { recursive: true })).filter(name => /^(objects|refs)(\/|$)|^(HEAD|index|config|packed-refs)$/.test(name)).sort();
      const files: Record<string, string> = {};
      for (const name of entries) if ((await lstat(path.join(clone, ".git", name))).isFile()) files[name] = hash((await readFile(path.join(clone, ".git", name))).toString("hex"));
      return files;
    };
    const before = await image();
    // Exercise the exported central boundary as well as scope capture and later reference reads.
    await assert.rejects(() => run(clone, "git", ["cat-file", "-e", missing]));
    const scope = await collectScope(clone, { kind: "branch", ref: git("branch", "--show-current") }, f.storage);
    assert.ok(scope.coverage?.some(c => c.path === "src/large.ts" && c.status === "unavailable"));
    assert.ok(!scope.sources.some(s => s.path === "src/large.ts"));
    assert.equal((await pinnedFile(scope, "src/available.ts", scope.head)).text, available);
    assert.equal(loadSnapshot(scope.localSnapshot!, scope, f.storage).find(s => s.path === "src/available.ts")?.text, available);
    await assert.rejects(() => pinnedFile(scope, "src/large.ts", scope.head, undefined, f.storage));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.deepEqual(await image(), before, "objects, refs, index, HEAD and config remain byte-identical");
    assert.throws(() => git("cat-file", "-e", missing), "missing evidence must not have been fetched");
  } finally { await f.cleanup(); }
});

test("snapshot boundaries reject aliases, public permissions, digest/repository mismatches, and symlinked worktree directories", async () => {
  const f = await fixture();
  try {
    const source: Source = { path: "x.ts", ref: "worktree", text: "fixed", digest: hash("fixed") };
    const binding = { root: f.root, repository: "repo", snapshot: "snapshot" };
    const reference = storeSnapshot(binding, [source], f.storage);
    assert.throws(() => loadSnapshot(reference, { ...binding, repository: "other" }, f.storage), /binding/);
    const file = path.join(f.storage, `${reference.id}.json`);
    await chmod(file, 0o644); assert.throws(() => loadSnapshot(reference, binding, f.storage), /Unsafe/); await chmod(file, 0o600);
    await writeFile(file, "changed"); assert.throws(() => loadSnapshot(reference, binding, f.storage), /digest/);
    const alias = path.join(f.directory, "alias"); await symlink(f.storage, alias);
    assert.throws(() => storeSnapshot(binding, [source], alias), /Unsafe/);
    await mkdir(path.join(f.root, "real")); await writeFile(path.join(f.root, "real/nested.ts"), "secret in alias");
    await symlink("real", path.join(f.root, "alias"));
    // Tracked path under a directory that later becomes a symlink must not be captured.
    await mkdir(path.join(f.root, "tracked")); await writeFile(path.join(f.root, "tracked/nested.ts"), "tracked"); f.git("add", "tracked");
    await rm(path.join(f.root, "tracked"), { recursive: true }); await symlink("real", path.join(f.root, "tracked"));
    await writeFile(path.join(f.root, "binary.ts"), Buffer.from([0xff, 0xfe, 0x41]));
    await writeFile(path.join(f.root, "bom.ts"), Buffer.from("\ufeffexport const utf8 = '日本語';\r\n", "utf8"));
    f.git("add", "binary.ts", "bom.ts");
    const scope = await collectScope(f.root, { kind: "repository" }, path.join(f.directory, "private2"));
    assert.ok(!scope.sources.some(s => s.path === "binary.ts"));
    assert.deepEqual(Buffer.from((await pinnedFile(scope, "bom.ts", "worktree")).text), await readFile(path.join(f.root, "bom.ts")));
    assert.ok(!scope.sources.some(s => s.path === "tracked/nested.ts")); assert.ok(scope.coverage?.some(c => c.path === "tracked/nested.ts" && c.status === "unavailable"));
    await assert.rejects(() => pinnedFile(scope, ".env", "worktree"), /excluded/);
  } finally { await f.cleanup(); }
});
