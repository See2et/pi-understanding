import { run, repositoryIdentity, type ScopeRequest } from "./scope.ts";
import { terminalText } from "./pane.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Target = { label: string; request: ScopeRequest };
export async function targets(cwd: string, kind: "branch" | "commit" | "pr"): Promise<Target[]> {
  const { root } = await repositoryIdentity(cwd);
  if (kind === "branch") {
    const lines = (await run(root, "git", ["for-each-ref", "--count=50", "--sort=-committerdate", "--format=%(refname:short)\t%(objectname:short)\t%(subject)", "refs/heads/"])).trim().split("\n").filter(Boolean);
    return lines.map(line => { const [ref, oid, ...subject] = line.split("\t"); return { label: `${ref} · ${oid} · ${subject.join(" ")}`, request: { kind: "branch", ref: ref! } }; });
  }
  if (kind === "commit") {
    const lines = (await run(root, "git", ["log", "-20", "--format=%H\t%P\t%ad\t%s", "--date=short"])).trim().split("\n").filter(Boolean);
    return lines.flatMap(line => { const [ref, parents, date, ...subject] = line.split("\t"); return (parents ?? "").split(" ").filter(Boolean).map((parent, i) => ({ label: `${date} · ${ref!.slice(0, 10)} · ${subject.join(" ")}${parents!.includes(" ") ? ` · parent ${i + 1}` : ""}`, request: { kind: "commit" as const, ref: ref!, parent } })); });
  }
  const list = JSON.parse(await run(root, "gh", ["pr", "list", "--limit", "20", "--state", "open", "--json", "number,title,headRefName"])) as { number: number; title: string; headRefName: string }[];
  return list.map(pr => ({ label: `#${pr.number} · ${pr.title} · ${pr.headRefName}`, request: { kind: "pr", number: String(pr.number) } }));
}
export async function targetMetadata(cwd: string, includePR = false): Promise<unknown> {
  const { root } = await repositoryIdentity(cwd);
  const status = await run(root, "git", ["status", "--short", "--untracked-files=normal"]);
  const current = (await run(root, "git", ["branch", "--show-current"])).trim();
  return { root, currentBranch: current || "detached HEAD", changes: status.slice(0, 6000), branches: await targets(root, "branch"), commits: await targets(root, "commit"), ...(includePR ? { prs: await targets(root, "pr") } : {}), note: "Metadata only, no learner dialogue. Lists are bounded. PR network access only when requested. Ask user about intent; select_understanding_scope requires confirmation." };
}
export async function chooseTarget(ctx: ExtensionContext): Promise<ScopeRequest | undefined> {
  if (!ctx.hasUI) throw new Error("対象選択には対話UIが必要です。明示コマンドまたはAIに相談してください。");
  const choices = ["changes — 未commit分（staged / unstaged / 未追跡source）", "branch — ローカルbranchの内容", "repository — コード全体", "module — 部分の責任", "commit — 最近のcommitから選ぶ", "pr — 開いているPRから選ぶ"];
  const selected = await ctx.ui.select("何を理解しますか？", choices);
  if (!selected) return undefined;
  const kind = selected.split(" ")[0];
  if (kind === "changes" || kind === "repository") return { kind };
  if (kind === "module") { const module = await ctx.ui.input("repository-relative module path"); return module ? { kind, module } : undefined; }
  if (kind !== "branch" && kind !== "commit" && kind !== "pr") return undefined;
  const candidates = await targets(ctx.cwd, kind);
  if (!candidates.length) throw new Error("候補がありません。commitは親のある履歴、PRはopenのみを表示します。/understand helpで明示指定もできます。");
  const labels = candidates.map((item, i) => terminalText(`${i + 1}. ${item.label}`));
  const pick = await ctx.ui.select("対象を選択（番号やREFを覚える必要はありません）", labels);
  if (!pick) return undefined;
  const request = candidates[labels.indexOf(pick)]?.request;
  if (request?.kind === "branch") {
    const comparison = await ctx.ui.select("branchの理解範囲", ["branch全体の内容", "別のbranchとの分岐後の変更"]);
    if (!comparison) return undefined;
    if (comparison.startsWith("別")) {
      const bases = candidates.filter(item => item.request.kind === "branch" && item.request.ref !== request.ref);
      const baseLabels = bases.map((item, i) => terminalText(`${i + 1}. ${item.label}`));
      if (!baseLabels.length) throw new Error("比較元のローカルbranchがありません。branch全体を選ぶか、明示コマンドで比較元REFを指定してください。");
      const base = await ctx.ui.select("比較元のローカルbranch（merge-baseを使います）", baseLabels);
      if (!base) return undefined;
      const baseRequest = bases[baseLabels.indexOf(base)]?.request;
      if (baseRequest?.kind !== "branch") return undefined;
      return { ...request, base: baseRequest.ref };
    }
  }
  return request;
}
