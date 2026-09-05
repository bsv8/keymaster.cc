// BSV-21 mint history owner/App K-V Repository。

import type { KeyValueStore, ProtocolSpendPreview, ProtocolSpendResult } from "@keymaster/contracts";
import type { Bsv21Payload } from "../bsv21Script.js";

export type Bsv21MintHistoryStatus = "prepared" | ProtocolSpendResult["status"];
export interface Bsv21MintHistoryRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: Bsv21MintHistoryStatus;
  request: { network: "main" | "test"; amount: string; sym?: string; dec?: number; feeRateSatoshisPerKb: number; changeAddress?: string; ownerPublicKeyHex: string };
  payload: Bsv21Payload;
  preview: { tokenId: string; spend: ProtocolSpendPreview };
  submit?: { tokenId: string; spend: ProtocolSpendResult; submittedAt: string };
}

export interface Bsv21MintHistoryRepository {
  get(id: string): Promise<Bsv21MintHistoryRecord | undefined>;
  put(record: Bsv21MintHistoryRecord): Promise<void>;
  list(): Promise<Bsv21MintHistoryRecord[]>;
  findByTokenId(tokenId: string): Promise<Bsv21MintHistoryRecord | undefined>;
  close(): void;
}

const PREFIX = "mint/";
const PARTITION = "mint-history";

export function createBsv21MintHistoryRepository(store: KeyValueStore): Bsv21MintHistoryRepository {
  async function listAll(): Promise<Bsv21MintHistoryRecord[]> {
    const rows: Bsv21MintHistoryRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ partition: PARTITION, prefix: PREFIX, cursor, limit: 1000 });
      rows.push(...page.entries.map((entry) => entry.value as unknown as Bsv21MintHistoryRecord)); cursor = page.nextCursor;
    } while (cursor);
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return {
    async get(id) { return (await store.get<Bsv21MintHistoryRecord>(`${PREFIX}${id}`, { partition: PARTITION }))?.value; },
    async put(record) { await store.put(`${PREFIX}${record.id}`, record, { partition: PARTITION }); },
    list: listAll,
    async findByTokenId(tokenId) { return (await listAll()).find((record) => record.preview.tokenId === tokenId || record.submit?.tokenId === tokenId); },
    close() { store.close(); }
  };
}
