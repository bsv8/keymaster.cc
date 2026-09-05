// BSV-21 owner/App K-V Repository。
// 快照替换与普通写入都通过同一 partition commit，保证读者只看到完整版本。

import type { BsvNetwork, KeyValueStore } from "@keymaster/contracts";

export interface Bsv21TokenSnapshot {
  /** token origin（即 tokenId）。 */
  origin: string;
  /** WOC 当前未花费输出。 */
  outpoint: string;
  /** 网络。 */
  network: BsvNetwork;
  /** WOC 观察状态。 */
  observation?: "unconfirmed" | "confirmed";
  /** WOC 观察到的 canonical txid。 */
  canonicalTxid?: string;
  /** 持有此 token 的地址。 */
  address: string;
  /** 当前 token 金额，十进制字符串。 */
  amount: string;
  /** token 元数据。 */
  meta: { origin: string; symbol?: string; issuer?: string; decimals?: number };
  /** 同步时间。 */
  syncedAt: string;
}

export interface Bsv21StateRepository {
  put(snapshot: Bsv21TokenSnapshot): Promise<void>;
  replaceAll(snapshots: Bsv21TokenSnapshot[]): Promise<void>;
  list(): Promise<Bsv21TokenSnapshot[]>;
  close(): void;
}

export const BSV21_STORAGE_ID = "BSV21";
export const BSV21_SCHEMA_VERSION = 1;
const PARTITION = "snapshots";
const PREFIX = "snapshot/";

function assertSnapshot(snapshot: Bsv21TokenSnapshot): void {
  if (!/^[0-9]+$/u.test(snapshot.amount) || !snapshot.network || !snapshot.address || !snapshot.origin || !snapshot.outpoint) {
    throw new Error("BSV-21 snapshot is invalid");
  }
}

async function all(store: KeyValueStore): Promise<Array<{ key: string; value: Bsv21TokenSnapshot }>> {
  const rows: Array<{ key: string; value: Bsv21TokenSnapshot }> = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ partition: PARTITION, prefix: PREFIX, cursor, limit: 1000 });
    rows.push(...page.entries.map((entry) => ({ key: entry.key, value: entry.value as unknown as Bsv21TokenSnapshot })));
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

export function createBsv21StateRepository(store: KeyValueStore): Bsv21StateRepository {
  return {
    async put(snapshot) {
      assertSnapshot(snapshot);
      await store.put(`${PREFIX}${snapshot.network}/${snapshot.address}/${snapshot.origin}/${snapshot.outpoint}`, snapshot, { partition: PARTITION });
    },
    async replaceAll(snapshots) {
      snapshots.forEach(assertSnapshot);
      const old = await all(store);
      await store.commit({ partition: PARTITION, operations: [
        ...old.map((entry) => ({ type: "delete" as const, key: entry.key })),
        ...snapshots.map((snapshot) => ({ type: "put" as const, key: `${PREFIX}${snapshot.network}/${snapshot.address}/${snapshot.origin}/${snapshot.outpoint}`, value: snapshot }))
      ] });
    },
    async list() { return (await all(store)).map((entry) => entry.value); },
    close() { store.close(); }
  };
}
