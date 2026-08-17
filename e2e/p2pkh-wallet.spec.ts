import { createServer } from "node:http";
import { expect, test } from "@playwright/test";

test("P2PKH wallet exposes the unified views and redirects legacy coin routes", async ({ page }) => {
  // Keep this browser smoke deterministic and offline. Provider adapter and
  // Coordinator behavior are covered by the unit/integration suites; this
  // test verifies the assembled production shell and route contract.
  await page.route("https://api.whatsonchain.com/**", (route) => route.abort());
  await page.route("https://junglebus.gorillapool.io/**", (route) => route.abort());

  await page.goto("/");
  await page.getByRole("button", { name: "New wallet" }).click();
  await page.getByLabel("New password").fill("playwright-password");
  await page.getByLabel("Confirm password").fill("playwright-password");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("button", { name: "Lock" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "P2PKH", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "BSV Wallet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Transactions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Coins" })).toBeVisible();

  await page.goto("/p2pkh/utxos");
  await page.getByLabel("Password").fill("playwright-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(/\/p2pkh\?tab=coins$/);
  await expect(page.getByRole("button", { name: "Coins" })).toBeVisible();
});

test("fake provider switch reconciles a local change chain after reorg", async ({ page }) => {
  test.setTimeout(60_000);
  // Both provider adapters are exercised through their browser-facing network
  // paths. The fixture deliberately returns an empty confirmed history after
  // the provider switch, which drives the sync layer's double-check/reorg
  // convergence path without depending on public-chain state.
  await page.route("https://api.whatsonchain.com/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ result: [] }) }));
  await page.route("https://junglebus.gorillapool.io/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }));
  await page.route("https://testnet.junglebus.gorillapool.io/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }));

  await page.goto("/");
  await page.getByRole("button", { name: "New wallet" }).click();
  await page.getByLabel("New password").fill("playwright-password");
  await page.getByLabel("Confirm password").fill("playwright-password");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("button", { name: "Lock" })).toBeVisible({ timeout: 15_000 });

  await page.goto("/p2pkh/settings");
  await expect(page.getByLabel("Password")).toBeVisible();
  await page.getByLabel("Password").fill("playwright-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();
  const confirmedProvider = page.getByLabel("Confirmed provider").first();
  await expect(confirmedProvider).toHaveValue("woc");
  await confirmedProvider.selectOption("junglebus");
  await expect(confirmedProvider).toHaveValue("junglebus");

  const fixture = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const name = databases.map((entry) => entry.name).find((value): value is string => Boolean(value && value.includes(".plugin.p2pkh.state")));
    if (!name) throw new Error("P2PKH namespace database was not created");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const address = await new Promise<{ resourceId: string; publicKeyHex: string; address: string; network: "main" | "test"; generation: number } | undefined>((resolve, reject) => {
      const request = db.transaction("p2pkh_addresses", "readonly").objectStore("p2pkh_addresses").getAll();
      request.onsuccess = () => resolve((request.result as Array<{ resourceId: string; publicKeyHex: string; address: string; network: "main" | "test"; generation: number }>)[0]);
      request.onerror = () => reject(request.error);
    });
    if (!address) throw new Error("P2PKH resource is not ready");
    const chainTxid = "aa".repeat(32);
    const parentTxid = "bb".repeat(32);
    const changeTxid = "cc".repeat(32);
    const now = new Date().toISOString();
    const fact = { id: `${address.resourceId}:${chainTxid}`, resourceId: address.resourceId, publicKeyHex: address.publicKeyHex, network: address.network, address: address.address, txid: chainTxid, rawTxHex: "", blockHeight: 100, inputOutpointKeys: [`${parentTxid}:0`], inputs: [{ txid: parentTxid, vout: 0, outpointKey: `${parentTxid}:0` }], ownedOutpointKeys: [`${chainTxid}:0`], ownedOutputs: [{ vout: 0, value: 900, scriptHex: "" }], firstConfirmedAt: now, lastConfirmedAt: now };
    const root = { id: "e2e-local-root", resourceId: address.resourceId, publicKeyHex: address.publicKeyHex, network: address.network, txid: chainTxid, rawTxHex: "", state: "chain-confirmed", chainConfirmationPreviousState: "isolated", isolationReason: "fake-reorg", inputOutpointKeys: [`${parentTxid}:0`], ownOutputs: [{ vout: 0, value: 900, scriptHex: "" }], parentTxids: [], createdAt: now, updatedAt: now, attempts: [] };
    const change = { id: "e2e-local-change", resourceId: address.resourceId, publicKeyHex: address.publicKeyHex, network: address.network, txid: changeTxid, rawTxHex: "", state: "local-confirmed", inputOutpointKeys: [`${chainTxid}:0`], ownOutputs: [{ vout: 0, value: 800, scriptHex: "" }], parentTxids: [chainTxid], createdAt: now, updatedAt: now, attempts: [] };
    const changeOutpoint = { id: `${address.resourceId}:${changeTxid}:0`, resourceId: address.resourceId, txid: changeTxid, vout: 0, value: 800, scriptHex: "", submissionId: change.id, state: "available", createdAt: now, updatedAt: now };
    const changeClaim = { id: `${address.resourceId}:${chainTxid}:0`, submissionId: change.id, resourceId: address.resourceId, publicKeyHex: address.publicKeyHex, network: address.network, txid: chainTxid, vout: 0, outpointKey: `${chainTxid}:0`, value: 900, state: "active", createdAt: now, updatedAt: now };
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["p2pkh_transactions", "p2pkh_local_transactions", "p2pkh_local_outpoints", "p2pkh_local_input_claims"], "readwrite");
      transaction.objectStore("p2pkh_transactions").put(fact);
      transaction.objectStore("p2pkh_local_transactions").put(root);
      transaction.objectStore("p2pkh_local_transactions").put(change);
      transaction.objectStore("p2pkh_local_outpoints").put(changeOutpoint);
      transaction.objectStore("p2pkh_local_input_claims").put(changeClaim);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return { chainTxid, changeTxid };
  });

  // A second switch after seeding deliberately re-runs the Coordinator task;
  // this is the browser-level trigger for the fake provider's empty-history
  // reorg reconciliation.
  await confirmedProvider.selectOption("woc");
  await expect(confirmedProvider).toHaveValue("woc");
  await confirmedProvider.selectOption("junglebus");
  await expect(confirmedProvider).toHaveValue("junglebus");
  await expect.poll(async () => page.evaluate(async ({ chainTxid }) => {
    const name = (await indexedDB.databases()).map((entry) => entry.name).find((value): value is string => Boolean(value && value.includes(".plugin.p2pkh.state")));
    if (!name) return "missing";
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return await new Promise<{ state?: string; restored?: boolean }>((resolve, reject) => {
      const transaction = db.transaction(["p2pkh_local_transactions", "p2pkh_local_outpoints"], "readonly");
      const local = transaction.objectStore("p2pkh_local_transactions").get("e2e-local-root");
      const outpoints = transaction.objectStore("p2pkh_local_outpoints").getAll();
      transaction.oncomplete = () => resolve({ state: (local.result as { state?: string } | undefined)?.state, restored: (outpoints.result as Array<{ txid: string }>).some((row) => row.txid === chainTxid) });
      transaction.onerror = () => reject(transaction.error);
    });
  }, { chainTxid: fixture.chainTxid }), { timeout: 15_000 }).toEqual({ state: "isolated", restored: true });

  await page.getByRole("button", { name: "P2PKH", exact: true }).first().click();
  await page.getByRole("button", { name: "Coins" }).click();
  await expect(page.getByText(`${fixture.chainTxid}:0`, { exact: true })).toBeVisible();
  await expect(page.getByText(fixture.changeTxid, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Transactions" }).click();
  await expect(page.getByRole("button", { name: /Rebroadcast ancestors|重广播/ }).first()).toBeVisible();
});

test("real transfer UI spends the first local change and isolates a failed broadcast", async ({ page }) => {
  test.setTimeout(90_000);
  let fakeWocBroadcasts = 0;
  let confirmedTxid: string | undefined;
  let confirmedRawTxHex: string | undefined;
  const fakeWoc = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url?.includes("/tx/raw")) {
      fakeWocBroadcasts += 1;
      if (fakeWocBroadcasts === 2) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "fake WOC outage" }));
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      }
      return;
    }
    if (request.url?.includes("/confirmed/history")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ result: confirmedTxid ? [{ tx_hash: confirmedTxid, height: 1 }] : [] }));
      return;
    }
    if (request.url?.includes("/tx/hash/") && request.url?.endsWith("/hex")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ hex: confirmedRawTxHex ?? "" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ result: [] }));
  });
  await new Promise<void>((resolve, reject) => { fakeWoc.once("error", reject); fakeWoc.listen(0, "127.0.0.1", () => resolve()); });
  fakeWoc.unref();
  const fakeWocAddress = fakeWoc.address();
  if (!fakeWocAddress || typeof fakeWocAddress === "string") throw new Error("Fake WOC server did not bind");
  const fakeWocBaseUrl = `http://127.0.0.1:${fakeWocAddress.port}/v1/bsv`;
  await page.goto("/");
  await page.evaluate((endpoint) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("keymaster.session-coordinator", 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("meta")) request.result.createObjectStore("meta", { keyPath: "id" }); };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("meta", "readwrite");
      transaction.objectStore("meta").put({ id: "singleton", generation: 0, p2pkhProviderConfigs: { woc: { endpoint, requestsPerSecond: 1000 } } });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
    request.onerror = () => reject(request.error);
  }), fakeWocBaseUrl);
  await page.goto("about:blank");
  await page.context().route("https://junglebus.gorillapool.io/**", (route) => route.abort());
  await page.context().route("https://testnet.junglebus.gorillapool.io/**", (route) => route.abort());

  await page.goto("/");
  await page.getByRole("button", { name: "New wallet" }).click();
  await page.getByLabel("New password").fill("playwright-password");
  await page.getByLabel("Confirm password").fill("playwright-password");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("button", { name: "Lock" })).toBeVisible({ timeout: 15_000 });

  await page.goto("/p2pkh/settings");
  await page.getByLabel("Password").fill("playwright-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();
  const fixture = await page.evaluate(async () => {
    const entries = await indexedDB.databases();
    const name = entries.map((entry) => entry.name).find((value): value is string => Boolean(value && value.includes(".plugin.p2pkh.state")));
    if (!name) throw new Error("P2PKH namespace database was not created");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const address = await new Promise<{ resourceId: string; address: string; publicKeyHex: string; network: "main" } | undefined>((resolve, reject) => {
      const request = db.transaction("p2pkh_addresses", "readonly").objectStore("p2pkh_addresses").getAll();
      request.onsuccess = () => resolve((request.result as Array<{ resourceId: string; address: string; publicKeyHex: string; network: "main" }>).find((row) => row.network === "main"));
      request.onerror = () => reject(request.error);
    });
    if (!address) throw new Error("Mainnet P2PKH resource is not ready");
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let value = 0n;
    for (const character of address.address) {
      const digit = alphabet.indexOf(character);
      if (digit < 0) throw new Error("Invalid generated P2PKH address");
      value = value * 58n + BigInt(digit);
    }
    const decoded: number[] = [];
    while (value > 0n) {
      decoded.unshift(Number(value & 255n));
      value >>= 8n;
    }
    for (const character of address.address) {
      if (character !== "1") break;
      decoded.unshift(0);
    }
    const hash160 = decoded.slice(1, 21).map((byte) => byte.toString(16).padStart(2, "0")).join("");
    db.close();
    const scriptHex = "76a914" + hash160 + "88ac";
    const valueHex = (20_000).toString(16).padStart(16, "0").match(/../g)?.reverse().join("");
    if (!valueHex) throw new Error("Unable to encode fixture value");
    const rawTxHex = "01000000" + "01" + "00".repeat(32) + "00000000" + "00" + "ffffffff" + "01" + valueHex + "19" + scriptHex + "00000000";
    const rawBytes = Uint8Array.from(rawTxHex.match(/../g)!.map((part) => Number.parseInt(part, 16)));
    const firstHash = await crypto.subtle.digest("SHA-256", rawBytes);
    const secondHash = await crypto.subtle.digest("SHA-256", firstHash);
    const txid = Array.from(new Uint8Array(secondHash)).reverse().map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { ...address, txid, rawTxHex, scriptHex };
  });
  confirmedTxid = fixture.txid;
  confirmedRawTxHex = fixture.rawTxHex;
  await page.evaluate(async (seed) => {
    const entries = await indexedDB.databases();
    const name = entries.map((entry) => entry.name).find((value): value is string => Boolean(value && value.includes(".plugin.p2pkh.state")));
    if (!name) throw new Error("P2PKH namespace database was not created");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = new Date().toISOString();
    const nullOutpointKey = "00".repeat(32) + ":0";
    const fact = {
      id: `${seed.resourceId}:${seed.txid}`,
      resourceId: seed.resourceId,
      publicKeyHex: seed.publicKeyHex,
      network: seed.network,
      address: seed.address,
      txid: seed.txid,
      rawTxHex: seed.rawTxHex,
      blockHeight: 1,
      inputOutpointKeys: [nullOutpointKey],
      inputs: [{ txid: "00".repeat(32), vout: 0, outpointKey: nullOutpointKey }],
      ownedOutpointKeys: [`${seed.txid}:0`],
      ownedOutputs: [{ vout: 0, value: 20_000, scriptHex: seed.scriptHex }],
      firstConfirmedAt: now,
      lastConfirmedAt: now
    };
    const row = {
      id: `${seed.resourceId}:${seed.txid}:0`,
      resourceId: seed.resourceId,
      publicKeyHex: seed.publicKeyHex,
      network: seed.network,
      address: seed.address,
      txid: seed.txid,
      vout: 0,
      outpointKey: `${seed.txid}:0`,
      value: 20_000,
      scriptHex: seed.scriptHex,
      chainState: "available",
      createdBlockHeight: 1,
      updatedAt: now
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(["p2pkh_transactions", "p2pkh_owned_outpoints"], "readwrite");
      transaction.objectStore("p2pkh_transactions").put(fact);
      transaction.objectStore("p2pkh_owned_outpoints").put(row);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, fixture);

  await page.goto("/transfer");
  await page.getByLabel("Password").fill("playwright-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Lock" })).toBeVisible();
  const offer = page.locator(".transfer-picker__item").filter({ hasText: "BSV" }).first();
  await expect(offer).toBeVisible({ timeout: 15_000 });
  await offer.click();
  await page.getByLabel("Recipient address").fill("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
  await page.getByLabel("Amount (sats)").fill("5000");
  await page.getByRole("button", { name: "Generate final transaction" }).click();
  await expect(page.getByRole("button", { name: "Broadcast transaction" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Broadcast transaction" }).click();
  await expect(page.getByText(/Status:\s*local-confirmed/i)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fakeWocBroadcasts).toBe(1);

  await page.getByRole("button", { name: "Start over" }).click();
  await page.getByLabel("Amount (sats)").fill("5000");
  await page.getByRole("button", { name: "Generate final transaction" }).click();
  await expect(page.getByText(/Inputs:\s*1/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Broadcast transaction" }).click();
  await expect(page.getByText(/Status:\s*isolated/i)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fakeWocBroadcasts).toBe(2);
  const isolatedReasons = await page.evaluate(async () => {
    const name = (await indexedDB.databases()).map((entry) => entry.name).find((value): value is string => Boolean(value && value.includes(".plugin.p2pkh.state")));
    if (!name) return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const rows = await new Promise<Array<{ state: string; isolationReason?: string }>>((resolve, reject) => {
      const request = db.transaction("p2pkh_local_transactions", "readonly").objectStore("p2pkh_local_transactions").getAll();
      request.onsuccess = () => resolve(request.result as Array<{ state: string; isolationReason?: string }>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return rows.filter((row) => row.state === "isolated").map((row) => row.isolationReason ?? "");
  });
  expect(isolatedReasons).toHaveLength(1);
  expect(isolatedReasons[0]).toMatch(/WOC|503|broadcast/i);
  await new Promise<void>((resolve, reject) => fakeWoc.close((error) => error ? reject(error) : resolve()));
});
