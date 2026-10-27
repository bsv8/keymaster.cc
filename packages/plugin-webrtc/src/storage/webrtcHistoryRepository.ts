// WebRTC 历史 owner/App K-V Repository。

import type { BorrowedKeyValueStore, BorrowedModuleFileStore } from "@keymaster/contracts";

const CALL_PARTITION = "calls";
const TRANSFER_PARTITION = "transfers";
const BLOB_PARTITION = "blobs";
const PREFIX = "record/";

export interface WebrtcCallHistoryRow { recordId: string; ownerPublicKeyHex: string; peerPublicKeyHex: string; kind: "audio_call" | "video_call"; direction: "outgoing" | "incoming"; status: "completed" | "missed" | "rejected" | "failed"; startedAtMs: number; endedAtMs?: number; durationSec?: number; note?: string; }
export interface WebrtcTransferHistoryRow { recordId: string; ownerPublicKeyHex: string; peerPublicKeyHex: string; kind: "image" | "file"; direction: "outgoing" | "incoming"; status: "completed" | "failed"; startedAtMs: number; endedAtMs?: number; durationSec?: number; fileName?: string; mimeType?: string; byteLength?: number; blobKey?: string; }
export interface WebrtcTransferBlobRow { blobKey: string; blob: Blob; }
export interface WebrtcHistoryRepository { readonly store: BorrowedKeyValueStore; close(): void; }

export function createWebrtcHistoryRepository(store: BorrowedKeyValueStore): WebrtcHistoryRepository {
  return { store, close: () => undefined };
}

export async function listWebrtcRows<T>(store: BorrowedKeyValueStore, partition: string): Promise<T[]> {
  const rows: T[] = []; let cursor: string | undefined;
  do { const page = await store.list({ partition, prefix: PREFIX, cursor, limit: 1000 }); rows.push(...page.entries.map((entry) => entry.value as T)); cursor = page.nextCursor; } while (cursor);
  return rows;
}

export async function putWebrtcRow(store: BorrowedKeyValueStore, partition: string, id: string, value: unknown): Promise<void> {
  await store.put(`${PREFIX}${id}`, value as never, { partition });
}

function blobPath(blobKey: string): string {
  if (!/^km-wrtc-transfer-[A-Za-z0-9_-]+-(completed|failed)\.blob$/.test(blobKey)) throw new Error("Invalid WebRTC attachment key");
  return `attachments/${blobKey}`;
}

export async function getWebrtcBlob(files: BorrowedModuleFileStore, blobKey: string): Promise<Blob | null> {
  const value = await files.get(blobPath(blobKey));
  return value ? new Blob([value.bytes.slice().buffer as ArrayBuffer]) : null;
}

export async function putWebrtcBlob(files: BorrowedModuleFileStore, blobKey: string, blob: Blob): Promise<void> {
  await files.put(blobPath(blobKey), new Uint8Array(await blob.arrayBuffer()));
}

export { CALL_PARTITION, TRANSFER_PARTITION, BLOB_PARTITION };
