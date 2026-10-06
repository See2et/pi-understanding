// Opt-in deterministic QA provider. Never included in the package manifest.
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function fixture(pi: ExtensionAPI): void {
  pi.registerProvider("understanding-qa", {
    api: "openai-responses", baseUrl: "https://invalid.invalid", apiKey: "not-a-credential-fixture-only",
    models: [{ id: "gpt-qa", name: "GPT deterministic QA (no inference)", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 5000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const all = JSON.stringify(context.messages);
      const learning = all.includes("Pinned scope");
      const latest = JSON.stringify(context.messages.at(-1));
      const fail = latest.includes("FAIL_NATIVE");
      const waiting = latest.includes("WAIT_CANCEL");
      const sourceText = context.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      const source = sourceText.match(/SOURCE ([^\n:]+):(src\/main\.ts) sha256=[^\n]*\n1: ([^\n]*)/);
      const map = source ? [{ flow: "送信する", responsibility: "結果を返すハンドラ", symbol: "submit()", contract: "固定ソースに書かれた文字列を返す", tests: "この収集範囲では未確認", evidence: [{ path: source[2]!, ref: source[1]!, start: 1, end: 1, quote: source[3]! }] }] : [];
      const reply = learning ? JSON.stringify({ reply: "日本語の学習回答です。通常の実装チャットとは独立しています。\n\n## 責任と失敗\n固定した根拠だけを確認しました。省略したファイルは未確認です。\n\n- 入力 → 検証 → 結果\n- テストの存在は追加参照で確認できます。", map }) : "main-chat-probe: 通常の実装チャットは動作しています。";
      const msg: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: reply }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      void (async () => {
        if (waiting) await new Promise(r => setTimeout(r, 1800));
        stream.push({ type: "start", partial: { ...msg, content: [], stopReason: "pending" } });
        for (let i = 0; i < reply.length; i += 8) {
          if (options?.signal?.aborted) { const aborted = { ...msg, stopReason: "aborted" as const }; stream.push({ type: "error", reason: "aborted", error: aborted }); stream.end(aborted); return; }
          const delta = reply.slice(i, i + 8); stream.push({ type: "text_delta", contentIndex: 0, delta, partial: { ...msg, content: [{ type: "text", text: reply.slice(0, i + 8) }], stopReason: "pending" } });
          await new Promise(r => setTimeout(r, learning ? 25 : 8));
        }
        if (fail) { const error = { ...msg, stopReason: "error" as const, errorMessage: "deterministic native provider failure" }; stream.push({ type: "error", reason: "error", error }); stream.end(error); }
        else { stream.push({ type: "done", reason: "stop", message: msg }); stream.end(msg); }
      })();
      return stream;
    },
  });
  pi.registerCommand("qa-exit", { description: "QA fixture orderly shutdown", handler: async (_args, ctx) => { ctx.shutdown(); } });
}
