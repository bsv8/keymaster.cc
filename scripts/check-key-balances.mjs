#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrivateKey } from "@bsv/sdk";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const keysPath = resolve(root, ".david/keys.md");
const reportPath = resolve(root, ".david/key-balances.json");
const WOC_BASE = "https://api.whatsonchain.com/v1/bsv";
const NETWORKS = ["main", "test"];
const MAX_REQUESTS = 3;
const WINDOW_MS = 1000;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

class RateLimiter {
  #timestamps = [];

  async wait() {
    while (true) {
      const now = Date.now();
      this.#timestamps = this.#timestamps.filter((t) => now - t < WINDOW_MS);
      if (this.#timestamps.length < MAX_REQUESTS) {
        this.#timestamps.push(now);
        return;
      }
      await sleep(WINDOW_MS - (now - this.#timestamps[0]) + 10);
    }
  }
}

const limiter = new RateLimiter();

function loadKeys(markdown) {
  const keys = new Map();
  for (const line of markdown.split("\n")) {
    const match = line.match(/^\s*-\s*`([0-9a-fA-F]{64})`\s*(?:—|--)?\s*(.*)$/);
    if (!match) continue;
    const hex = match[1].toLowerCase();
    if (/^0+$/.test(hex)) continue;
    if (!keys.has(hex)) keys.set(hex, match[2].trim());
  }
  return [...keys].map(([hex, source]) => ({ hex, source }));
}

function addressesFor(hex) {
  const key = PrivateKey.fromString(hex, "hex");
  return {
    publicKeyHex: key.toPublicKey().toString(),
    main: key.toAddress("mainnet").toString(),
    test: key.toAddress("testnet").toString(),
  };
}

async function fetchBalance(network, address) {
  const url = `${WOC_BASE}/${network}/address/${encodeURIComponent(address)}/balance`;
  await limiter.wait();
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const body = await response.text();
  if (!response.ok) throw new Error(`WOC ${response.status}: ${body.slice(0, 300)}`);
  const parsed = JSON.parse(body);
  return {
    confirmed: Number(parsed.confirmed ?? 0),
    unconfirmed: Number(parsed.unconfirmed ?? 0),
    total: Number(parsed.confirmed ?? 0) + Number(parsed.unconfirmed ?? 0),
  };
}

async function main() {
  const keys = loadKeys(await readFile(keysPath, "utf8"));
  if (keys.length === 0) throw new Error(`No keys found in ${keysPath}`);
  const checkedAt = new Date().toISOString();
  const results = [];

  for (const { hex, source } of keys) {
    const result = { privateKeyHex: hex, source };
    try {
      const addresses = addressesFor(hex);
      result.publicKeyHex = addresses.publicKeyHex;
      result.addresses = {};
      for (const network of NETWORKS) {
        const address = addresses[network];
        try {
          result.addresses[network] = { address, balance: await fetchBalance(network, address) };
        } catch (error) {
          result.addresses[network] = { address, error: error.message };
        }
      }
    } catch (error) {
      result.error = `Invalid private key: ${error.message}`;
    }
    results.push(result);
    console.log(`${hex.slice(0, 8)}…${hex.slice(-8)} checked`);
  }

  const report = { checkedAt, source: keysPath, requestLimit: "max 3 WOC requests per rolling second", results };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`\nWrote ${reportPath}`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
