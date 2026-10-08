import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedFile, hash, type Scope } from "./scope.ts";
import { validateEvidence, type Evidence } from "./model.ts";
import { CAPTURE_LIMITS } from "./snapshot.ts";
import type { Learning } from "./learning.ts";

const exec = promisify(execFile);
export const HANDOFF_LIMIT = 6_200_000; // JSON escaping of the existing 1MB file budget, plus bounded metadata.
export const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
export type NeovimHandoff = { version: 1; identity: { scope: string; repository: string; snapshot: string; path: string; ref: string; digest: string }; source: string; evidence: Evidence; annotationsVisible: boolean };
/** Reacquire the whole fixed file, never the live worktree or only a transmitted snippet. */
export async function neovimHandoff(scope: Scope, evidence: Evidence, annotationsVisible = true): Promise<NeovimHandoff> {
  const source = await pinnedFile(scope, evidence.path, evidence.ref);
  if (source.startLine !== undefined || Buffer.byteLength(source.text) > CAPTURE_LIMITS.fileBytes || source.text.includes("\0") || hash(source.text) !== source.digest) throw new Error("Whole fixed source unavailable or invalid; no live fallback");
  const validated = validateEvidence(evidence, [source]);
  const identity = { scope: scope.id, repository: scope.repository, snapshot: scope.snapshot, path: source.path, ref: source.ref, digest: source.digest };
  if (Object.values(identity).some(v => typeof v !== "string" || !v || Buffer.byteLength(v) > 1000 || /[\x00-\x1f\x7f-\x9f]/.test(v))) throw new Error("Invalid fixed source identity");
  return { version: 1, identity, source: source.text, evidence: validated, annotationsVisible };
}
export async function writeNeovimHandoff(data: NeovimHandoff): Promise<string> {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > HANDOFF_LIMIT) throw new Error("Neovim handoff exceeds budget");
  const directory = await mkdtemp(path.join(tmpdir(), "pi-understanding-nvim-"));
  try { await chmod(directory, 0o700); const file = path.join(directory, "evidence.json"); await writeFile(file, text, { mode: 0o600, flag: "wx" }); return file; }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
// Fixed code only. Paths arrive as data through environment / luaeval argument, never evaluated Lua.
export const NVIM_LAUNCH = "lua dofile(vim.env.PI_UNDERSTANDING_NVIM_PLUGIN .. '/lua/pi_understanding.lua').open(vim.env.PI_UNDERSTANDING_NVIM_HANDOFF, { reuse_window = true })";
/** Load normal user config/plugins, then the receiver; --cmd's buffer is reset by startup. Disable viewer ShaDa/swap writes. */
export const neovimLaunchArgs = (): string[] => ["-i", "NONE", "-n", "-c", NVIM_LAUNCH];
const vimString = (text: string) => `'${text.replaceAll("'", "''")}'`;
export const serverExpression = (file: string): string => `luaeval('require("pi_understanding").open(_A)', ${vimString(file)})`;
function terminalArgs(raw: string): string[] {
  const args: unknown = JSON.parse(raw);
  if (!Array.isArray(args) || !args.length || args.length > 8 || args.some(a => typeof a !== "string" || !a || a.length > 1000 || /[\x00-\x1f\x7f]/.test(a))) throw new Error("PI_UNDERSTANDING_NVIM_TERMINAL must be a bounded JSON argv array, e.g. [\"xterm\",\"-e\"]");
  return args as string[];
}
/** The caller owns interactive terminal suspension/restoration; this module owns fixed-source handoff. */
export type InPlaceNeovim = (binary: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
export async function openNeovim(learning: Learning, mode: "open" | "export" = "open", stillCurrent: () => boolean = () => true, inPlace?: InPlaceNeovim): Promise<string> {
  const evidence = learning.evidenceView;
  if (!evidence) throw new Error("先に /u select ID と /u evidence N で固定根拠を選択してください。");
  const server = mode === "open" ? process.env.PI_UNDERSTANDING_NVIM_SERVER : undefined;
  const terminal = mode === "open" ? process.env.PI_UNDERSTANDING_NVIM_TERMINAL : undefined;
  const binary = process.env.PI_UNDERSTANDING_NVIM_BINARY ?? "nvim";
  const argv = !server && terminal ? terminalArgs(terminal) : undefined;
  if (mode === "open" && !server && !argv && !inPlace) throw new Error("Neovimの直接表示には対話TUIとTTYが必要です。手動受渡しは /u nvim export。別terminal/serverの明示設定も利用できます。");
  if (server && (server.length > 1000 || /[\x00-\x1f\x7f]/.test(server))) throw new Error("Invalid Neovim server address");
  if (mode === "open") {
    try { await exec(binary, ["--version"], { timeout: 5000, maxBuffer: 16_000 }); }
    catch (error) { throw new Error(`Neovim executable unavailable: ${String(error)}`); }
  }
  const data = await neovimHandoff(learning.scope, evidence, learning.annotationsVisible !== false);
  if (!stillCurrent()) throw new Error("対象が変わったためNeovim受渡しを中止しました。");
  const file = await writeNeovimHandoff(data);
  try {
    if (!stillCurrent()) throw new Error("対象が変わったためNeovim受渡しを中止しました。");
    if (mode === "export") return `Neovim手動受渡し: ${file}\nBundled plugin root: ${pluginRoot}\n:lua require('pi_understanding').open(${JSON.stringify(file)})\n固定file全体とAI注釈のみ。会話なし・同期なし。不要になったらこのprivate directoryを手動削除してください。`;
    if (server) {
      const result = await exec(binary, ["--server", server, "--remote-expr", serverExpression(file)], { timeout: 10_000, maxBuffer: 16_000 });
      if (!/^\d+\s*$/.test(result.stdout) || Number(result.stdout) < 1) throw new Error(`Neovim server did not open evidence: ${result.stderr || result.stdout}`);
    } else if (!argv) {
      await inPlace!(binary, neovimLaunchArgs(), { ...process.env, PI_UNDERSTANDING_NVIM_PLUGIN: pluginRoot, PI_UNDERSTANDING_NVIM_HANDOFF: file });
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(argv![0]!, [...argv!.slice(1), binary, ...neovimLaunchArgs()], {
          detached: true, stdio: "ignore", env: { ...process.env, PI_UNDERSTANDING_NVIM_PLUGIN: pluginRoot, PI_UNDERSTANDING_NVIM_HANDOFF: file },
        });
        child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
      });
    }
    return `Neovimへ固定根拠を受渡しました: ${file}\n${data.identity.ref}:${data.identity.path}:${data.evidence.start}-${data.evidence.end} sha256=${data.identity.digest}\n同期なし。不要になったらこのprivate directoryを手動削除してください。`;
  } catch (error) { await rm(path.dirname(file), { recursive: true, force: true }); throw new Error(`Neovim handoff failed: ${String(error)}`); }
}
