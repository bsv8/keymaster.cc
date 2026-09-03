// WebRTC 历史库（key-scoped IndexedDB）。
//
// 设计缘由：
//   - 每把 key 一个 namespace DB；
//   - 这里只存 WebRTC 自己的历史，不碰消息插件的真值；
//   - schema 尽量简单，允许后续按需扩展。

import type { KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";

const PLUGIN_ID = "webrtc";
const STORAGE_ID = "history";
const DB_VERSION = 1;

export interface WebrtcHistoryDb {
  handle: KeyScopedStorageHandle;
  close(): void;
}

export async function openWebrtcHistoryDb(input: {
  keyspace: KeyspaceService;
  publicKeyHex: string;
}): Promise<WebrtcHistoryDb | null> {
  if (!input.publicKeyHex) return null;
  const handle = await input.keyspace.openKeyStorage({
    publicKeyHex: input.publicKeyHex,
    pluginId: PLUGIN_ID,
    storageId: STORAGE_ID,
    version: DB_VERSION,
    upgrade(db) {
      if (db.objectStoreNames.contains("call_records")) {
        db.deleteObjectStore("call_records");
      }
      if (db.objectStoreNames.contains("transfer_records")) {
        db.deleteObjectStore("transfer_records");
      }
      if (db.objectStoreNames.contains("blobs")) {
        db.deleteObjectStore("blobs");
      }
      db.createObjectStore("call_records", { keyPath: "recordId" });
      db.createObjectStore("transfer_records", { keyPath: "recordId" });
      db.createObjectStore("blobs", { keyPath: "blobKey" });
    }
  });
  return {
    handle,
    close: () => handle.close()
  };
}

export interface WebrtcCallHistoryRow {
  recordId: string;
  ownerPublicKeyHex: string;
  peerPublicKeyHex: string;
  kind: "audio_call" | "video_call";
  direction: "outgoing" | "incoming";
  status: "completed" | "missed" | "rejected" | "failed";
  startedAtMs: number;
  endedAtMs?: number;
  durationSec?: number;
  note?: string;
}

export interface WebrtcTransferHistoryRow {
  recordId: string;
  ownerPublicKeyHex: string;
  peerPublicKeyHex: string;
  kind: "image" | "file";
  direction: "outgoing" | "incoming";
  status: "completed" | "failed";
  startedAtMs: number;
  endedAtMs?: number;
  durationSec?: number;
  fileName?: string;
  mimeType?: string;
  byteLength?: number;
  blobKey?: string;
}

export interface WebrtcTransferBlobRow {
  blobKey: string;
  blob: Blob;
}
