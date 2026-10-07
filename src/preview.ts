import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type PreviewCommand = (args: string[]) => Promise<string>;
class PreviewCommandError extends Error {
  readonly state: "not-started" | "registration-absent" | "unknown";
  constructor(message: string, state: "not-started" | "registration-absent" | "unknown") { super(message); this.state = state; }
}
const command: PreviewCommand = async args => {
  try { return (await promisify(execFile)("home-preview", args, { timeout: 15_000, maxBuffer: 64_000 })).stdout.trim(); }
  catch (error) {
    const failure = error as { code?: unknown; stderr?: string };
    // Only the installed helper's exact, name-bound missing-registration response proves cleanup unnecessary.
    const absent = args[0] === "remove" && failure.code === 1 && failure.stderr?.trim() === `home-preview: preview '${args[1]}' does not exist`;
    const state = failure.code === "ENOENT" ? "not-started" : absent ? "registration-absent" : "unknown";
    throw new PreviewCommandError(`home-preview ${args[0]} failed (installed helper / HTTPS certificates / Tailscale operator permission required): ${String(error)}`, state);
  }
};
type Resource = { server: Server; name: string; registered: boolean; port: number; route: string };
/** Owns one generated document, not a filesystem server. Operations serialize, while stop invalidates immediately. */
export class DiagramPreview {
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private resource?: Resource;
  private run: PreviewCommand;
  constructor(run: PreviewCommand = command) { this.run = run; }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work); this.queue = task.catch(() => {}); return task;
  }
  private async clean(): Promise<void> {
    const resource = this.resource;
    if (!resource) return;
    // Always stop serving private source even if external registration cleanup fails.
    if (resource.server.listening) {
      resource.server.closeAllConnections();
      await new Promise<void>((resolve, reject) => resource.server.close(error => error ? reject(error) : resolve()));
    }
    if (resource.registered) {
      try { await this.run(["remove", resource.name]); resource.registered = false; }
      catch (error) {
        if (error instanceof PreviewCommandError && error.state === "registration-absent") resource.registered = false;
        else throw new Error(`Preview server stopped, but owned registration ${resource.name} cleanup failed. Retry /understand diagram stop. ${String(error)}`);
      }
    }
    if (this.resource === resource) this.resource = undefined;
  }
  stop(): Promise<void> { this.epoch++; return this.enqueue(() => this.clean()); }
  start(html: string): Promise<string | undefined> {
    const epoch = ++this.epoch;
    return this.enqueue(async () => {
      await this.clean();
      if (epoch !== this.epoch) return undefined;
      const name = `pi-understanding-${randomBytes(12).toString("hex")}`;
      const route = `/document-${randomBytes(24).toString("hex")}.html`;
      const body = Buffer.from(html);
      const server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        if (req.url !== route) { res.writeHead(404); res.end(); return; }
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length });
        res.end(req.method === "HEAD" ? undefined : body);
      });
      server.requestTimeout = 10_000; server.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); throw new Error("Missing preview loopback address"); }
      const resource: Resource = { server, name, route, port: address.port, registered: false };
      this.resource = resource;
      let added = false;
      try {
        // add can commit a registration before reporting a Serve failure: own cleanup from the attempt onward.
        resource.registered = true;
        await this.run(["add", name, String(resource.port)]); added = true;
        if (epoch !== this.epoch) { await this.clean(); return undefined; }
        const url = (await this.run(["url", name])).trim();
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("home-preview returned an invalid HTTPS URL");
        if (epoch !== this.epoch) { await this.clean(); return undefined; }
        return new URL(route, parsed).href;
      } catch (error) {
        // ENOENT proves that add never ran; url/other failures still require registration cleanup.
        if (error instanceof PreviewCommandError && error.state === "not-started" && !added) resource.registered = false;
        try { await this.clean(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], `${String(error)}\n${String(cleanupError)}`); }
        throw error;
      }
    });
  }
}
