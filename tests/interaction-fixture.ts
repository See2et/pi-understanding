import { freshLearning } from "../src/learning.ts";
import { validateClaims, validateInteractions, type InteractionView } from "../src/model.ts";
import { hash, type Scope, type Source } from "../src/scope.ts";
export const interactionSource: Source = { path: "src/checkout.ts", ref: "worktree", digest: "", text: [
  'import { load, save } from "./orders.ts";',
  'import { charge } from "./payments.ts";',
  'export async function checkout(id: string) {',
  '  const order = await load(id);',
  '  const receipt = await charge(order.total);',
  '  await save(id, receipt);',
  '  return receipt;',
  '}',
].join("\n") };
interactionSource.digest = hash(interactionSource.text);
export function interactionFixture() {
  const source = structuredClone(interactionSource);
  const evidence = (start: number, end = start) => ({ path: source.path, ref: source.ref, start, end, quote: source.text.split("\n").slice(start - 1, end).join("\n") });
  const claims = validateClaims([
    { id: "entry", kind: "behavior", statement: "checkout は注文を読み、決済して結果を保存します。", detail: "注文IDに対して一連の処理を実行します。失敗時のrollbackはこの引用だけでは確認できません。", status: "fact", signature: evidence(3), evidence: [evidence(1, 8)], relations: [] },
    { id: "storage", kind: "boundary", statement: "注文の読み書きは orders module に委譲します。", status: "fact", evidence: [evidence(1), evidence(4), evidence(6)], relations: [{ to: "entry", type: "protects" }] },
    { id: "payment", kind: "boundary", statement: "決済は payments module を介します。", status: "fact", evidence: [evidence(2), evidence(5)], relations: [] },
  ], [source]);
  const interactions: InteractionView = {
    entities: [
      { id: "checkout-module", kind: "module", label: "checkout.ts", detail: "注文から決済までの入口module。", evidence: [{ claim: "entry", evidence: 2 }] },
      { id: "checkout", kind: "function", label: "checkout(id)", evidence: [{ claim: "entry", evidence: 1 }] },
      { id: "orders", kind: "data-store", label: "Orders store (orders.ts API)", detail: "保存先の実装は未確認。storeとしての分類はAPIからの解釈です。", evidence: [{ claim: "storage", evidence: 1 }] },
      { id: "payments", kind: "module", label: "payments.ts", evidence: [{ claim: "payment", evidence: 1 }] },
      { id: "charge", kind: "function", label: "charge(total)", evidence: [{ claim: "payment", evidence: 2 }] },
    ],
    interactions: [
      { id: "delegates", from: "checkout-module", to: "checkout", kind: "depends", label: "公開入口に処理を委譲", status: "inferred", evidence: [{ claim: "entry", evidence: 2 }] },
      { id: "load-order", from: "checkout", to: "orders", kind: "reads", label: "注文IDで注文を読み出す", status: "fact", evidence: [{ claim: "storage", evidence: 2 }] },
      { id: "payment-api", from: "checkout-module", to: "payments", kind: "depends", label: "決済APIをimport", status: "fact", evidence: [{ claim: "payment", evidence: 1 }] },
      { id: "charge-order", from: "checkout", to: "charge", kind: "calls", label: "注文の合計金額を決済", status: "fact", evidence: [{ claim: "payment", evidence: 2 }] },
      { id: "save-receipt", from: "checkout", to: "orders", kind: "writes", label: "注文IDに決済結果を保存", status: "fact", evidence: [{ claim: "storage", evidence: 3 }] },
    ],
  };
  const scope: Scope = { id: "interaction-sample-scope", repository: "sample-repository", root: "/sample/checkout", base: "b".repeat(40), head: "c".repeat(40), snapshot: "d".repeat(64), request: { kind: "module", module: "src" }, sources: [source], files: [source.path], omitted: 2, fingerprint: "fixed", capturedAt: 0 };
  const learning = freshLearning(scope);
  learning.claims = claims; learning.interactions = validateInteractions(interactions, claims); learning.modelSummary = "注文の読出し → 決済 → 結果の保存。固定した入口の引用から説明します。"; learning.stale = "unknown";
  return { learning, source, claims, interactions };
}
