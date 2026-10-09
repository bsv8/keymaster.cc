// Joint smoke resource: build the actual Go programs, use real PostgreSQL and
// testnet WOC, and put a loopback TLS/CORS proxy in front of the unchanged server.
// No root, quote, transaction observation or index row is synthesized here.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promises as fs, existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { verifyForumRoot } from "../../../../packages/plugin-forum/src/domain/rootTrust.js";
import { calcTxidFromRawTxHex } from "../../../../packages/plugin-p2pkh/src/p2pkhSigner.js";
import type { OneTimeWallet } from "../testnet/fundingResource.js";
const exec = promisify(execFile);

export class ForumTestnetApi {
  private nextRequestAt = 0;
  constructor(readonly base: string, private readonly authorization?: string) {}
  async request(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(`${this.base.replace(/\/$/u, "")}/test${path}`);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Forum smoke requires HTTPS testnet chain API");
    for (let attempt=0; attempt<4; attempt++) {
      const delay=Math.max(0,this.nextRequestAt-Date.now());
      this.nextRequestAt=Math.max(this.nextRequestAt,Date.now())+1000;
      if(delay) await new Promise(resolveWait=>setTimeout(resolveWait,delay));
      const response=await fetch(url, { ...init, headers: { ...(this.authorization ? { authorization: this.authorization } : {}), ...init?.headers }, signal: AbortSignal.timeout(25_000) });
      if(response.status!==429 || init?.method==="POST" || attempt===3) return response;
      await response.body?.cancel();
      await new Promise(resolveWait=>setTimeout(resolveWait,5000));
    }
    throw new Error("Forum chain read retry exhausted");
  }
  async json(path: string): Promise<any> {
    const response = await this.request(path);
    if (!response.ok) throw new Error(`Forum testnet API ${path}: HTTP ${response.status}`);
    return response.json();
  }
  async raw(txid: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/u.test(txid)) throw new Error("Invalid chain txid");
    const response = await this.request(`/tx/${txid}/hex`);
    if (!response.ok) throw new Error(`Forum raw unavailable: HTTP ${response.status}`);
    const raw = (await response.text()).trim().replace(/^"|"$/gu, "");
    if (calcTxidFromRawTxHex(raw) !== txid) throw new Error("Forum raw txid mismatch");
    return raw;
  }
  async waitRaw(txid: string): Promise<string> {
    const deadline=Date.now()+120_000;
    while(Date.now()<deadline) {
      try{return await this.raw(txid)}catch {await new Promise(resolveWait=>setTimeout(resolveWait,5000))}
    }
    throw new Error(`Forum raw is not yet readable for ${txid}; retain the original transaction`);
  }
  async broadcast(raw: string): Promise<string> {
    const txid = calcTxidFromRawTxHex(raw);
    // Persist/announce the canonical ID before dispatch; unknown responses never
    // cause a second genesis to be constructed or a second payment to be made.
    console.log(`[forum-smoke] dispatch txid=${txid}`);
    try {
      const response = await this.request("/tx/raw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txhex: raw }) });
      if (!response.ok) throw new Error(`Forum broadcast HTTP ${response.status}`);
    } catch {
      await this.wait(txid, false, 120_000);
    }
    return txid;
  }
  async wait(txid: string, confirmed: boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const row = await this.json(`/tx/hash/${txid}`);
        if (!confirmed || row.confirmations > 0 || row.blockheight > 0) return;
      } catch { /* WOC discovery is asynchronous; retry the same ID only. */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 5_000));
    }
    throw new Error(`Forum ${confirmed ? "confirmation" : "observation"} timeout for ${txid}; resume with the same transaction`);
  }
  async waitFunding(publicKeyHex: string, minimumSatoshis: number): Promise<void> {
    const hash160 = createHash("ripemd160").update(createHash("sha256").update(Buffer.from(publicKeyHex,"hex")).digest()).digest("hex");
    const scriptHash = Buffer.from(createHash("sha256").update(Buffer.from(`76a914${hash160}88ac`,"hex")).digest()).reverse().toString("hex");
    const deadline = Date.now()+120_000;
    while (Date.now()<deadline) {
      for (const kind of ["unconfirmed","confirmed"]) {
        try {
          const row = await this.json(`/script/${scriptHash}/${kind}/unspent`);
          if (!row.error) for (const output of row.result ?? []) {
            if (output.value < minimumSatoshis || output.isSpentInMempoolTx) continue;
            // The transaction-detail, UTXO and raw indexes become ready at
            // different times. Go verifies real prevouts, so raw must be ready too.
            try { await this.raw(output.tx_hash); return; } catch { /* retain same funding */ }
          }
        } catch { /* transaction detail and script indexes become visible separately */ }
      }
      await new Promise(resolveWait=>setTimeout(resolveWait,5_000));
    }
    throw new Error("Forum funding UTXO is not yet visible; keep the original funding transaction");
  }
  async findRoot(publicKeyHex: string): Promise<string | undefined> {
    const configured = process.env.FORUM_E2E_ROOT_TXID;
    const cachePath = process.env.FORUM_E2E_ROOT_STATE;
    if (configured) return configured;
    if (cachePath) {
      try { const row = JSON.parse(await fs.readFile(cachePath, "utf8")); if (row.publicKeyHex === publicKeyHex) return row.txid; } catch { /* no previous fixture */ }
    }
    const script = Buffer.from(`21${publicKeyHex}ac`, "hex");
    const hash = Buffer.from(createHash("sha256").update(script).digest()).reverse().toString("hex");
    for (const kind of ["confirmed", "unconfirmed"]) {
      let token: string | undefined;
      const seen = new Set<string>();
      do {
        const query = new URLSearchParams({ limit: "1000", order: "asc", ...(token ? { token } : {}) });
        const response = await this.request(`/script/${hash}/${kind}/history?${query}`);
        if (response.status === 404) break;
        if (!response.ok) throw new Error(`Forum root history HTTP ${response.status}`);
        const history = await response.json();
        if (history.error) throw new Error("Forum root history reported an error");
        for (const row of history.result ?? []) {
          const txid = row.tx_hash;
          try { this.verifyRoot(await this.raw(txid), txid, publicKeyHex); return txid; } catch { /* another declaration/payment */ }
        }
        token = history.nextPageToken;
        if (token && seen.has(token)) throw new Error("Forum root history repeats its pagination token");
        if (token) seen.add(token);
      } while (token);
    }
    return undefined;
  }
  verifyRoot(raw: string, txid: string, publicKeyHex: string) {
    return verifyForumRoot({ config: { id: "smoke", label: "smoke", network: "test", forumTxid: txid, forumPublicKeyHex: publicKeyHex, endpoints: [] }, rawTxBytes: Buffer.from(raw, "hex"), nowMs: Date.now() });
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close(() => resolvePort(port)); });
  });
}
function keyringFrame(privateKeyHex: string): Buffer {
  const name = Buffer.from("FORUM_PRIVATE_KEY"); const value = Buffer.from(privateKeyHex);
  const cbor = Buffer.concat([Buffer.from([0xa1, 0x60 + name.length]), name, Buffer.from([0x78, value.length]), value]);
  const header = Buffer.alloc(9); header.write("8SEC"); header[4] = 2; header.writeUInt32BE(cbor.length, 5);
  return Buffer.concat([header, cbor]);
}
async function keyedCommand(binary: string, args: string[], privateKeyHex: string): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout?.on("data", data => { output += String(data); });
    child.stderr?.on("data", data => { errors = (errors + String(data)).slice(-8000); });
    const frame = keyringFrame(privateKeyHex); (child.stdio[3] as NodeJS.WritableStream).end(frame, () => frame.fill(0));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timer); if (code === 0) resolveCommand(output); else reject(new Error(`Go Forum command failed (${code}): ${errors.replaceAll(privateKeyHex, "[secret]")}`)); });
  });
}

