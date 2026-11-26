import type { BsvNetwork, WocQueryTransport, WocRequestOptions } from "@keymaster/contracts";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";

type ChainQueries = Pick<WocQueryTransport, "listScriptHistory" | "listScriptUnspent" | "getChainTransaction" | "getChainTransactions">;
type Page = {
  result: unknown[];
  error?: string;
  nextPageToken?: string;
  nextPage?: string;
  truncated?: boolean;
};
type Read = (network: BsvNetwork, path: string, options?: WocRequestOptions) => Promise<unknown>;

const txidPattern = /^[0-9a-f]{64}$/iu;
const uint = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const scriptHash = (script: string) => bytesToHex(sha256(hexToBytes(script)).reverse());

function page(value: unknown): Page {
  if (!value || typeof value !== "object") throw new Error("Invalid WoC script response");
  const row = value as Page;
  if (!Array.isArray(row.result) || row.error || row.truncated) throw new Error("Incomplete WoC script response");
  return row;
}

function cursor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Invalid WoC page token");
  return value;
}

function ids(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.some(id => typeof id !== "string" || !txidPattern.test(id))) {
    throw new Error("Invalid WoC block transaction list");
  }
  return raw.map(id => id.toLowerCase());
}

type TransactionBatch = WocQueryTransport["getChainTransactions"];
type TransactionBatchEntry = Awaited<ReturnType<TransactionBatch>>["entries"][number];
type ReadTransactions = (...args: Parameters<TransactionBatch>) => Promise<unknown>;

