import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagramPreview } from "../src/preview.ts";
import { get } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function request(port: number, route: string, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path: route, method, agent: false }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", data => { body += data; });
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }); req.on("error", reject);
  });
}
test("preview binds loopback and serves only its generated random route, stops owned registration/server", async () => {
  const calls: string[][] = []; let port = 0;
  const preview = new DiagramPreview(async args => { calls.push(args); if (args[0] === "add") port = Number(args[2]); return args[0] === "url" ? "https://host.tailnet.ts.net:8443/" : ""; });
  try {
    const url = new URL((await preview.start("<html>private generated document</html>"))!);
    assert.match(url.pathname, /^\/document-[a-f0-9]{48}\.html$/);
    const result = await request(port, url.pathname);
    assert.equal(result.status, 200); assert.equal(result.body, "<html>private generated document</html>"); assert.equal(result.headers["cache-control"], "no-store");
    assert.match(String(result.headers["content-security-policy"]), /script-src 'none'/);
    assert.equal((await request(port, url.pathname, "HEAD")).body, "");
    assert.equal((await request(port, url.pathname, "POST")).status, 405);
    for (const route of ["/", "/map.html", "/../README.md", url.pathname + "?x=1", "/favicon.ico"]) assert.equal((await request(port, route)).status, 404);
    // Directly inspect the concrete listen address, not merely a mocked argv.
    assert.equal((preview as unknown as { resource: { server: { address: () => { address: string } } } }).resource.server.address().address, "127.0.0.1");
    await preview.stop(); await assert.rejects(() => request(port, url.pathname), /ECONNREFUSED/);
    assert.equal(calls.filter(a => a[0] === "remove").length, 1); assert.equal(calls.at(-1)![1], calls[0]![1]);
    await preview.stop(); assert.equal(calls.filter(a => a[0] === "remove").length, 1);
  } finally { await preview.stop(); }
});
test("start failures disclose home-preview/HTTPS/operator errors and cleanup only owned name; failed cleanup is retryable", async () => {
  for (const failure of ["ENOENT home-preview missing", "HTTPS certificates disabled", "Tailscale operator permission denied", "invalid URL"]) {
    const calls: string[][] = []; let port = 0;
    const preview = new DiagramPreview(async args => {
      calls.push(args); if (args[0] === "add") { port = Number(args[2]); if (failure !== "invalid URL") throw new Error(failure); }
      return args[0] === "url" ? "http://unsafe.invalid" : "";
    });
    await assert.rejects(() => preview.start("private"), failure === "invalid URL" ? /invalid HTTPS URL/ : new RegExp(failure));
    await assert.rejects(() => request(port, "/"), /ECONNREFUSED/);
    assert.equal(calls.at(-1)![0], "remove"); assert.equal(calls.at(-1)![1], calls[0]![1]);
    await preview.stop();
  }
  let failRemove = true; const calls: string[][] = [];
  const preview = new DiagramPreview(async args => { calls.push(args); if (args[0] === "remove" && failRemove) throw new Error("operator denied cleanup"); return args[0] === "url" ? "https://host.ts.net:8443/" : ""; });
  await preview.start("private");
  await assert.rejects(() => preview.stop(), /registration .* cleanup failed.*Retry/);
  failRemove = false; await preview.stop();
  const removes = calls.filter(a => a[0] === "remove"); assert.equal(removes.length, 2); assert.equal(removes[0]![1], removes[1]![1]);
});
test("real helper transport recovers from missing binary and a registration rejected before creation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "understanding-helper-"));
  const previousPath = process.env.PATH;
  const preview = new DiagramPreview();
  // PATH contains only our fake helper directory: real home-preview/Tailscale cannot be invoked.
  process.env.PATH = directory;
  try {
    await assert.rejects(() => preview.start("private"), /ENOENT/);
    await preview.stop();
    const helper = path.join(directory, "home-preview");
    const portFile = path.join(directory, "port");
    const prefix = `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === 'add') fs.writeFileSync(${JSON.stringify(portFile)}, process.argv[4]);\n`;
    await writeFile(helper, prefix + "if (process.argv[2] === 'remove') { process.stderr.write(\"home-preview: preview '\" + process.argv[3] + \"' does not exist\\n\"); process.exit(1); }\nprocess.stderr.write('home-preview: HTTPS certificates disabled\\n'); process.exit(1);\n", { mode: 0o700 });
    await assert.rejects(() => preview.start("private"), /HTTPS certificates disabled/);
    const failedPort = Number(await readFile(portFile, "utf8"));
    await assert.rejects(() => request(failedPort, "/"), /ECONNREFUSED/);
    await preview.stop();
    await writeFile(helper, prefix + "if (process.argv[2] === 'url') console.log('https://host.ts.net:8443/');\n", { mode: 0o700 });
    const url = new URL((await preview.start("recovered"))!);
    assert.equal((await request(Number(await readFile(portFile, "utf8")), url.pathname)).body, "recovered");
    await preview.stop();
  } finally {
    try { await preview.stop(); }
    finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(directory, { recursive: true, force: true }); }
  }
});

test("stop invalidates in-flight add; serialized replacement never returns stale URLs or leaks a server", async () => {
  let unblock!: () => void; let started!: () => void;
  const added = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const calls: string[][] = []; let first = true;
  const preview = new DiagramPreview(async args => { calls.push(args); if (args[0] === "add" && first) { first = false; started(); await gate; } return args[0] === "url" ? "https://host.ts.net:8443/" : ""; });
  const stale = preview.start("old"); await added;
  const stop = preview.stop(); const latest = preview.start("new"); unblock();
  assert.equal(await stale, undefined); await stop;
  const url = new URL((await latest)!); const additions = calls.filter(a => a[0] === "add");
  assert.equal((await request(Number(additions[1]![2]), url.pathname)).body, "new");
  assert.equal(calls.filter(a => a[0] === "url").length, 1);
  await preview.stop(); assert.equal(calls.filter(a => a[0] === "remove").length, 2);
});
