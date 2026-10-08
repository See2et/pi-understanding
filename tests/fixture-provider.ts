// Opt-in deterministic QA provider. Never included in the package manifest.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
type Block = { ref: string; path: string; lines: Map<number, string> };
/** Parse the pinned SOURCE blocks actually sent, so every quote is copied from transmitted bytes. */
function sentSources(text: string): Block[] {
  const blocks: Block[] = [];
  for (const block of text.split("\nSOURCE ").slice(1)) {
    const header = block.slice(0, block.indexOf("\n"));
    const match = header.match(/^(\S+?):(\S+) sha256=/); if (!match) continue;
    const lines = new Map<number, string>();
    for (const line of block.slice(header.length + 1).split("\n")) { if (line === "END SOURCE") break; const n = line.match(/^(\d+): (.*)$/); if (n) lines.set(Number(n[1]), n[2]!); }
    blocks.push({ ref: match[1]!, path: match[2]!, lines });
  }
  return blocks;
}
/** Long claim detail (twenty short paragraphs, ≤2000 characters). Each paragraph has distinct start/end markers. */
export function longDetail(): string {
  return Array.from({ length: 20 }, (_, i) => { const n = String(i + 1).padStart(2, "0"); return `P${n}始 ${"長い主張の説明文です。".repeat(6)} P${n}終`; }).join("\n\n");
}
export const LONG_MARKERS = Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(2, "0")).flatMap(n => [`P${n}始`, `P${n}終`]);
export default function fixture(pi: ExtensionAPI): void {
  pi.registerProvider("understanding-qa", {
    api: "openai-responses", baseUrl: "https://invalid.invalid", apiKey: "not-a-credential-fixture-only",
    models: [{ id: "gpt-qa", name: "GPT deterministic QA (no inference)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const all = JSON.stringify(context.messages);
      const learning = all.includes("Pinned scope");
      const latest = JSON.stringify(context.messages.at(-1));
      const targetProposal = !learning && latest.includes("QA_TARGET_DELAY");
      const fail = latest.includes("FAIL_NATIVE");
      const waiting = latest.includes("WAIT_CANCEL");
      const slow = latest.includes("SLOW_STREAM");
      const intent = latest.match(/(GENERATE_MODEL|GENERATE_MAP|PROPOSAL_HYPOTHESIS|DIALOGUE) intent/)?.[1] ?? "DIALOGUE";
      const round = Number(latest.match(/Retrieval round (\d+)\//)?.[1] ?? 0);
      const sourceText = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      const blocks = sentSources(sourceText);
      const pick = (path: string, line: number) => { const block = blocks.find(b => b.path === path && b.lines.has(line)); return block ? { path, ref: block.ref, start: line, end: line, quote: block.lines.get(line)! } : undefined; };
      let payload: Record<string, unknown>;
      if (!learning) payload = {};
      else if (intent === "GENERATE_MAP") {
        const main = pick("src/main.ts", 1);
        payload = { reply: "日本語の学習回答です。通常の実装チャットとは独立しています。\n\n## 責任と失敗\n固定した根拠だけを確認しました。省略したファイルは未確認です。", map: main ? [{ stage: "結果を受け取る", stageReason: "返却する処理だから", importanceReason: "結果と失敗の契約を理解するため", flow: "送信する", responsibility: "結果を返すハンドラ", symbol: "submit()", contract: "固定ソースに書かれた文字列を返す", tests: "この収集範囲では未確認", evidence: [main] }] : [] };
      } else if (intent === "GENERATE_MODEL" && sourceText.includes("LONG_CLAIM_FIXTURE")) {
        // Long-claim reading QA: one claim without any selectable row, one whose controls follow the long detail.
        const line = pick("src/long-claim.ts", 2);
        payload = {
          reply: "長い主張を読むためのQAモデルです。",
          modelSummary: "長い説明を途中で飛ばさずに読めるかを確かめます。",
          claims: [
            { id: "long-plain", kind: "concept", statement: "長い推論の主張は操作がなくても最後まで読めます。", detail: longDetail(), status: "inferred", evidence: [], relations: [] },
            { id: "long-controls", kind: "rule", statement: "長い主張の後ろの操作は読み終えてから選べます。", detail: longDetail(), status: line ? "fact" : "inferred", evidence: line ? [line] : [], relations: [{ to: "long-plain", type: "explains" }], challenge: "長い説明の途中を飛ばさずに読めましたか？" },
          ],
        };
      } else if (intent === "GENERATE_MODEL" && round === 0) {
        // One bounded readonly retrieval round, so QA renders the visible need/search progress.
        payload = { reply: "README と入口の実装を確認するため、固定snapshotから追加で読みます。", need: [{ path: "README.md", start: 1, end: 2, why: "利用者フローの記述を確認" }], search: [{ text: "submit", why: "入口の所在を確認" }] };
      } else if (intent === "GENERATE_MODEL") {
        const picked = pick("src/main.ts", 1);
        const main = picked ? { ...picked, annotations: [{ start: 1, end: 1, text: "固定の結果文字列を返す入口。" }] } : undefined;
        const readme = pick("README.md", 2);
        payload = {
          reply: "固定した対象からモデルを生成しました。引用は照合済みですが、主張の意味は解釈です。",
          modelSummary: "送信から結果までの小さな流れと、その根拠を固定対象から説明します。",
          claims: [
            { id: "submit-handler", kind: "concept", statement: "submit() は結果文字列を返す入口です。", detail: "利用者の送信は submit() に届き、固定された文字列を結果として返します。検証処理はこの固定対象では確認できません。", status: main ? "fact" : "inferred", evidence: main ? [main] : [], ...(main ? { signature: main } : {}), relations: [], challenge: "submit() が例外を投げるように変わったら、利用者フローのどこが変わりますか？" },
            { id: "literal-result", kind: "rule", statement: "結果は固定文字列で、入力に依存しません。", status: main ? "fact" : "inferred", evidence: main ? [main] : [], relations: [{ to: "submit-handler", type: "constrains" }] },
            { id: "validate-boundary", kind: "boundary", statement: "validate の実装はこの固定対象では確認できません。", status: "inferred", evidence: [], relations: [{ to: "flow-order", type: "depends" }] },
            { id: "flow-order", kind: "behavior", statement: "利用者フローは submit → validate → result の順です。", status: readme ? "fact" : "inferred", evidence: readme ? [readme] : [], relations: [{ to: "submit-handler", type: "depends" }], challenge: "validate を飛ばすと結果はどう変わると予測しますか？" },
            { id: "why-literal", kind: "rationale", statement: "固定文字列なのは、QAの結果を決定的にするためと推測されます。", status: "inferred", evidence: [], relations: [{ to: "literal-result", type: "explains" }], challenge: "この推測が誤りだとしたら、どの根拠で確かめますか？" },
          ],
        };
      } else if (intent === "PROPOSAL_HYPOTHESIS") {
        payload = { reply: "この変更案は未実装の仮説として扱います。現状のモデルは変えずに、動きうる主張だけを挙げます。\n\n- literal-result（入力に依存しない）が動く可能性があります。" };
      } else if (latest.includes("LONG_REPLY")) {
        const tag = `LONG-${latest.match(/LONG_REPLY (\d+)/)?.[1] ?? "0"}`;
        payload = { reply: `${tag}-START\n\n${Array.from({ length: 120 }, (_, i) => `段落 ${String(i + 1).padStart(3, "0")}: ${"長い回答の本文です。".repeat(16)}`).join("\n\n")}\n\n${tag}-END` };
      } else if (slow) {
        payload = { reply: `SLOW-START\n\n${Array.from({ length: 40 }, (_, i) => `ゆっくり届く行 ${i + 1}`).join("\n\n")}\n\nSLOW-END` };
      } else {
        payload = { reply: "日本語の学習回答です。通常の実装チャットとは独立しています。\n\n## 責任と失敗\n固定した根拠だけを確認しました。省略したファイルは未確認です。\n\n- 入力 → 検証 → 結果\n- テストの存在は追加参照で確認できます。" };
      }
      const reply = learning ? JSON.stringify(payload) : "main-chat-probe: 通常の実装チャットは動作しています。";
      const msg: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      // Bounded delta count keeps long deterministic replies quick; SLOW_STREAM spreads output over ~3s.
      const step = slow ? Math.ceil(reply.length / 40) : Math.max(8, Math.ceil(reply.length / 60));
      const delay = slow ? 75 : learning ? 25 : 8;
      void (async () => {
        if (targetProposal) {
          await new Promise(r => setTimeout(r, 2500));
          const proposal: AssistantMessage = { ...msg, content: [{ type: "toolCall", id: "qa-target-call", name: "select_understanding_scope", arguments: { specification: "changes", reason: "QA: 未commit分を確認してください" } }], stopReason: "toolUse" };
          stream.push({ type: "done", reason: "toolUse", message: proposal }); stream.end(proposal); return;
        }
        if (waiting) await new Promise(r => setTimeout(r, 1800));
        stream.push({ type: "start", partial: { ...msg, content: [], stopReason: "pending" } });
        for (let i = 0; i < reply.length; i += step) {
          if (options?.signal?.aborted) { const aborted = { ...msg, stopReason: "aborted" as const }; stream.push({ type: "error", reason: "aborted", error: aborted }); stream.end(aborted); return; }
          const delta = reply.slice(i, i + step); stream.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...msg, content: [{ type: "text", text: reply.slice(0, i + step) }], stopReason: "pending" } });
          await new Promise(r => setTimeout(r, delay));
        }
        if (fail) { const error = { ...msg, stopReason: "error" as const, errorMessage: "deterministic native provider failure" }; stream.push({ type: "error", reason: "error", error }); stream.end(error); }
        else { stream.push({ type: "done", reason: "stop", message: msg }); stream.end(msg); }
      })();
      return stream;
    },
  });
  pi.registerCommand("qa-exit", { description: "QA fixture orderly shutdown", handler: async (_args, ctx) => { ctx.shutdown(); } });
}
