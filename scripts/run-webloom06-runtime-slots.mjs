// 真实浏览器/两个 SharedWorker/两个页面门禁；隔离构建不添加生产测试入口。
import { build } from "vite";
import { chromium } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const outDir = await mkdtemp(join(tmpdir(), "keymaster-webloom06-slots-"));
let server, browser;
try {
  await build({ configFile: false, root: resolve("e2e/integration/fixtures/webloom06-slots"),
    resolve: { dedupe: ["react", "react-dom"], alias: [
      { find: /^@keymaster\/runtime$/, replacement: resolve("packages/runtime/src/index.ts") },
      { find: /^@keymaster\/contracts$/, replacement: resolve("packages/contracts/src/index.ts") },
    ] }, build: { outDir, emptyOutDir: true, target: "esnext" }, worker: { format: "es" }, logLevel: "warn" });
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const file = resolve(outDir, pathname === "/" ? "index.html" : pathname.slice(1));
      if (!file.startsWith(outDir + "/")) throw new Error("Invalid path");
      response.setHeader("Content-Type", extname(file) === ".html" ? "text/html" : "application/javascript");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const errors = [];
  const first = await context.newPage(), second = await context.newPage();
  for (const page of [first, second]) page.on("pageerror", error => errors.push(error.message));
  const url = `http://127.0.0.1:${server.address().port}/`;
  for (const [page, target] of [[first, url], [second, url + "?reverse=1"]]) {
    await page.goto(target); await page.waitForFunction(() => window.slotGate);
  }
  const one = await first.evaluate(() => window.slotGate.snapshot());
  const two = await second.evaluate(() => window.slotGate.snapshot());
  assert.equal(one.first, "a"); assert.equal(one.second, "b");
  assert.equal(one.aInstance, two.aInstance); assert.equal(one.bInstance, two.bInstance);
  assert.notEqual(one.aInstance, one.bInstance); assert.notEqual(one.aConnection, two.aConnection);
  const replacement = await first.evaluate(() => window.slotGate.replaceA());
  assert.equal(replacement.value, "a"); assert.equal(replacement.oldRejected, true); assert.equal(replacement.otherSurvived, true);
  assert.notEqual(replacement.oldConnection, replacement.newConnection);
  assert.equal((await second.evaluate(() => window.slotGate.snapshot())).first, "a");
  const detached = await first.evaluate(() => window.slotGate.detachB());
  assert.deepEqual(detached, { blocked: true, oldRejected: true, first: "a" });
  assert.equal((await second.evaluate(() => window.slotGate.snapshot())).second, "b");
  const restored = await first.evaluate(() => window.slotGate.restoreB());
  assert.deepEqual(restored, { value: "b", oldRejected: true, otherSurvived: true });
  await first.evaluate(() => window.slotGate.close());
  await first.close();
  assert.equal((await second.evaluate(() => window.slotGate.snapshot())).first, "a");
  await second.evaluate(() => window.slotGate.close());
  assert.deepEqual(errors, []);
  console.log("WebLoom 0.6 Runtime slots passed: two actual Workers, two pages, explicit sources, replacement fencing, stale unmount, isolated detach and reconnect.");
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(outDir, { recursive: true, force: true });
}
