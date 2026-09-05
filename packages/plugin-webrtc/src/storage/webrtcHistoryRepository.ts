// WebRTC 历史 owner/App K-V Repository。

import type { KeyValueStore } from "@keymaster/contracts";

export const WEBRTC_STORAGE_ID = "WebRTC";
export const WEBRTC_SCHEMA_VERSION = 1;
const CALL_PARTITION = "calls";
const TRANSFER_PARTITION = "transfers";
const BLOB_PARTITION = "blobs";
const PREFIX = "record/";

export interface WebrtcCallHistoryRow { recordId: string; ownerPublicKeyHex: string; peerPublicKeyHex: string; kind: "audio_call" | "video_call"; direction: "outgoing" | "incoming"; status: "completed" | "missed" | "rejected" | "failed"; startedAtMs: number; endedAtMs?: number; durationSec?: number; note?: string; }
export interface WebrtcTransferHistoryRow { recordId: string; ownerPublicKeyHex: string; peerPublicKeyHex: string; kind: "image" | "file"; direction: "outgoing" | "incoming"; status: "completed" | "failed"; startedAtMs: number; endedAtMs?: number; durationSec?: number; fileName?: string; mimeType?: string; byteLength?: number; blobKey?: string; }
export interface WebrtcTransferBlobRow { blobKey: string; blob: Blob; }
export interface WebrtcHistoryRepository { readonly store: KeyValueStore; close(): void; }

export function createWebrtcHistoryRepository(store: KeyValueStore): WebrtcHistoryRepository {
  return { store, close: () => undefined };
}

export async function listWebrtcRows<T>(store: KeyValueStore, partition: string): Promise<T[]> {
  const rows: T[] = []; let cursor: string | undefined;
  do { const page = await store.list({ partition, prefix: PREFIX, cursor, limit: 1000 }); rows.push(...page.entries.map((entry) => entry.value as T)); cursor = page.nextCursor; } while (cursor);
  return rows;
}

export async function putWebrtcRow(store: KeyValueStore, partition: string, id: string, value: unknown): Promise<void> {
  await store.put(`${PREFIX}${id}`, value as never, { partition });
}

export async function getWebrtcBlob(store: KeyValueStore, blobKey: string): Promise<Blob | null> {
  const value = await store.get<Uint8Array>(`blob/${blobKey}`, { partition: BLOB_PARTITION });
  return value ? new Blob([value.value.slice().buffer as ArrayBuffer]) : null;
}

export async function putWebrtcBlob(store: KeyValueStore, blobKey: string, blob: Blob): Promise<void> {
  await store.put(`blob/${blobKey}`, new Uint8Array(await blob.arrayBuffer()), { partition: BLOB_PARTITION });
}

export { CALL_PARTITION, TRANSFER_PARTITION, BLOB_PARTITION };
