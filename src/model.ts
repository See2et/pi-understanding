import type { Source } from "./scope.ts";

/** Exact source existence is checked, not the semantic truth of the statement. */
export type Annotation = { start: number; end: number; text: string };
export const ANNOTATION_LIMITS = { count: 6, textBytes: 480, evidenceBytes: 1440, modelBytes: 12_000 };
export type Evidence = { path: string; ref: string; start: number; end: number; quote: string; annotations?: Annotation[] };
/** AI interpretation, never part of the exact quote. Sorted disjoint semantic chunks only. */
export function validateAnnotations(raw: unknown, start: number, end: number): Annotation[] | undefined {
  if (raw === undefined) return undefined; // v1/v2 evidence remains valid without annotations.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 60) throw new Error("Invalid annotation evidence range");
  if (!Array.isArray(raw) || raw.length > ANNOTATION_LIMITS.count) throw new Error("Invalid annotations count");
  let previous = start - 1, bytes = 0;
  return raw.map((value: unknown) => {
    const a = value as Annotation | null;
    if (!a || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start <= previous || a.start < start || a.end < a.start || a.end > end) throw new Error("Annotation outside exact evidence or overlapping/unsorted");
    if (typeof a.text !== "string" || !a.text.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(a.text) || Buffer.byteLength(a.text) > ANNOTATION_LIMITS.textBytes) throw new Error("Invalid annotation text");
    bytes += Buffer.byteLength(a.text);
    if (bytes > ANNOTATION_LIMITS.evidenceBytes) throw new Error("Annotations exceed evidence budget");
    previous = a.end;
    return { start: a.start, end: a.end, text: a.text };
  });
}
/** Value-identical evidence has one interpretation; omissions inherit it, conflicts fail closed. */
export function canonicalAnnotations(evidence: Evidence[], checkBudget = true): void {
  const groups = new Map<string, Evidence[]>();
  for (const e of evidence) { const key = JSON.stringify([e.path, e.ref, e.start, e.end, e.quote]); const group = groups.get(key) ?? []; group.push(e); groups.set(key, group); }
  for (const group of groups.values()) {
    const supplied = group.filter(e => e.annotations?.length);
    if (supplied.some(e => JSON.stringify(e.annotations) !== JSON.stringify(supplied[0]!.annotations))) throw new Error("Conflicting annotations for identical evidence");
    if (supplied.length) for (const e of group) e.annotations = supplied[0]!.annotations;
  }
  if (checkBudget && evidence.reduce((n, e) => n + (e.annotations ?? []).reduce((b, a) => b + Buffer.byteLength(a.text), 0), 0) > ANNOTATION_LIMITS.modelBytes) throw new Error("Annotations exceed model persistence budget");
}
export type ClaimKind = "concept" | "rule" | "boundary" | "behavior" | "rationale";
export type Claim = {
  id: string; kind: ClaimKind; statement: string; detail?: string;
  status: "fact" | "inferred"; evidence: Evidence[]; signature?: Evidence; tests?: Evidence[];
  relations: { to: string; type: "depends" | "protects" | "constrains" | "explains" }[];
  challenge?: string;
};
/** References reuse canonical claim evidence (signature → tests → evidence), never copied quotes. */
export type EvidenceLink = { claim: string; evidence: number };
export type InteractionEntity = { id: string; kind: "module" | "function" | "data-store" | "external"; label: string; detail?: string; evidence: EvidenceLink[] };
export type Interaction = { id: string; from: string; to: string; kind: "calls" | "reads" | "writes" | "sends" | "receives" | "depends"; label: string; detail?: string; status: "fact" | "inferred"; evidence: EvidenceLink[] };
export type InteractionView = { entities: InteractionEntity[]; interactions: Interaction[] };
export const INTERACTION_LIMITS = { entities: 24, interactions: 48, links: 6 };
export type ModelState = { claims?: Claim[]; interactions?: InteractionView; interactionIssue?: string; modelSummary?: string; selectedClaim?: string; evidenceView?: Evidence; annotationsVisible?: boolean; questions: boolean; skippedChallenges?: string[]; proposal?: string };
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
  const annotations = validateAnnotations(e.annotations, e.start, e.end);
  return { path: e.path, ref: e.ref, start: e.start, end: e.end, quote, ...(annotations === undefined ? {} : { annotations }) };
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
  canonicalAnnotations(claims.flatMap(claimEvidence));
  if (claims.reduce((bytes, c) => bytes + claimEvidence(c).reduce((n, e) => n + Buffer.byteLength(e.quote), 0), 0) > 96_000) throw new Error("Model evidence exceeds persistence budget");
  if (claims.some(c => c.relations.some(r => !ids.has(r.to) || r.to === c.id))) throw new Error("Relations must refer to other real claims");
  return claims;
}
/** Generation and restore share the same bounded graph/reference contract. No conceptual relation conversion. */
export function validateInteractions(raw: unknown, claims: Claim[]): InteractionView | undefined {
  if (raw === undefined) return undefined;
  const graph = raw as InteractionView | null;
  if (!graph || !Array.isArray(graph.entities) || !Array.isArray(graph.interactions) || !graph.entities.length || graph.entities.length > INTERACTION_LIMITS.entities || !graph.interactions.length || graph.interactions.length > INTERACTION_LIMITS.interactions) throw new Error("Interaction view requires 1-24 entities and 1-48 interactions");
  const entityIds = new Set<string>(), edgeIds = new Set<string>();
  const referenced = new Map<string, Evidence>();
  const identifier = (value: unknown, ids: Set<string>) => {
    const id = bounded(value, 64, "interaction ID");
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error("Interaction IDs must be unique ASCII identifiers");
    ids.add(id); return id;
  };
  const links = (raw: unknown): EvidenceLink[] => {
    if (!Array.isArray(raw) || !raw.length || raw.length > INTERACTION_LIMITS.links) throw new Error("Entities and interactions require 1-6 canonical evidence links");
    const seen = new Set<string>();
    return raw.map(value => {
      const link = value as EvidenceLink | null;
      const claim = link && claims.find(c => c.id === link.claim);
      const evidence = claim && Number.isInteger(link!.evidence) && claimEvidence(claim)[link!.evidence - 1];
      if (!link || typeof link.claim !== "string" || link.claim.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(link.claim) || !evidence || typeof evidence.path !== "string" || typeof evidence.ref !== "string" || !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 1 || evidence.end < evidence.start || evidence.end - evidence.start > 60 || typeof evidence.quote !== "string" || !evidence.quote.trim() || evidence.quote.split("\n").length !== evidence.end - evidence.start + 1 || Buffer.byteLength(evidence.quote) > 96_000) throw new Error("Interaction evidence must reference existing exact claim evidence");
      const key = `${link.claim}:${link.evidence}`;
      if (seen.has(key)) throw new Error("Duplicate interaction evidence link");
      seen.add(key); referenced.set(key, evidence); return { claim: link.claim, evidence: link.evidence };
    });
  };
  const entities = graph.entities.map(n => {
    if (!n || !["module", "function", "data-store", "external"].includes(n.kind)) throw new Error("Invalid interaction entity kind");
    return { id: identifier(n.id, entityIds), kind: n.kind, label: bounded(n.label, 120, "entity label"), ...(n.detail === undefined ? {} : { detail: bounded(n.detail, 1200, "entity detail") }), evidence: links(n.evidence) };
  });
  const interactions = graph.interactions.map(n => {
    if (!n || !entityIds.has(n.from) || !entityIds.has(n.to) || !["calls", "reads", "writes", "sends", "receives", "depends"].includes(n.kind) || !["fact", "inferred"].includes(n.status)) throw new Error("Invalid directed interaction endpoints/kind/status");
    return { id: identifier(n.id, edgeIds), from: n.from, to: n.to, kind: n.kind, status: n.status, label: bounded(n.label, 160, "interaction label"), ...(n.detail === undefined ? {} : { detail: bounded(n.detail, 1200, "interaction detail") }), evidence: links(n.evidence) };
  });
  if ([...referenced.values()].reduce((bytes, proof) => bytes + Buffer.byteLength(proof.quote), 0) > 96_000) throw new Error("Interaction evidence exceeds persistence budget");
  return { entities, interactions };
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
