import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Learning } from "./learning.ts";
export function escapeHtml(text: string): string { return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
export function diagramHtml(learning: Learning): string {
  const e = escapeHtml;
  const rows = learning.map.map((n, i) => `<g transform="translate(16,${16 + i * 74})"><rect width="900" height="60" rx="4" fill="#172238" stroke="#7188aa"/><text x="12" y="25" fill="#f2f5fc">${e(`${n.flow} → ${n.responsibility} → ${n.symbol}`)}</text><text x="12" y="47" fill="#cbd9ed">${e(n.evidence.map(r => `${r.path}:${r.start}-${r.end}`).join(" / "))}</text></g>`).join("\n");
  const details = learning.map.map(n => `<section><h2>${e(n.flow)}</h2><p>${e(n.responsibility)} → ${e(n.symbol)}</p><p>契約: ${e(n.contract)}</p><p>テスト: ${e(n.tests)}</p>${n.evidence.map(r => `<h3>${e(`${r.ref}:${r.path}:${r.start}-${r.end}`)}</h3><pre>${e(r.quote)}</pre>`).join("")}</section>`).join("");
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'"><title>Pi understanding</title><style>body{background:#0e1727;color:#f2f5fc;font:16px/1.7 system-ui,sans-serif;margin:24px auto;padding:0 20px;max-width:1000px}h1{font-size:24px}h2{font-size:20px;margin-top:32px}h3{font:14px monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#172238;padding:12px}svg{width:100%;height:auto}p{overflow-wrap:anywhere}</style><h1>理解マップ</h1><p>${e(learning.scope.root)} / ${e(learning.scope.request.kind)} / ${e(learning.scope.id)}</p><p>base ${e(learning.scope.base)} → head ${e(learning.scope.head)} / snapshot ${e(learning.scope.snapshot)}</p><p>状態 ${e(learning.stale)}。収集 ${learning.scope.sources.length}、未収集 ${learning.scope.omitted}。学習会話は含みません。</p><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 932 ${Math.max(80, learning.map.length * 74 + 16)}" role="img" aria-label="利用者フローから責任と重要関数への対応">${rows}</svg>${details}</html>`;
}
export async function openDiagram(learning: Learning): Promise<string> {
  if (!learning.map.length) throw new Error("先に /understand map で根拠付きマップを作成してください。");
  const dir = await mkdtemp(path.join(tmpdir(), "pi-understanding-"));
  const file = path.join(dir, "map.html");
  await writeFile(file, diagramHtml(learning), { mode: 0o600 });
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try { await promisify(execFile)(opener, [file], { timeout: 10_000 }); } catch (error) { throw new Error(`HTMLを保存しました: ${file}。ブラウザ起動失敗: ${String(error)}`); }
  return file;
}
