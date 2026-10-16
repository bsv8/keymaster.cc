import type { MsFileHeardDemand } from "@keymaster/contracts";
import { isVerifiedHashRequest, type VerifiedHashRequest } from "bsv8-channel-protocol/hash-request";

/** 可丢弃的会话观察记录；既不留协议原文，也不写入存储或买卖日志。 */
export function createBitfsDemandMonitor() {
  let scope = "";
  let rows: MsFileHeardDemand[] = [];
  let lastReceivedAtMs: number | null = null;
  let activeChecks = 0;
  let checks: Array<{ row: MsFileHeardDemand; scope: string; inspect: () => Promise<boolean> }> = [];
  const pump = () => {
    while (activeChecks < 2 && checks.length) {
      const next = checks.shift()!;
      if (next.scope !== scope || !rows.includes(next.row)) continue;
      activeChecks++;
      void Promise.resolve().then(next.inspect).then(available => {
        if (next.scope === scope && rows.includes(next.row)) {
          next.row.availability = available ? "available" : "missing";
          if (!available && next.row.quoteStatus === "not-quoted") next.row.quoteStatus = "unmatched";
        }
      }, () => { if (next.scope === scope && rows.includes(next.row)) next.row.availability = "missing"; })
        .finally(() => { activeChecks--; pump(); });
    }
  };
  const reset = (next = "") => { scope = next; rows = []; checks = []; lastReceivedAtMs = null; };
  return {
    clear: () => reset(),
    updateQuote(currentScope: string, requestMessageId: string, requesterPublicKeyHex: string,
      status: MsFileHeardDemand["quoteStatus"], message: string | null = null) {
      if (scope !== currentScope) return;
      const row = rows.find(item => item.requestMessageId === requestMessageId && item.requesterPublicKeyHex === requesterPublicKeyHex);
      if (!row) return;
      if (row.quoteStatus !== "quoted") row.quoteStatus = status;
      if (status === "quoted") row.quotedAtMs = Date.now();
      row.quoteMessage = message?.slice(0, 4096) ?? null;
    },
    snapshot(currentScope: string) {
      if (scope !== currentScope) reset(currentScope);
      return { demands: rows.map(row => ({ ...row })), lastReceivedAtMs };
    },
    record(currentScope: string, request: VerifiedHashRequest, receivedAtMs: number, hasContent: () => Promise<boolean>) {
      if (!isVerifiedHashRequest(request) || request.expires_at_ms <= receivedAtMs) return;
      if (scope !== currentScope) reset(currentScope);
      if (rows.some(row => row.requestMessageId === request.message_id && row.requesterPublicKeyHex === request.from_public_key)) return;
      const row: MsFileHeardDemand = { requestMessageId: request.message_id, requesterPublicKeyHex: request.from_public_key,
        seedHashHex: request.body.hash, receivedAtMs, expiresAtMs: request.expires_at_ms, availability: "checking", quoteStatus: "not-quoted", quotedAtMs: null, quoteMessage: null };
      rows.unshift(row);
      rows.length = Math.min(rows.length, 20);
      lastReceivedAtMs = receivedAtMs;
      checks = checks.filter(item => rows.includes(item.row));
      checks.push({ row, scope: currentScope, inspect: hasContent });
      pump();
    },
  };
}