export async function buildForumPrograms() {
  const source = resolve(process.env.BSV8_FORUM_DIR ?? "");
  if (!process.env.BSV8_FORUM_DIR || !existsSync(join(source, "cmd/forum-indexer/main.go"))) throw new Error("Set BSV8_FORUM_DIR to the real Forum repository");
  const directory = await fs.mkdtemp(join(tmpdir(), "keymaster-forum-smoke-"));
  const go = process.env.FORUM_E2E_GO ?? "go";
  try {
    for (const command of ["forum-genesis", "forum-indexer"]) await exec(go, ["build", "-buildvcs=false", "-o", join(directory, command), `./cmd/${command}`], { cwd: source, env: { ...process.env, GOWORK: "off" }, timeout: 600_000 });
    return { directory, async genesis(wallet: OneTimeWallet, api: ForumTestnetApi) {
      const output = await keyedCommand(join(directory, "forum-genesis"), ["-forum_publickey", wallet.publicKeyHex, "-forum_name", "Keymaster Forum smoke", "-tip_price", "0", "-network", "test", "-fee_rate", "0.001", "-woc_base_url", api.base.replace(/\/v1\/bsv\/?$/u, "")], wallet.privateKey.read());
      const [root, collection, ...extra] = output.trim().split(/\r?\n/u);
      if (!root || !collection || extra.length || !/^[a-f0-9]+$/u.test(root + collection)) throw new Error("Go genesis did not return exactly two raw transactions");
      api.verifyRoot(root, calcTxidFromRawTxHex(root), wallet.publicKeyHex);
      return { root, collection };
    }, async dispose() { await fs.rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

export async function startForumServer(input: { programs: Awaited<ReturnType<typeof buildForumPrograms>>; wallet: OneTimeWallet; root: string; api: ForumTestnetApi }) {
  const directory = input.programs.directory;
  const pg = process.env.FORUM_E2E_PG_BIN;
  if (!pg || !existsSync(join(pg, "postgres"))) throw new Error("Set FORUM_E2E_PG_BIN to a complete PostgreSQL server installation");
  const data = join(directory, "pgdata"), sockets = join(directory, "sockets");
  await fs.mkdir(sockets);
  const databasePort = await freePort(), httpPort = await freePort(), tlsPort = await freePort();
  let started = false, child: ChildProcess | undefined;
  let proxy: ReturnType<typeof createHttpsServer> | undefined;
  const logs: string[] = [];
  const stop = async () => {
    if (proxy) await new Promise<void>(resolveClose => { proxy!.close(() => resolveClose()); proxy!.closeAllConnections(); });
    if (child && child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise(resolveExit => child!.once("exit", resolveExit)), new Promise(resolveExit => setTimeout(resolveExit, 3000))]); if (child.exitCode === null) child.kill("SIGKILL"); }
    if (started) await exec(join(pg, "pg_ctl"), ["-D", data, "stop", "-m", "immediate"], { timeout: 30_000 }).catch(() => undefined);
  };
  try {
    await exec(join(pg, "initdb"), ["-D", data, "-A", "trust", "-U", "forum_smoke"], { timeout: 120_000 });
    await exec(join(pg, "pg_ctl"), ["-D", data, "-l", join(directory, "postgres.log"), "-o", `-p ${databasePort} -k ${sockets} -c listen_addresses=127.0.0.1`, "start"], { timeout: 60_000 }); started = true;
    await exec(join(pg, "createdb"), ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "forum_smoke", "forum_smoke"]);
    const config = {
      format_version: 1, network: "testnet", genesis_txid: input.root, forum_publickey: input.wallet.publicKeyHex, current_payment_publickey: input.wallet.publicKeyHex, historical_payment_publickeys: [],
      price_tiers: [{ start_height: "0", index_price: "1" }], price_schedule_version: "1", quote_validity_blocks: "6",
      scanner: { poll_interval_ms: 5000, max_unconfirmed_history: 1000 }, woc: { base_url: input.api.base.replace(/\/v1\/bsv\/?$/u, ""), requests_per_second: 1, max_retries: 3, timeout_ms: 20000 },
      server: { http_listen: `127.0.0.1:${httpPort}`, libp2p_listen: "" }, database_url: `postgres://forum_smoke@127.0.0.1:${databasePort}/forum_smoke?sslmode=disable`, max_database_connections: 8, keyring: { fd: 3, secret_name: "FORUM_PRIVATE_KEY" },
    };
    const configPath = join(directory, "forum.json"); await fs.writeFile(configPath, JSON.stringify(config));
    child = spawn(join(directory, "forum-indexer"), ["-config", configPath], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { logs.push(String(chunk)); if (logs.length > 100) logs.shift(); });
    const frame = keyringFrame(input.wallet.privateKey.read()); (child.stdio[3] as NodeJS.WritableStream).end(frame, () => frame.fill(0));
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-keyout", join(directory, "tls.key"), "-out", join(directory, "tls.crt")]);
    proxy = createHttpsServer({ key: await fs.readFile(join(directory, "tls.key")), cert: await fs.readFile(join(directory, "tls.crt")) }, (request, response) => {
      const ingress = `[tls-entry] ${request.method} ${request.url} origin=${request.headers.origin ?? "none"}`;
      logs.push(ingress + "\n"); console.log(ingress);
      response.setHeader("access-control-allow-origin", "http://127.0.0.1:4173"); response.setHeader("access-control-allow-headers", "content-type,accept"); response.setHeader("access-control-allow-methods", "POST,GET,OPTIONS");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      const upstream = httpRequest({ hostname: "127.0.0.1", port: httpPort, path: request.url, method: request.method, headers: request.headers }, remote => { response.writeHead(remote.statusCode ?? 502, remote.headers); remote.pipe(response); });
      upstream.on("error", () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
    });
    await new Promise<void>(resolveListen => proxy!.listen(tlsPort, "127.0.0.1", resolveListen));
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Go Forum startup failed: ${logs.join("").replaceAll(input.wallet.privateKey.read(), "[secret]")}`);
      try { if ((await fetch(`http://127.0.0.1:${httpPort}/readyz`)).ok) return { url: `https://127.0.0.1:${tlsPort}`, stop, logs: () => logs.join(""),
        async waitIndexed(txid: string) {
          if (!/^[a-f0-9]{64}$/u.test(txid)) throw new Error("Invalid public index txid");
          const deadline = Date.now() + 240_000;
          while (Date.now() < deadline) {
            const result = await exec(join(pg, "psql"), ["-h", "127.0.0.1", "-p", String(databasePort), "-U", "forum_smoke", "-d", "forum_smoke", "-At", "-c", `SELECT status FROM nodes WHERE txid = decode('${txid}','hex') AND status IN ('mempool','confirmed')`], { timeout: 15_000 });
            const status = result.stdout.trim();
            if (status) return status;
            if (child?.exitCode !== null) throw new Error("Forum indexer stopped before discovering the post");
            await new Promise(resolveWait => setTimeout(resolveWait, 5_000));
          }
          throw new Error("Forum did not discover the broadcast transaction in 240 seconds");
        }
      }; } catch { /* starting */ }
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    }
    throw new Error(`Go Forum readiness timeout: ${logs.join("").replaceAll(input.wallet.privateKey.read(), "[secret]")}`);
  } catch (error) { await stop(); throw error; }
}
