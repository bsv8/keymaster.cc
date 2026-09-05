// 1Sat Ordinals 铸造历史 owner/App K-V Repository。

import type { KeyValueStore, ProtocolSpendPreview, ProtocolSpendResult } from "@keymaster/contracts";
import type { OrdinalEnvelopeEntry } from "../ordinalScript.js";

export type OrdinalMintHistoryStatus = "prepared" | ProtocolSpendResult["status"];
export interface OrdinalMintHistoryRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: OrdinalMintHistoryStatus;
  request: { network: "main" | "test"; contentType: string; dataBase64: string; dataSize: number; metadata?: OrdinalEnvelopeEntry[]; feeRateSatoshisPerKb: number; changeAddress?: string; ownerPublicKeyHex: string };
  preview: { inscriptionId: string; outputScriptHex: string; spend: ProtocolSpendPreview };
  submit?: { inscriptionId: string; spend: ProtocolSpendResult; submittedAt: string };
}
export interface OrdinalMintHistoryRepository { get(id: string): Promise<OrdinalMintHistoryRecord | undefined>; put(record: OrdinalMintHistoryRecord): Promise<void>; list(): Promise<OrdinalMintHistoryRecord[]>; close(): void; }

export const ORDINALS_STORAGE_ID = "1SatOrdinals";
export const ORDINALS_SCHEMA_VERSION = 1;
const PARTITION = "mint-history";
const PREFIX = "mint/";

export function createOrdinalMintHistoryRepository(store: KeyValueStore): OrdinalMintHistoryRepository {
  async function listAll(): Promise<OrdinalMintHistoryRecord[]> {
    const rows: OrdinalMintHistoryRecord[] = []; let cursor: string | undefined;
    do { const page = await store.list({ partition: PARTITION, prefix: PREFIX, cursor, limit: 1000 }); rows.push(...page.entries.map((entry) => entry.value as unknown as OrdinalMintHistoryRecord)); cursor = page.nextCursor; } while (cursor);
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return {
    async get(id) { return (await store.get<OrdinalMintHistoryRecord>(`${PREFIX}${id}`, { partition: PARTITION }))?.value; },
    async put(record) { await store.put(`${PREFIX}${record.id}`, record, { partition: PARTITION }); },
    list: listAll,
    close() { store.close(); }
  };
}
