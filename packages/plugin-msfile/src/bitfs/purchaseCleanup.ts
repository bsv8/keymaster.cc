import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import { createBitfsSessionJournal } from "./sessionJournal.js";
import { createBitfsPurchaseTasks } from "./purchaseTasks.js";
import type { BitfsFundingAccount, BitfsFundingLedger } from "./funding.js";
import { bitfsSessionNeedsFundingRecovery, bitfsContentLockKey, withBitfsContentLock, listBitfsPaths, deleteBitfsPrefix, markBitfsDeletedHistory, completeBitfsHistoryDeletion, readBitfsErasableHistory, readBitfsHiddenHistory } from "./purchaseRetention.js";

/** 清理用户明确选定的文件/采购历史。未结池仍是执行时原有账本记录，绝不在此创建池。 */
export async function deleteBitfsPurchaseData(input: {
  journal: BorrowedModuleFileStore; content: BorrowedModuleFileStore; ledger: BitfsFundingLedger;
  owner: string; seed: string; sessionId?: string; deleteContent: boolean; assertActive(): void;
}) {
  const { journal, content, ledger, owner, seed } = input;
  if (!/^(02|03)[0-9a-f]{64}$/.test(owner) || !/^[0-9a-f]{64}$/.test(seed)) throw new Error("采购删除身份无效");
  return withBitfsContentLock(bitfsContentLockKey(content, owner, seed), async () => {
    input.assertActive();
    const sessions = createBitfsSessionJournal(journal);
    const all = await sessions.list();
    const tasks = createBitfsPurchaseTasks(journal, owner, seed);
    const taskRows = await tasks.list();
    const targetTask = input.sessionId ? taskRows.find(t => t.sessionIds.includes(input.sessionId!)) : undefined;
    const targetIds = input.sessionId ? new Set(targetTask?.sessionIds ?? [input.sessionId]) : undefined;
    const selected = all.filter(s => s.role === "buyer" && s.ownerPublicKeyHex === owner && s.seedHashHex === seed && (!targetIds || targetIds.has(s.sessionId)));
    const accounts: BitfsFundingAccount[] = [];
    for (const network of ["main", "test"] as const) {
      if (await journal.get(`funding/accounts/${network}/${seed}.json`)) accounts.push(await ledger.getAccount({ ownerPublicKeyHex: owner, seedHashHex: seed, network, nowMs: Date.now() }));
    }
    const previouslyErasable = await readBitfsErasableHistory(journal, seed);
    const retained = selected.filter(s => {
      const pending = bitfsSessionNeedsFundingRecovery(s, accounts);
      // 上次已经验证结清但清理中断：账本可能已剪除，不能把旧签名误判成新责任。
      const hasLiveLedger = accounts.some(a => a.pools.some(p => p.poolId === s.sessionId && p.state !== "closed" && p.state !== "funding-failed")
        || a.transactions.some(t => t.poolId === s.sessionId && t.state !== "failed" && (t.state !== "observed" || !t.inputsReconciled)));
      return pending && (!previouslyErasable.has(s.sessionId) || hasLiveLedger);
    });
    const removed = selected.filter(s => !retained.includes(s));
    const removedIds = new Set([...removed.map(s => s.sessionId), ...[...previouslyErasable].filter(id => (!targetIds || targetIds.has(id)) && !all.some(s => s.sessionId === id))]);
    // 先持久化边界。后续失败可重试，迟到内容只能写恢复隔离区。
    await markBitfsDeletedHistory(journal, seed, selected.map(s => s.sessionId), [...removedIds]);
    input.assertActive();
    if (input.deleteContent) {
      const shared = await listBitfsPaths(content, `bitfs-staging/by-seed/${seed}/`);
      for (const record of retained) {
        for (const path of [...shared, ...await listBitfsPaths(content, `bitfs-staging/${record.sessionId}/`)]) {
          const value = await content.get(path);
          if (value) await content.put(`bitfs-recovery-content/${record.sessionId}/${path}`, value.bytes);
        }
      }
      await content.delete(`meta/${seed}.json`);
      await content.delete(`seeds/${seed}.ms`);
      await deleteBitfsPrefix(content, `storage/${seed}/`);
      await deleteBitfsPrefix(content, `bitfs-staging/by-seed/${seed}/`);
      for (const record of selected) await deleteBitfsPrefix(content, `bitfs-staging/${record.sessionId}/`);
    } else {
      // 删除历史保留正式文件；若还有待结池，其已验收内容仍只归原池恢复使用。
      for (const record of retained) {
        for (const path of [...await listBitfsPaths(content, `bitfs-staging/by-seed/${seed}/`), ...await listBitfsPaths(content, `bitfs-staging/${record.sessionId}/`)]) {
          const value = await content.get(path);
          if (value) await content.put(`bitfs-recovery-content/${record.sessionId}/${path}`, value.bytes);
        }
      }
      for (const record of removed) await deleteBitfsPrefix(content, `bitfs-staging/${record.sessionId}/`);
      const alreadyHidden = await readBitfsHiddenHistory(journal, seed);
      const selectedIds = new Set(selected.map(s => s.sessionId));
      // 闲置报价不拥有内容；最后一个普通采购任务删掉后不再为闲置报价留副本。
      if (taskRows.every(task => task.sessionIds.every(id => selectedIds.has(id) || alreadyHidden.has(id)))) {
        await deleteBitfsPrefix(content, `bitfs-staging/by-seed/${seed}/`);
      }
    }
    // 已关闭池由账本自身串行、条件写清理。未终态交易和其它池不受影响。
    for (const account of accounts) await ledger.forgetClosedPools({ ownerPublicKeyHex: owner, seedHashHex: seed, network: account.network, poolIds: [...removedIds], nowMs: Date.now() });
    const beforeTxids = new Set(accounts.flatMap(a => a.transactions.map(t => t.txid)));
    const referencedTxids = new Set<string>();
    for (const path of await listBitfsPaths(journal, "funding/accounts/")) {
      const file = await journal.get(path); if (!file) continue;
      const account = JSON.parse(new TextDecoder().decode(file.bytes)) as BitfsFundingAccount;
      for (const pool of account.pools) { referencedTxids.add(pool.fundingTxid); if (pool.recoveryTxid) referencedTxids.add(pool.recoveryTxid); }
      for (const tx of account.transactions) { referencedTxids.add(tx.txid); for (const outpoint of tx.inputOutpoints) referencedTxids.add(outpoint.split(":")[0]!); }
    }
    for (const record of all.filter(s => !removedIds.has(s.sessionId))) if (record.pendingTxid) referencedTxids.add(record.pendingTxid);
    for (const txid of beforeTxids) if (!referencedTxids.has(txid)) {
      await journal.delete(`transactions/${txid}.json`); await journal.delete(`transactions/${txid}.bin`);
    }
    for (const sessionId of removedIds) {
      input.assertActive();
      await deleteBitfsPrefix(journal, `evidence/${sessionId}/`);
      await journal.delete(`arbitration/${sessionId}.json`);
      await journal.delete(`sessions/${sessionId}.json`);
      await deleteBitfsPrefix(content, `bitfs-recovery-content/${sessionId}/`);
    }
    for (const task of taskRows) {
      if (!task.sessionIds.some(id => removedIds.has(id) || selected.some(s => s.sessionId === id))) continue;
      if (task.state === "active") await tasks.end(task.taskId, "cancelled", Date.now());
      if (task.sessionIds.every(id => removedIds.has(id)) && !task.legacyPlan) await journal.delete(`download-plans/${seed}/${task.taskId}.json`);
    }
    await tasks.forgetSessions([...removedIds]);
    if (!(await tasks.list()).some(t => t.legacyPlan)) await journal.delete(`download-plans/${seed}.json`);
    input.assertActive();
    await completeBitfsHistoryDeletion(journal, seed, [...selected.map(s => s.sessionId), ...removedIds]);
    return { deletedSessions: removed.length, retainedSessions: retained.length };
  });
}
