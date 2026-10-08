import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { Source } from "./scope.ts";

export const CAPTURE_LIMITS = { files: 512, bytes: 8_000_000, fileBytes: 1_000_000 };
export type SnapshotReference = { version: 1; id: string; repository: string; root: string; snapshot: string };
export type SnapshotBinding = { repository: string; root: string; snapshot: string };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const snapshotStorageRoot = (): string => path.join(homedir(), ".local", "share", "pi-understanding", "snapshots");
function directory(root: string, create: boolean): string {
  const absolute = path.resolve(root);
  // Refuse aliases at every component. No config/auth paths or repository objects are used.
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { const s = lstatSync(current); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Unsafe snapshot directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error; mkdirSync(current, { mode: 0o700 }); }
  }
  const s = lstatSync(absolute);
  if ((s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) throw new Error("Snapshot root must be owner-only (0700)");
  return realpathSync(absolute);
}
function validSource(raw: unknown): raw is Source {
  const s = raw as Source | null;
  return !!s && typeof s.path === "string" && !!s.path && !s.path.startsWith("/") && !/[\\:\x00-\x1f\x7f]/.test(s.path) && !s.path.split("/").some(p => !p || p === "." || p === "..") && typeof s.ref === "string" && typeof s.text === "string" && !s.text.includes("\0") && s.digest === digest(s.text) && s.startLine === undefined;
}
/** Immutable content-addressed private local storage. No automatic eviction of active/saved snapshots. */
export function storeSnapshot(binding: SnapshotBinding, sources: Source[], storageRoot = snapshotStorageRoot()): SnapshotReference {
  if (sources.length > CAPTURE_LIMITS.files || sources.some(s => !validSource(s) || Buffer.byteLength(s.text) > CAPTURE_LIMITS.fileBytes) || sources.reduce((n, s) => n + Buffer.byteLength(s.text), 0) > CAPTURE_LIMITS.bytes) throw new Error("Snapshot capture exceeds bounded source contract");
  const identity = { repository: binding.repository, root: binding.root, snapshot: binding.snapshot };
  const text = JSON.stringify({ version: 1, ...identity, sources });
  const reference: SnapshotReference = { version: 1, ...identity, id: digest(text) };
  const file = path.join(directory(storageRoot, true), `${reference.id}.json`);
  try {
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, text, "utf8"); } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    loadSnapshot(reference, binding, storageRoot); // Existing immutable identity must match, including permissions.
  }
  return reference;
}
export function loadSnapshot(reference: SnapshotReference, binding: SnapshotBinding, storageRoot = snapshotStorageRoot()): Source[] {
  if (reference.version !== 1 || !/^[a-f0-9]{64}$/.test(reference.id) || reference.repository !== binding.repository || reference.root !== binding.root || reference.snapshot !== binding.snapshot) throw new Error("Snapshot binding mismatch");
  const file = path.join(directory(storageRoot, false), `${reference.id}.json`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || stat.size > CAPTURE_LIMITS.bytes * 7 + 100_000) throw new Error("Unsafe or oversized snapshot file");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let text: string;
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 || opened.size !== stat.size) throw new Error("Snapshot file changed during open");
    text = readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
  if (digest(text) !== reference.id) throw new Error("Snapshot digest mismatch");
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw.version !== 1 || raw.repository !== binding.repository || raw.root !== binding.root || raw.snapshot !== binding.snapshot || !Array.isArray(raw.sources) || raw.sources.length > CAPTURE_LIMITS.files || raw.sources.some(s => !validSource(s) || Buffer.byteLength(s.text) > CAPTURE_LIMITS.fileBytes) || raw.sources.reduce((n: number, s: Source) => n + Buffer.byteLength(s.text), 0) > CAPTURE_LIMITS.bytes) throw new Error("Invalid snapshot content/binding");
  return raw.sources as Source[];
}
