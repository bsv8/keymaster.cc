// STAS owner/App K-V Repository。

import type { BsvNetwork, KeyValueStore } from "@keymaster/contracts";

export interface StasTokenSnapshot {
  /** token symbol。 */
  symbol: string;
  /** 网络。 */
  network: BsvNetwork;
  /** 持有地址。 */
  address: string;
  /** 余额。 */
  balance: number;
  /** 发行方；空字符串表示无 issuer。 */
  issuer: string;
  /** 同步时间。 */
  syncedAt: string;
}

export interface StasRepository {
  put(snapshot: StasTokenSnapshot): Promise<void>;
  replaceAll(snapshots: StasTokenSnapshot[]): Promise<void>;
  list(): Promise<StasTokenSnapshot[]>;
  close(): void;
}

export const STAS_STORAGE_ID = "STAS";
export const STAS_SCHEMA_VERSION = 1;
const PARTITION = "snapshots";
const PREFIX = "snapshot/";
const snapshotKey = (snapshot: StasTokenSnapshot) => `${PREFIX}${snapshot.network}/${snapshot.address}/${snapshot.issuer || "_"}/${snapshot.symbol}`;

export function createStasRepository(store: KeyValueStore): StasRepository {
  async function entries(): Promise<Array<{ key: string; value: StasTokenSnapshot }>> {
    const rows: Array<{ key: string; value: StasTokenSnapshot }> = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ partition: PARTITION, prefix: PREFIX, cursor, limit: 1000 });
      rows.push(...page.entries.map((entry) => ({ key: entry.key, value: entry.value as unknown as StasTokenSnapshot }))); cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }
  return {
    async put(snapshot) { await store.put(snapshotKey(snapshot), snapshot, { partition: PARTITION }); },
    async replaceAll(snapshots) {
      const old = await entries();
      await store.commit({ partition: PARTITION, operations: [...old.map((row) => ({ type: "delete" as const, key: row.key })), ...snapshots.map((row) => ({ type: "put" as const, key: snapshotKey(row), value: row }))] });
    },
    async list() { return (await entries()).map((row) => row.value); },
    close() { store.close(); }
  };
}
