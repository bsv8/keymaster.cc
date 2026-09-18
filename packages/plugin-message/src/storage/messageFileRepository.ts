// 消息证据文件仓库：`<owner>/messages/<对端>/{sent,received,timeindex}/`。
//
// 与 KeymasterFormats 的 messages 规范一致：
//   - sent/<seed_hash>.json     出站签名明文精确字节
//   - received/<seed_hash>.json 入站加密信封精确字节
//   - timeindex/<毫秒>-<message_id>.json 本地时间索引
// 文件名是内容身份；raw 允许重复写入（同名即同内容），时间索引只追加。
// 仓库不做删除、不做索引重建。

import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import { masterSeedHashHex } from "./masterSeed.js";

const INDEX_FORMAT = "keymaster.message-index";
const INDEX_VERSION = 1;
const INDEX_NAME_PATTERN = /^(\d{13})-([A-Za-z0-9_-]{43})\.json$/u;
const SEED_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLIC_KEY_PATTERN = /^(02|03)[0-9a-f]{64}$/u;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type MessageIndexKind = "sent" | "received";

/** 时间索引文件名给出的两个稳定字段；不需要读文件。 */
export interface MessageIndexName {
  /** 本机观察时间（毫秒），13 位补零后与文件名一致。 */
  timestamp: number;
  /** ChannelProtocol message_id。 */
  messageId: string;
}

/** 时间索引完整条目。 */
export interface MessageIndexEntry extends MessageIndexName {
  kind: MessageIndexKind;
  /** 对应 raw 文件名的 MasterSeed seed_hash。 */
  rawHash: string;
}

export interface MessageFileRepository {
  /** 写入出站签名明文，返回内容 seed_hash。 */
  putSentRaw(peerPublicKeyHex: string, bytes: Uint8Array): Promise<string>;
  /** 写入入站加密信封，返回内容 seed_hash。 */
  putReceivedRaw(peerPublicKeyHex: string, bytes: Uint8Array): Promise<string>;
  /** 追加一条本地时间索引；先写 raw 再调用。 */
  appendIndex(peerPublicKeyHex: string, entry: MessageIndexEntry): Promise<void>;
  /** 读取 raw；不存在返回 undefined。 */
  readRaw(peerPublicKeyHex: string, kind: MessageIndexKind, rawHash: string): Promise<Uint8Array | undefined>;
  /** 只列时间索引文件名，按时间降序；不读 raw，也不读索引内容。 */
  listIndexNames(peerPublicKeyHex: string): Promise<MessageIndexName[]>;
  /** 读取一条时间索引内容。 */
  readIndex(peerPublicKeyHex: string, name: MessageIndexName): Promise<MessageIndexEntry | undefined>;
  /** 列出全部对端公钥目录。 */
  listPeers(): Promise<string[]>;
}

function assertPeer(peerPublicKeyHex: string): string {
  const peer = peerPublicKeyHex.trim().toLowerCase();
  if (!PUBLIC_KEY_PATTERN.test(peer)) throw new Error("Message peer public key is invalid");
  return peer;
}

function assertSeedHash(rawHash: string): string {
  const hash = rawHash.trim().toLowerCase();
  if (!SEED_HASH_PATTERN.test(hash)) throw new Error("Message raw seed hash is invalid");
  return hash;
}

function assertMessageId(messageId: string): string {
  if (!MESSAGE_ID_PATTERN.test(messageId)) throw new Error("Message id is invalid");
  return messageId;
}

function assertTimestamp(timestamp: number): number {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 9_999_999_999_999) {
    throw new Error("Message index timestamp is invalid");
  }
  return timestamp;
}

function indexName(entry: MessageIndexEntry): string {
  return `${String(assertTimestamp(entry.timestamp)).padStart(13, "0")}-${assertMessageId(entry.messageId)}.json`;
}

function parseIndexName(fileName: string): MessageIndexName | undefined {
  const match = INDEX_NAME_PATTERN.exec(fileName);
  if (!match) return undefined;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp)) return undefined;
  return { timestamp, messageId: match[2]! };
}

