import type { P2pkhConclusionInput, P2pkhConclusionResult, P2pkhConclusionRow } from "@keymaster/contracts";
import type { SubmitResult } from "@keymaster/utxo-manager";

type Scope = { ownerPublicKeyHex: string; network: "main" | "test" };
interface Query { input: Scope & { allocationId: string }; assertFresh(): void; controller: AbortController; timer?: ReturnType<typeof setTimeout>; inFlight: boolean; attempts: number; }
export interface ConclusionQueryPorts {
  capture(input: Scope): () => void;
  list(input: Scope): Promise<P2pkhConclusionRow[]>;
  runOnce(input: Scope & { allocationId: string }, assertFresh: () => void, signal: AbortSignal): Promise<SubmitResult>;
  changed(input: Scope): void;
  recover?(input: Scope & { allocationId: string }): Promise<unknown>;
  initialDelayMs?: number;
  maxDelayMs?: number;
}
/** Host scheduler ONLY: no coin selection, signing, receipt or release policy. */
export function createConclusionQueries(ports: ConclusionQueryPorts) {
  const queries = new Map<string, Query>();
  const errors = new Map<string, string>();
  const keyOf = (input: Scope & { allocationId: string }) => `${input.ownerPublicKeyHex.toLowerCase()}:${input.network}:${input.allocationId}`;
  function stop(query: Query) {
    if (query.timer) clearTimeout(query.timer);
    query.controller.abort();
    if (!query.inFlight && queries.get(keyOf(query.input)) === query) queries.delete(keyOf(query.input));
  }
  async function tick(query: Query) {
    const key = keyOf(query.input);
    if (query.controller.signal.aborted || queries.get(key) !== query) return;
    query.inFlight = true;
    let pending = false;
    try {
      query.assertFresh();
      const result = await ports.runOnce(query.input, query.assertFresh, query.controller.signal);
      query.assertFresh();
      pending = result.delivery === "unknown";
      errors.delete(key);
      ports.changed(query.input);
    } catch (error) {
      // Revocation/storage damage pauses the loop, never releases funds or
      // automatically starts a fresh payment. Explicit user action may retry.
      errors.set(key, (error instanceof Error ? error.message : String(error)).slice(0, 2048) || "查询暂停");
    } finally {
      query.inFlight = false;
      if (!pending || query.controller.signal.aborted) {
        if (queries.get(key) === query) queries.delete(key);
      } else {
        const wait = Math.min(ports.maxDelayMs ?? 60000, (ports.initialDelayMs ?? 5000) * 2 ** Math.min(query.attempts++, 4));
        query.timer = setTimeout(() => { void tick(query); }, wait);
      }
    }
  }
  async function list(input: Scope, assertFresh: () => void): Promise<P2pkhConclusionResult> {
    const rows = await ports.list(input);
    assertFresh();
    return { items: rows.map(row => {
      const key = keyOf({ ...input, allocationId: row.allocationId });
      const query = queries.get(key);
      return { ...row, queryState: query && !query.controller.signal.aborted ? "running" : "stopped", ...(errors.has(key) ? { error: errors.get(key)! } : {}) };
    }) };
  }
  return {
    async execute(input: P2pkhConclusionInput): Promise<P2pkhConclusionResult> {
      const assertFresh = ports.capture(input);
      assertFresh();
      if (input.action === "recover") {
        if (!ports.recover) throw Error("签名执行恢复暂不可用");
        await ports.recover(input); assertFresh(); ports.changed(input);
        return list(input, assertFresh);
      }
      if (input.action !== "list") {
        const key = keyOf(input);
        const previous = queries.get(key);
        if (input.action === "stop") { if (previous) stop(previous); }
        else if (!previous) {
          // Validate existence/terminal/delivery read-only before spawning.
          const row = (await list(input, assertFresh)).items.find(row => row.allocationId === input.allocationId);
          if (!row) throw Error("原交易申请不存在");
          if (row.delivery !== "wallet") throw Error("外露交易责任不能由钱包重交");
          if (row.retryable === false || !row.txid) throw Error(row.error ?? "原交易当前禁止派发，需先恢复签名执行证据");
          assertFresh();
          // Recheck after await: two start calls must not create two loops.
          if (row.state !== "done" && row.state !== "failed" && !queries.has(key)) {
            const query: Query = { input: { ownerPublicKeyHex: input.ownerPublicKeyHex, network: input.network, allocationId: input.allocationId }, assertFresh, controller: new AbortController(), inFlight: false, attempts: 0 };
            queries.set(key, query); errors.delete(key);
            query.timer = setTimeout(() => { void tick(query); }, 0);
          }
        }
      }
      return list(input, assertFresh);
    },
    dispose() { for (const query of queries.values()) stop(query); errors.clear(); },
  };
}