export function createConnectChainQueries(
  read: Read,
  getRawTransaction: WocQueryTransport["getRawTransaction"],
  readTransactions: ReadTransactions,
): ChainQueries {
  return {
    async listScriptHistory(network, input, opts) {
      const hash = scriptHash(input.script);
      const limit = 1000;
      const scope = [network, hash, input.state, ...(input.state === "confirmed" ? [input.fromHeight, input.toHeight] : [])];
      let token: string | undefined;
      let seen = 0;
      if (input.cursor) {
        const [bound, next, offset] = JSON.parse(input.cursor) as [unknown, unknown, unknown];
        if (JSON.stringify(bound) !== JSON.stringify(scope) || !uint(offset) || !(token = cursor(next))) throw new Error("Invalid script history cursor");
        seen = offset;
      }
      const query = new URLSearchParams(input.state === "confirmed"
        ? { order: "asc", height: String(input.fromHeight), limit: String(limit) } : {});
      if (token) query.set("token", token);
      const path = `/script/${hash}/${input.state}/history`;
      let response: unknown;
      try {
        response = await read(network, query.size ? `${path}?${query}` : path, opts);
      } catch (error) {
        const failure = error as { status?: number; body?: string };
        // WoC returns plain Not Found when the first confirmed history page is empty.
        if (input.state === "confirmed" && !token && failure?.status === 404 && failure.body?.trim() === "Not Found") {
          return { entries: [] };
        }
        throw error;
      }
      const data = page(response);
      const next = cursor(data.nextPageToken);
      if (next && next === token) throw new Error("WoC repeated its history token");
      if (input.state === "confirmed" && !next && data.result.length >= limit) {
        throw new Error("WoC history page has no continuation at the provider limit");
      }
      seen += data.result.length;
      if (input.state === "unconfirmed" && seen >= 100_000) throw new Error("WoC unconfirmed history limit reached");
      const entries = data.result.map(raw => {
        const entry = raw as { tx_hash?: string; height?: number };
        if (typeof entry?.tx_hash !== "string" || !txidPattern.test(entry.tx_hash) ||
            input.state === "confirmed" && !uint(entry.height)) throw new Error("Invalid WoC history entry");
        return { txid: entry.tx_hash.toLowerCase(), height: input.state === "confirmed" ? entry.height! : null };
      });
      // Filter by the requested window. Provider cursors continue across empty filtered pages.
      const selected = input.state === "confirmed"
        ? entries.filter(entry => entry.height! >= input.fromHeight && entry.height! <= input.toHeight)
        : entries;
      return { entries: selected, ...(next ? { cursor: JSON.stringify([scope, next, seen]) } : {}) };
    },

    async listScriptUnspent(network, script, opts) {
      const base = `/script/${scriptHash(script)}/unspent/all`;
      const entries = new Map<string, { txid: string; vout: number; satoshis: number }>();
      const tokens = new Set<string>();
      let mempoolCount = 0;
      let token: string | undefined;
      do {
        const data = page(await read(network, token ? `${base}?token=${encodeURIComponent(token)}` : base, opts));
        let confirmedCount = 0;
        for (const raw of data.result) {
          const row = raw as { tx_hash?: string; tx_pos?: number; value?: number; status?: string; isSpentInMempoolTx?: boolean };
          if (typeof row?.tx_hash !== "string" || !txidPattern.test(row.tx_hash) ||
              !uint(row.tx_pos) || row.tx_pos > 0xffffffff || !uint(row.value) ||
              typeof row.isSpentInMempoolTx !== "boolean" || (row.status !== "confirmed" && row.status !== "unconfirmed")) throw new Error("Invalid WoC unspent output");
          if (row.status === "confirmed") confirmedCount++;
          if (row.status === "unconfirmed" && ++mempoolCount >= 100_000) throw new Error("WoC unconfirmed UTXO limit reached");
          const outpoint = { txid: row.tx_hash.toLowerCase(), vout: row.tx_pos, satoshis: row.value };
          const key = `${outpoint.txid}:${outpoint.vout}`;
          if (row.isSpentInMempoolTx) entries.delete(key);
          else entries.set(key, outpoint);
        }
        token = cursor(data.nextPageToken ?? data.nextPage);
        if (!token && confirmedCount >= 1000) throw new Error("WoC unspent page has no continuation at the provider limit");
        if (token && tokens.has(token)) throw new Error("WoC repeated its unspent token");
        if (token) tokens.add(token);
      } while (token);
      return { outputs: [...entries.values()] };
    },

    async getChainTransactions(network, input, opts) {
      const response = await readTransactions(network, input, opts);
      if (!Array.isArray(response)) throw new Error("Invalid WoC transaction batch");
      const requested = new Set(input.txids);
      const seen = new Set<string>();
      const results = new Map<string, TransactionBatchEntry>();
      for (const value of response) {
        if (!value || typeof value !== "object" || typeof value.txid !== "string") continue;
        const txid = value.txid.toLowerCase();
        if (!requested.has(txid)) continue;
        if (seen.has(txid)) {
          results.delete(txid);
          continue;
        }
        seen.add(txid);
        if (value.error === "unknown") {
          results.set(txid, { txid, state: "not_observed" });
          continue;
        }
        if (value.error) continue;
        const rawTxHex = input.mode === "raw" ? value.hex : undefined;
        if (input.mode === "raw" && (typeof rawTxHex !== "string" || !/^(?:[0-9a-f]{2})+$/iu.test(rawTxHex) ||
            bytesToHex(sha256(sha256(hexToBytes(rawTxHex))).reverse()) !== txid)) continue;
        if (typeof value.blockhash === "string" && txidPattern.test(value.blockhash) &&
            uint(value.blockheight) && (value.confirmations === undefined || (uint(value.confirmations) && value.confirmations > 0))) {
          results.set(txid, { txid, state: "confirmed", height: value.blockheight, blockHash: value.blockhash.toLowerCase(), rawTxHex });
        } else if (!value.blockhash && (value.confirmations === undefined || value.confirmations === 0)) {
          results.set(txid, { txid, state: "unconfirmed", rawTxHex });
        }
      }
      return { entries: [...results.values()] };
    },

    async getChainTransaction(network, txid, opts) {
      let raw: unknown;
      try {
        raw = await read(network, `/tx/hash/${txid}`, opts);
      } catch (error) {
        if ((error as { status?: number }).status === 404) return { state: "not_observed" };
        throw error;
      }
      const detail = raw as { txid?: string; blockhash?: string; blockheight?: number; confirmations?: number };
      if (detail?.txid?.toLowerCase() !== txid) throw new Error("WoC transaction identity mismatch");
      const rawTxHex = await getRawTransaction(network, txid, opts);
      if (bytesToHex(sha256(sha256(hexToBytes(rawTxHex))).reverse()) !== txid) throw new Error("WoC raw transaction identity mismatch");
      if (!detail.blockhash) {
        if (detail.confirmations && detail.confirmations > 0) throw new Error("WoC confirmed transaction missing block hash");
        return { state: "unconfirmed", rawTxHex };
      }
      const blockHash = detail.blockhash.toLowerCase();
      if (!txidPattern.test(blockHash)) throw new Error("Invalid WoC block hash");
      const base = `/block/hash/${blockHash}`;
      const block = await read(network, base, opts) as {
        hash?: string; height?: number; txcount?: number; tx?: string[]; txids?: string[]; error?: string; pages?: { uri?: string[] } | null;
      };
      if (block.error || block.hash?.toLowerCase() !== blockHash || !uint(block.height) || !uint(block.txcount) ||
          (detail.blockheight !== undefined && detail.blockheight !== block.height)) throw new Error("WoC block identity mismatch");
      const ordered = ids(block.tx?.length ? block.tx : block.txids ?? []);
      const pagePaths = new Set<string>();
      for (const uri of block.pages?.uri ?? []) {
        const path = uri.replace(new RegExp(`^/v1/bsv/${network}`), "");
        if (!path.startsWith(base + "/page/") || !/^\d+$/u.test(path.slice(base.length + 6)) || pagePaths.has(path)) throw new Error("Invalid WoC block page path");
        pagePaths.add(path);
        for (const id of ids(await read(network, path, opts))) ordered.push(id);
      }
      const index = ordered.indexOf(txid);
      if (ordered.length !== block.txcount || new Set(ordered).size !== ordered.length || index < 0) throw new Error("WoC block transaction list is incomplete");
      return { state: "confirmed", rawTxHex, height: block.height, blockHash, index };
    },
  };
}
