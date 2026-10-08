import type { Source } from "./scope.ts";

/** Exact source existence is checked, not the semantic truth of the statement. */
export type Evidence = { path: string; ref: string; start: number; end: number; quote: string };
export type ClaimKind = "concept" | "rule" | "boundary" | "behavior" | "rationale";
export type Claim = {
  id: string; kind: ClaimKind; statement: string; detail?: string;
  status: "fact" | "inferred"; evidence: Evidence[]; signature?: Evidence; tests?: Evidence[];
  relations: { to: string; type: "depends" | "protects" | "constrains" | "explains" }[];
  challenge?: string;
};
export type ModelState = { claims?: Claim[]; modelSummary?: string; selectedClaim?: string; evidenceView?: Evidence; questions: boolean; skippedChallenges?: string[]; proposal?: string };
export type ReadRequest = { path: string; ref?: string; start: number; end: number; why: string };
export type SearchRequest = { text: string; why: string };
export type ReadRecord = { path: string; ref: string; start?: number; end?: number; digest?: string; status: "sent" | "fetched" | "searched" | "unavailable" | "excluded" | "uncaptured" | "budget"; reason?: string };

export function validateEvidence(raw: unknown, sources: Source[]): Evidence {
  if (!raw || typeof raw !== "object") throw new Error("Invalid evidence");
  const e = raw as Evidence;
  if (typeof e.path !== "string" || typeof e.ref !== "string" || !Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start < 1 || e.end < e.start || e.end - e.start > 60) throw new Error("Evidence is outside the supplied pinned source");
  const s = sources.find(s => s.path === e.path && s.ref === e.ref && e.start >= (s.startLine ?? 1) && e.end < (s.startLine ?? 1) + s.text.split("\n").length);
  if (!s) throw new Error("Evidence is outside the supplied pinned source");
  const quote = s.text.split("\n").slice(e.start - (s.startLine ?? 1), e.end - (s.startLine ?? 1) + 1).join("\n");
  if (e.quote !== quote || !quote.trim()) throw new Error("Evidence quote does not match exact source lines");
  return { path: e.path, ref: e.ref, start: e.start, end: e.end, quote };
}
const bounded = (value: unknown, limit: number, name: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Invalid ${name}`);
  return value;
};
export function validateClaims(value: unknown, sources: Source[]): Claim[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("Model requires 1-20 claims");
  const ids = new Set<string>();
  const claims = value.map((raw: unknown): Claim => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid claim");
    const n = raw as Record<string, unknown>;
    const id = bounded(n.id, 64, "claim id");
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error("Claim IDs must be unique stable identifiers");
    ids.add(id);
    if (!["concept", "rule", "boundary", "behavior", "rationale"].includes(n.kind as string) || !["fact", "inferred"].includes(n.status as string)) throw new Error("Invalid claim kind/status");
    if (!Array.isArray(n.evidence) || n.evidence.length > 6 || (n.status === "fact" && !n.evidence.length)) throw new Error("Fact claims require exact evidence");
    if (!Array.isArray(n.relations) || n.relations.length > 10) throw new Error("Invalid claim relations");
    const relations = n.relations.map((r: unknown) => {
      const relation = r as { to?: unknown; type?: unknown } | null;
      if (!relation || typeof relation.to !== "string" || !["depends", "protects", "constrains", "explains"].includes(relation.type as string)) throw new Error("Invalid claim relation");
      return { to: relation.to, type: relation.type as Claim["relations"][number]["type"] };
    });
    if (n.tests !== undefined && (!Array.isArray(n.tests) || n.tests.length > 6)) throw new Error("Invalid test references");
    return { id, kind: n.kind as ClaimKind, status: n.status as Claim["status"], statement: bounded(n.statement, 300, "statement"),
      ...(n.detail === undefined ? {} : { detail: bounded(n.detail, 2000, "detail") }), evidence: n.evidence.map(e => validateEvidence(e, sources)), relations,
      ...(n.signature === undefined ? {} : { signature: validateEvidence(n.signature, sources) }),
      ...(n.tests === undefined ? {} : { tests: (n.tests as unknown[]).map(e => validateEvidence(e, sources)) }),
      ...(n.challenge === undefined ? {} : { challenge: bounded(n.challenge, 1000, "challenge") }) };
  });
  if (claims.reduce((bytes, c) => bytes + claimEvidence(c).reduce((n, e) => n + Buffer.byteLength(e.quote), 0), 0) > 96_000) throw new Error("Model evidence exceeds persistence budget");
  if (claims.some(c => c.relations.some(r => !ids.has(r.to) || r.to === c.id))) throw new Error("Relations must refer to other real claims");
  return claims;
}
/** Pure navigation: these functions never perform inference, refresh, or I/O. */
export function selectClaim(state: ModelState, id: string): void {
  if (!state.claims?.some(c => c.id === id)) throw new Error("Unknown model claim");
  state.selectedClaim = id; state.evidenceView = undefined;
}
export const selectedClaim = (state: ModelState): Claim | undefined => state.claims?.find(c => c.id === state.selectedClaim);
export function modelOverview(state: ModelState): void { state.selectedClaim = undefined; state.evidenceView = undefined; }
export function modelBack(state: ModelState): void { if (state.evidenceView) state.evidenceView = undefined; else modelOverview(state); }
export function claimEvidence(claim: Claim): Evidence[] { return [...(claim.signature ? [claim.signature] : []), ...(claim.tests ?? []), ...claim.evidence]; }
export function openClaimEvidence(state: ModelState, number = 1): Evidence {
  const claim = selectedClaim(state); const evidence = claim && claimEvidence(claim)[number - 1];
  if (!Number.isInteger(number) || !evidence) throw new Error("Unknown claim evidence number");
  state.evidenceView = evidence; return evidence;
}
export function claimChallenge(state: ModelState): string | undefined {
  const claim = selectedClaim(state);
  return state.questions && claim && !state.skippedChallenges?.includes(claim.id) ? claim.challenge : undefined;
}
export function skipChallenge(state: ModelState): void { if (state.selectedClaim) state.skippedChallenges = [...new Set([...(state.skippedChallenges ?? []), state.selectedClaim])]; }
export function claimDetail(claim: Claim): string {
  return `## ${claim.id} ${claim.statement}\n${claim.kind} · ${claim.status === "inferred" ? "解釈（推論）" : "現状の主張"}\n引用照合は意味の正しさの保証ではありません。\n\n${claim.detail ?? ""}\n\n関係: ${claim.relations.map(r => `${r.type} → ${r.to}`).join(" / ") || "未記録"}\n\n${claimEvidence(claim).map((e, i) => `${i + 1}. ${e.ref}:${e.path}:${e.start}-${e.end}`).join("\n")}`;
}
export function modelOverviewText(state: ModelState): string {
  return state.claims?.length ? `${state.modelSummary ?? ""}\n\n${state.claims.map(c => `${c.id} [${c.kind}/${c.status}] ${c.statement}`).join("\n")}\n\n引用は実在照合済み、モデルの意味は解釈です。` : "モデルはまだありません。model で明示生成できます。旧マップは新しいモデルではありません。";
}
/** Requests are bounded untrusted data, never executable tools. Path/ref authorization belongs to scope. */
export function parseReadRequests(raw: Record<string, unknown>): { need: ReadRequest[]; search: SearchRequest[] } {
  const need = raw.need ?? []; const search = raw.search ?? [];
  if (!Array.isArray(need) || !Array.isArray(search) || need.length + search.length > 6) throw new Error("At most six read/search requests per round");
  return { need: need.map((v: unknown) => {
    const n = v as Record<string, unknown> | null;
    if (!n || !Number.isInteger(n.start) || !Number.isInteger(n.end) || (n.start as number) < 1 || (n.end as number) < (n.start as number) || (n.end as number) - (n.start as number) > 60) throw new Error("Read requires a bounded exact line range");
    return { path: bounded(n.path, 1000, "read path"), ...(n.ref === undefined ? {} : { ref: bounded(n.ref, 100, "read ref") }), start: n.start as number, end: n.end as number, why: bounded(n.why, 500, "read reason") };
  }), search: search.map((v: unknown) => { const n = v as Record<string, unknown> | null; if (!n) throw new Error("Invalid search"); return { text: bounded(n.text, 200, "search text"), why: bounded(n.why, 500, "search reason") }; }) };
}