async function listAll(
  files: BorrowedOwnerFileStore,
  prefix: string,
): Promise<Array<{ path: string; lastModified?: string }>> {
  const result: Array<{ path: string; lastModified?: string }> = [];
  let cursor: string | undefined;
  do {
    // 页面桥请求校验：空字符串 prefix 必须省略；limit 上限是 256。
    const page = await files.list(prefix.length > 0 ? { prefix, cursor, limit: 200 } : { cursor, limit: 200 });
    for (const entry of page.files) result.push({ path: entry.path, lastModified: entry.lastModified });
    cursor = page.nextCursor;
  } while (cursor);
  return result;
}

/** 用只读文件句柄构造消息仓库。 */
export function createMessageFileRepository(files: BorrowedOwnerFileStore): MessageFileRepository {
  return {
    async putSentRaw(peerPublicKeyHex, bytes) {
      const peer = assertPeer(peerPublicKeyHex);
      const hash = masterSeedHashHex(bytes);
      await files.put(`${peer}/sent/${hash}.json`, bytes);
      return hash;
    },
    async putReceivedRaw(peerPublicKeyHex, bytes) {
      const peer = assertPeer(peerPublicKeyHex);
      const hash = masterSeedHashHex(bytes);
      await files.put(`${peer}/received/${hash}.json`, bytes);
      return hash;
    },
    async appendIndex(peerPublicKeyHex, entry) {
      const peer = assertPeer(peerPublicKeyHex);
      const rawHash = assertSeedHash(entry.rawHash);
      const timestamp = assertTimestamp(entry.timestamp);
      const messageId = assertMessageId(entry.messageId);
      if (entry.kind !== "sent" && entry.kind !== "received") throw new Error("Message index kind is invalid");
      const document = {
        format: INDEX_FORMAT,
        version: INDEX_VERSION,
        kind: entry.kind,
        timestamp,
        rawHash,
        messageId,
      };
      await files.put(`${peer}/timeindex/${indexName({ ...entry, rawHash, timestamp, messageId })}`, new TextEncoder().encode(`${JSON.stringify(document)}\n`));
    },
    async readRaw(peerPublicKeyHex, kind, rawHash) {
      const peer = assertPeer(peerPublicKeyHex);
      const hash = assertSeedHash(rawHash);
      if (kind !== "sent" && kind !== "received") throw new Error("Message raw kind is invalid");
      const object = await files.get(`${peer}/${kind}/${hash}.json`);
      return object?.bytes;
    },
    async listIndexNames(peerPublicKeyHex) {
      const peer = assertPeer(peerPublicKeyHex);
      const listed = await listAll(files, `${peer}/timeindex/`);
      const names: MessageIndexName[] = [];
      for (const entry of listed) {
        const fileName = entry.path.slice(entry.path.lastIndexOf("/") + 1);
        const name = parseIndexName(fileName);
        if (name) names.push(name);
      }
      // 字典序即时间序；返回时倒序，调用方拿到"最新在前"。
      names.sort((left, right) => right.timestamp - left.timestamp || right.messageId.localeCompare(left.messageId));
      return names;
    },
    async readIndex(peerPublicKeyHex, name) {
      const peer = assertPeer(peerPublicKeyHex);
      const object = await files.get(`${peer}/timeindex/${indexName({ kind: "sent", timestamp: name.timestamp, messageId: name.messageId, rawHash: "0".repeat(64) })}`);
      if (!object) return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(object.bytes));
      } catch {
        return undefined;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const record = parsed as Record<string, unknown>;
      if (record.format !== INDEX_FORMAT || record.version !== INDEX_VERSION) return undefined;
      if (record.kind !== "sent" && record.kind !== "received") return undefined;
      if (typeof record.timestamp !== "number" || record.timestamp !== name.timestamp) return undefined;
      if (typeof record.messageId !== "string" || record.messageId !== name.messageId) return undefined;
      if (typeof record.rawHash !== "string" || !SEED_HASH_PATTERN.test(record.rawHash)) return undefined;
      return {
        kind: record.kind,
        timestamp: record.timestamp,
        rawHash: record.rawHash,
        messageId: record.messageId,
      };
    },
    async listPeers() {
      const listed = await listAll(files, "");
      const peers = new Set<string>();
      for (const entry of listed) {
        const separator = entry.path.indexOf("/");
        if (separator <= 0) continue;
        const candidate = entry.path.slice(0, separator).toLowerCase();
        if (PUBLIC_KEY_PATTERN.test(candidate)) peers.add(candidate);
      }
      return [...peers].sort();
    },
  };
}
