import type {
  P2pkhLocalTransaction,
  P2pkhOwnedOutpointProjection,
  P2pkhTransactionFact
} from "../p2pkhContracts.js";
import { parseP2pkhTransaction, type ParsedP2pkhTransaction } from "../p2pkhTransactionParser.js";

export type P2pkhNetwork = "main" | "test";
export type P2pkhWalletView = "transactions" | "local-transactions";

export interface LocalTransactionRecord {
  id: string;
  resourceId: string;
  network: P2pkhNetwork;
  txid: string;
  rawTxHex: string;
  inputOutpointKeys: string[];
  outputs: Array<{ vout: number; value: number; scriptHex: string }>;
  fact?: P2pkhTransactionFact;
  local?: P2pkhLocalTransaction;
}

/** Parse only bytes already persisted in the local fact/overlay. */
export function parseStoredTransaction(rawTxHex: string | undefined, txid: string): ParsedP2pkhTransaction | undefined {
  if (!rawTxHex) return undefined;
  try {
    return parseP2pkhTransaction(rawTxHex, txid);
  } catch {
    return undefined;
  }
}

export function sumOutputs(outputs: Array<{ value: number }>): number {
  return outputs.reduce((sum, output) => sum + output.value, 0);
}

export function inputAmount(
  resourceId: string,
  inputOutpointKeys: string[],
  inputValuesByResource: Record<string, Record<string, number>>
): { value?: number; complete: boolean } {
  const values = inputValuesByResource[resourceId] ?? {};
  if (inputOutpointKeys.some((key) => values[key] === undefined)) return { complete: false };
  return { value: inputOutpointKeys.reduce((sum, key) => sum + values[key]!, 0), complete: true };
}

/**
 * Return the balance represented by the local projection at the end of a
 * block. The local fact does not contain an intra-block transaction index,
 * so this must not be presented as the balance immediately after a specific
 * transaction.
 */
export function balanceAtBlock(
  network: P2pkhNetwork,
  blockHeight: number | undefined,
  owned: P2pkhOwnedOutpointProjection[],
  complete: boolean
): number | undefined {
  if (blockHeight === undefined || !complete) return undefined;
  return owned
    .filter((row) => row.network === network && row.createdBlockHeight !== undefined && row.createdBlockHeight <= blockHeight)
    .filter((row) => row.spentBlockHeight === undefined || row.spentBlockHeight > blockHeight)
    .reduce((sum, row) => sum + row.value, 0);
}

export function listPath(network: P2pkhNetwork, page = 1, view: P2pkhWalletView = "transactions"): string {
  const networkPath = network === "main" ? "mainnet" : "testnet";
  const pathname = `/p2pkh/${networkPath}/${view}`;
  return `${pathname}?${new URLSearchParams({ page: String(page) }).toString()}`;
}

export function detailPath(txid: string, network: P2pkhNetwork, page: number, source: P2pkhWalletView = "transactions"): string {
  const params = new URLSearchParams({ network, page: String(page), source });
  return `/p2pkh/tx/${encodeURIComponent(txid)}?${params.toString()}`;
}

export function readPage(search = window.location.search): number {
  const raw = Number.parseInt(new URLSearchParams(search).get("page") ?? "1", 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 1;
}

export function readTransactionNetwork(search = window.location.search): P2pkhNetwork {
  return new URLSearchParams(search).get("network") === "test" ? "test" : "main";
}

/** The only accepted detail source is the formal local-transactions list. */
export function parseTransactionSource(search: string): P2pkhWalletView {
  return new URLSearchParams(search).get("source") === "local-transactions" ? "local-transactions" : "transactions";
}

export function readTransactionSource(search = window.location.search): P2pkhWalletView {
  return parseTransactionSource(search);
}

export function transactionSourceListPath(search: string): string {
  const network = new URLSearchParams(search).get("network") === "test" ? "testnet" : "mainnet";
  return `/p2pkh/${network}/${parseTransactionSource(search)}`;
}

export function readTransactionId(pathname = window.location.pathname): string | undefined {
  const match = pathname.match(/^\/p2pkh\/tx\/([^/]+)$/);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}

export function formatLocalTime(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
