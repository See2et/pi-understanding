import { pinnedFile, isWorktree } from "./scope.ts";
import { selectedNode, addReference, type Learning } from "./learning.ts";

/** Explicit all/ranges; otherwise show selected evidence (or a bounded first page), never live worktree content. */
export async function referenceSnippet(learning: Learning, specification: string): Promise<string> {
  const evidence = selectedNode(learning)?.evidence;
  const match = specification.trim().match(/^(.*?)(?:\s+(base|head|index))?(?:\s+(all|\d+-\d+))?$/)!;
  const file = match[1] || evidence?.[0]?.path;
  if (!file) throw new Error("reference PATH [base|head|index] [all|START-END] またはdive後にreference");
  const ref = match[2] === "base" ? learning.scope.base : match[2] === "index" ? "index" : !match[1] && evidence?.[0] ? evidence[0].ref : isWorktree(learning.scope.request) ? "worktree" : learning.scope.head;
  const source = await pinnedFile(learning.scope, file, ref);
  const lines = source.text.split("\n");
  const selected = evidence?.find(e => e.path === file && e.ref === ref);
  let start = selected?.start ?? 1, end = selected?.end ?? Math.min(40, lines.length);
  if (match[3] === "all") { start = 1; end = lines.length; }
  else if (match[3]) { [start, end] = match[3].split("-").map(Number) as [number, number]; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length) throw new Error("Reference range is outside the pinned file");
  addReference(learning, source);
  return `${source.ref}:${source.path}:${start}-${end} sha256=${source.digest}\n${lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join("\n")}\n固定snapshotのみ。全体は reference PATH [base|head|index] all`;
}
