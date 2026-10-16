import type { BorrowedOwnerFileStore, MsFileBitfsFundingPoolSnapshot } from "@keymaster/contracts";
import type { BitfsFundingLedger } from "./funding.js";
import { createBitfsSessionJournal } from "./sessionJournal.js";
import { bitfsSessionNeedsFundingRecovery, listBitfsPaths, readBitfsHiddenHistory } from "./purchaseRetention.js";

/** 独立费用池读模型：枚举任务执行期间已写入的资金账本，不依赖购买历史是否存在。 */
export async function listBitfsFundingPools(input: { journal: BorrowedOwnerFileStore; ledger: BitfsFundingLedger; owner: string; network: "main" | "test" }): Promise<MsFileBitfsFundingPoolSnapshot[]> {
  const { journal, ledger, owner } = input;
  const result: MsFileBitfsFundingPoolSnapshot[] = [];
  const sessions = createBitfsSessionJournal(journal);
  for (const path of await listBitfsPaths(journal, "funding/accounts/")) {
    const match = /^funding\/accounts\/(main|test)\/([0-9a-f]{64})\.json$/.exec(path);
    if (!match) continue;
    const network = match[1] as "main" | "test", seed = match[2]!;
    const account = await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: Date.now() });
    const deleted = await readBitfsHiddenHistory(journal, seed);
    for (const pool of account.pools) {
      const session = await sessions.get(pool.poolId);
      const opening = account.utxos.find(u => `${u.txid}:${u.vout}` === pool.openingOutpoint);
      const transactions = account.transactions.filter(t => t.poolId === pool.poolId);
      const unsettled = transactions.some(t => t.state !== "failed" && (t.state !== "observed" || !t.inputsReconciled));
      let filename: string | null = null;
      const quote = await sessions.getEvidence(pool.poolId, "quote-summary");
      if (quote) {
        const value = JSON.parse(new TextDecoder().decode(quote)) as { recommendedFilename?: unknown };
        if (typeof value.recommendedFilename === "string") filename = value.recommendedFilename.slice(0, 512);
      }
      result.push({ poolId: pool.poolId, seedHashHex: seed, network, state: pool.state,
        fundingTxid: pool.fundingTxid, openingOutpoint: pool.openingOutpoint, recoveryTxid: pool.recoveryTxid ?? null,
        sellerPublicKeyHex: session?.counterpartyPublicKeyHex ?? null, recommendedFilename: filename,
        poolAmountSatoshis: opening?.valueSatoshis ?? null,
        lockedSatoshis: pool.state === "closed" || pool.state === "funding-failed" ? "0" : opening?.valueSatoshis ?? null,
        pendingReturnSatoshis: pool.state === "recovery-pending" ? account.utxos.filter(u => u.poolId === pool.poolId && u.state === "recovery-pending" && `${u.txid}:${u.vout}` !== pool.openingOutpoint).reduce((sum, u) => sum + BigInt(u.valueSatoshis), 0n).toString() : "0",
        needsRecovery: pool.state !== "closed" || unsettled, historyDeleted: deleted.has(pool.poolId), canManage: Boolean(session),
      });
    }
  }
  // 开池预签早于 FundingTx 入账；原执行日志中的这类责任同样独立可见。
  for (const session of await sessions.list()) {
    if (session.role !== "buyer" || session.ownerPublicKeyHex !== owner || result.some(pool => pool.poolId === session.sessionId)
      || !bitfsSessionNeedsFundingRecovery(session, [])) continue;
    const config = await sessions.getEvidence(session.sessionId, "opening-configuration");
    const amount = config ? (JSON.parse(new TextDecoder().decode(config)) as { openingAmountSatoshis?: string }).openingAmountSatoshis ?? null : null;
    result.push({ poolId: session.sessionId, seedHashHex: session.seedHashHex, network: input.network, state: "opening-presign",
      fundingTxid: session.pendingTxid ?? null, openingOutpoint: null, recoveryTxid: null,
      sellerPublicKeyHex: session.counterpartyPublicKeyHex, recommendedFilename: null, poolAmountSatoshis: amount,
      lockedSatoshis: null, pendingReturnSatoshis: null, needsRecovery: true,
      historyDeleted: (await readBitfsHiddenHistory(journal, session.seedHashHex)).has(session.sessionId), canManage: true });
  }
  return result;
}
