// 消息业务 service。
//
// 消息只通过 Channel 的固定 `bsv8.message.v1` 私信协议收发；历史按
// KeymasterFormats 的 messages 规范落盘：出站签名明文与入站加密信封作为
// raw 证据，本地时间索引只追加、不删除、不重建。列表顺序来自索引文件名，
// 正文按需从 raw 解码（出站本地解析，入站由 Coordinator 解密验签）。
// 这里不查询远端历史、不查询在线状态，也不暴露 Supplier、SSP 或私钥字段。

import type {
  BorrowedOwnerFileStore,
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  JSONValue,
  KeyspaceService,
  MessageContentType,
  MessageRecord
} from "@keymaster/contracts";
import { MESSAGE_PRIVATE_PROTOCOL } from "@keymaster/contracts";
import {
  createMessageFileRepository,
  type MessageFileRepository,
  type MessageIndexEntry
} from "./storage/messageFileRepository.js";

/** 消息业务插件公开的 service。 */
export interface MessageService {
  /** 当前 owner 已解锁且 Channel runtime 可用。 */
  isReady(): boolean;
  /** 读取当前 owner 的本地消息历史；指定对端时只读该会话。 */
  listMessages(input?: { peerPublicKeyHex?: string; limit?: number; afterMessageId?: string }): Promise<MessageRecord[]>;
  /** 每个会话返回最新一条消息，供消息首页聚合。 */
  listConversationMessages(): Promise<MessageRecord[]>;
  /** 读取当前 owner 的本地单条消息。 */
  getMessage(messageId: string): Promise<MessageRecord | null>;
  /** 发送一条文本私信，并把出站证据写入本地。 */
  sendTextMessage(input: {
    recipientPublicKeyHex: string;
    body: string;
    contentType?: MessageContentType;
    clientMessageId?: string;
  }): Promise<void>;
  /** 订阅收到或发送成功的本地消息。 */
  subscribeMessages(handler: (message: MessageRecord) => void): () => void;
  /** 订阅本地历史变化。 */
  subscribeChanges(handler: () => void): () => void;
  /** 订阅后台接收路径中的持久化错误。 */
  subscribeErrors?(handler: (error: unknown) => void): () => void;
  /** 释放 Channel 订阅。 */
  dispose?(): void;
}

interface MessageTextContent {
  readonly [key: string]: JSONValue;
  type: "text";
  contentType: MessageContentType;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
}

interface MessageAckContent {
  readonly [key: string]: JSONValue;
  type: "ack";
  acknowledged_message_id: string;
}

type MessagePrivateContent = MessageTextContent | MessageAckContent;

export interface MessageServiceDeps {
  channel: ChannelRuntime;
  keyspace: KeyspaceService;
  /** 绑定到 `<owner>/messages/` 的只读/追加文件句柄。 */
  files: BorrowedOwnerFileStore;
  /** Optional observer for storage failures in background receive handling. */
  onStorageError?(error: unknown): void;
}

interface OwnerOperation {
  publicKeyHex: string;
  /** keyspace generation 可选；没有该字段的测试实现仍按 owner 隔离。 */
  generation?: number;
}

interface PeerIndexEntry extends MessageIndexEntry {
  peerPublicKeyHex: string;
}

function makeClientMessageId(): string {
  return `km-msg-${crypto.randomUUID()}`;
}

function isMessageContent(value: JSONValue): value is MessagePrivateContent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, JSONValue>;
  if (record.type === "ack") {
    return typeof record.acknowledged_message_id === "string"
      && record.acknowledged_message_id.length > 0;
  }
  return record.type === "text"
    && (record.contentType === "text/plain" || record.contentType === "text/markdown")
    && typeof record.body === "string"
    && typeof record.clientMessageId === "string"
    && record.clientMessageId.length > 0
    && typeof record.createdAtMs === "number"
    && Number.isFinite(record.createdAtMs);
}

/** 构造消息 service。 */
export function createMessageService(deps: MessageServiceDeps): MessageService {
  const messageListeners = new Set<(message: MessageRecord) => void>();
  const changeListeners = new Set<() => void>();
  const errorListeners = new Set<(error: unknown) => void>();
  if (!deps.files) throw new Error("Message files binding is required");
  const repository: MessageFileRepository = createMessageFileRepository(deps.files);
  let disposed = false;

  function reportStorageError(error: unknown): void {
    const observers: Array<(error: unknown) => void> = [
      ...(deps.onStorageError ? [deps.onStorageError] : []),
      ...errorListeners
    ];
    if (observers.length === 0) {
      console.error("Message evidence persistence failed", error);
      return;
    }
    for (const observer of observers) {
      try {
        observer(error);
      } catch (observerError) {
        console.error("Message evidence observer failed", observerError, error);
      }
    }
  }

  function ownerPublicKeyHex(): string | undefined {
    return deps.keyspace.active().activePublicKeyHex?.trim().toLowerCase();
  }

  function captureOwner(): OwnerOperation | undefined {
    const active = deps.keyspace.active();
    const publicKeyHex = active.activePublicKeyHex?.trim().toLowerCase();
    return publicKeyHex ? { publicKeyHex, generation: active.generation } : undefined;
  }

  function ownerGuard(owner: OwnerOperation): () => boolean {
    return () => {
      if (disposed) return false;
      const active = deps.keyspace.active();
      return active.activePublicKeyHex?.trim().toLowerCase() === owner.publicKeyHex
        && (owner.generation === undefined || active.generation === owner.generation);
    };
  }

  function notify(message: MessageRecord): void {
    for (const listener of messageListeners) {
      try {
        listener(message);
      } catch {
        // 单个页面 listener 异常不能打断消息真值。
      }
    }
    for (const listener of changeListeners) {
      try {
        listener();
      } catch {
        // 单个资源 listener 异常不能打断消息真值。
      }
    }
  }

  function recordFromContent(input: {
    messageId: string;
    senderPublicKeyHex: string;
    recipientPublicKeyHex: string;
    content: MessageTextContent;
    insertedAtMs: number;
  }): MessageRecord {
    return {
      messageId: input.messageId,
      clientMessageId: input.content.clientMessageId,
      senderPublicKeyHex: input.senderPublicKeyHex,
      recipientPublicKeyHex: input.recipientPublicKeyHex,
      contentType: input.content.contentType,
      body: input.content.body,
      createdAtMs: input.content.createdAtMs,
      insertedAtMs: input.insertedAtMs
    };
  }

  function missingRawRecord(owner: string, entry: PeerIndexEntry): MessageRecord {
    return {
      messageId: entry.messageId,
      clientMessageId: "",
      senderPublicKeyHex: entry.kind === "sent" ? owner : entry.peerPublicKeyHex,
      recipientPublicKeyHex: entry.kind === "sent" ? entry.peerPublicKeyHex : owner,
      contentType: "text/plain",
      body: "",
      createdAtMs: entry.timestamp,
      insertedAtMs: entry.timestamp,
      rawMissing: true
    };
  }

  /** 出站签名明文只在本地解析；作者就是当前 owner。 */
  function decodeSentRaw(owner: string, entry: PeerIndexEntry, raw: Uint8Array): MessageRecord | null {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
      if (parsed.protocol !== MESSAGE_PRIVATE_PROTOCOL) return null;
      const body = parsed.body as Record<string, unknown> | undefined;
      if (!body || body.type !== "deliver" || !isMessageContent(body.content as JSONValue) || (body.content as MessagePrivateContent).type !== "text") return null;
      return recordFromContent({
        messageId: entry.messageId,
        senderPublicKeyHex: owner,
        recipientPublicKeyHex: entry.peerPublicKeyHex,
        content: body.content as MessageTextContent,
        insertedAtMs: entry.timestamp
      });
    } catch {
      return null;
    }
  }

  /** 入站信封由 Coordinator 解密验签；这里只消费结果。 */
  async function decodeReceivedRaw(owner: string, entry: PeerIndexEntry, raw: Uint8Array): Promise<MessageRecord | null> {
    const open = deps.channel.openPrivateEnvelope;
    if (!open) return null;
    try {
      const opened = await open({ envelope: raw });
      if (opened.protocol !== MESSAGE_PRIVATE_PROTOCOL) return null;
      if (!isMessageContent(opened.content) || opened.content.type !== "text") return null;
      return recordFromContent({
        messageId: opened.messageId,
        senderPublicKeyHex: opened.publisherPublicKeyHex,
        recipientPublicKeyHex: owner,
        content: opened.content,
        insertedAtMs: entry.timestamp
      });
    } catch {
      // 解不开或验签失败的历史条目按损坏处理，不影响其它消息。
      return null;
    }
  }

  async function decodeEntry(owner: string, entry: PeerIndexEntry): Promise<MessageRecord | null> {
    const raw = await repository.readRaw(entry.peerPublicKeyHex, entry.kind, entry.rawHash);
    if (!raw) return missingRawRecord(owner, entry);
    return entry.kind === "sent"
      ? decodeSentRaw(owner, entry, raw)
      : await decodeReceivedRaw(owner, entry, raw);
  }

  /** 一个会话的索引条目：按 messageId 去重，保留最早观察时间，最新在前。 */
  async function collectPeerEntries(peerPublicKeyHex: string): Promise<PeerIndexEntry[]> {
    const names = await repository.listIndexNames(peerPublicKeyHex);
    const byMessageId = new Map<string, PeerIndexEntry>();
    for (const name of names) {
      const entry = await repository.readIndex(peerPublicKeyHex, name);
      if (!entry) continue;
      const candidate: PeerIndexEntry = { ...entry, peerPublicKeyHex };
      const existing = byMessageId.get(entry.messageId);
      if (!existing
        || candidate.timestamp < existing.timestamp
        || (candidate.timestamp === existing.timestamp && candidate.kind === "sent" && existing.kind === "received")) {
        byMessageId.set(entry.messageId, candidate);
      }
    }
    return [...byMessageId.values()].sort((left, right) => right.timestamp - left.timestamp || right.messageId.localeCompare(left.messageId));
  }

  async function collectAllEntries(peers: readonly string[]): Promise<PeerIndexEntry[]> {
    const entries: PeerIndexEntry[] = [];
    for (const peer of peers) entries.push(...await collectPeerEntries(peer));
    entries.sort((left, right) => right.timestamp - left.timestamp || right.messageId.localeCompare(left.messageId));
    return entries;
  }

  async function appendEvidence(owner: OwnerOperation, input: {
    peerPublicKeyHex: string;
    kind: "sent" | "received";
    bytes: Uint8Array;
    timestamp: number;
    messageId: string;
  }): Promise<boolean> {
    const guard = ownerGuard(owner);
    const rawHash = input.kind === "sent"
      ? await repository.putSentRaw(input.peerPublicKeyHex, input.bytes)
      : await repository.putReceivedRaw(input.peerPublicKeyHex, input.bytes);
    if (!guard()) return false;
    await repository.appendIndex(input.peerPublicKeyHex, {
      kind: input.kind,
      timestamp: input.timestamp,
      rawHash,
      messageId: input.messageId
    });
    return guard();
  }

  async function acknowledge(event: ChannelPrivateMessageEvent, guard: () => boolean): Promise<void> {
    if (!guard()) return;
    try {
      await deps.channel.publishPrivate({
        recipientPublicKeyHex: event.publisherPublicKeyHex,
        protocol: MESSAGE_PRIVATE_PROTOCOL,
        content: {
          type: "ack",
          acknowledged_message_id: event.messageId
        }
      });
    } catch {
      // ACK 是独立的最佳努力私信；失败不回滚已经落库的消息。
    }
  }

  async function handlePrivateMessage(event: ChannelPrivateMessageEvent): Promise<void> {
    if (disposed || event.protocol !== MESSAGE_PRIVATE_PROTOCOL) return;
    const owner = captureOwner();
    if (!owner || !isMessageContent(event.content)) return;
    if (event.content.type === "ack") return;
    const guard = ownerGuard(owner);
    const insertedAtMs = Date.now();
    const record = recordFromContent({
      messageId: event.messageId,
      senderPublicKeyHex: event.publisherPublicKeyHex,
      recipientPublicKeyHex: owner.publicKeyHex,
      content: event.content,
      insertedAtMs
    });
    const rawEnvelope = event.rawEnvelope;
    if (rawEnvelope && rawEnvelope.byteLength > 0) {
      try {
        const fresh = await appendEvidence(owner, {
          peerPublicKeyHex: event.publisherPublicKeyHex,
          kind: "received",
          bytes: rawEnvelope,
          timestamp: insertedAtMs,
          messageId: event.messageId
        });
        if (!fresh) return;
      } catch (error) {
        // 证据写入失败时不通知，避免页面显示一条刷新后就消失的消息。
        reportStorageError(error);
        return;
      }
    }
    if (!guard()) return;
    notify(record);
    await acknowledge(event, guard);
  }

  const offChannel = deps.channel.subscribePrivate((event) => {
    void handlePrivateMessage(event);
  });
  const subscribeOwnerInbox = (): void => {
    const owner = ownerPublicKeyHex();
    if (!owner) return;
    void deps.channel.subscriptionSet([`bsv8.inbox.${owner}`]).catch(() => undefined);
  };
  subscribeOwnerInbox();
  const offOwnerChanged = typeof deps.keyspace.onActiveKeyChanged === "function"
    ? deps.keyspace.onActiveKeyChanged(() => subscribeOwnerInbox())
    : undefined;

  return {
    isReady: () => Boolean(!disposed && deps.channel.isReady() && ownerPublicKeyHex()),

    async listMessages(input) {
      const owner = captureOwner();
      if (!owner) throw new Error("not_ready");
      const peers = input?.peerPublicKeyHex
        ? [input.peerPublicKeyHex.trim().toLowerCase()]
        : await repository.listPeers();
      const entries = await collectAllEntries(peers);
      const afterMessageId = input?.afterMessageId;
      const start = afterMessageId ? entries.findIndex((entry) => entry.messageId === afterMessageId) + 1 : 0;
      const limit = Math.min(10_000, Math.max(0, Math.floor(input?.limit ?? 10_000)));
      const window = entries.slice(start, start + limit);
      const records: MessageRecord[] = [];
      for (const entry of window) {
        const record = await decodeEntry(owner.publicKeyHex, entry);
        if (record) records.push(record);
      }
      return records;
    },

    async listConversationMessages() {
      const owner = captureOwner();
      if (!owner) throw new Error("not_ready");
      const peers = await repository.listPeers();
      const records: MessageRecord[] = [];
      for (const peer of peers) {
        const entries = await collectPeerEntries(peer);
        if (entries.length === 0) continue;
        const record = await decodeEntry(owner.publicKeyHex, entries[0]!);
        if (record) records.push(record);
      }
      records.sort((left, right) => right.insertedAtMs - left.insertedAtMs || right.messageId.localeCompare(left.messageId));
      return records;
    },

    async getMessage(messageId) {
      const owner = captureOwner();
      if (!owner) throw new Error("not_ready");
      const peers = await repository.listPeers();
      const entries = await collectAllEntries(peers);
      const entry = entries.find((candidate) => candidate.messageId === messageId);
      if (!entry) return null;
      return await decodeEntry(owner.publicKeyHex, entry);
    },

    async sendTextMessage(input) {
      if (disposed || !deps.channel.isReady() || !ownerPublicKeyHex()) throw new Error("not_ready");
      const recipientPublicKeyHex = input.recipientPublicKeyHex.trim().toLowerCase();
      if (!/^(02|03)[0-9a-f]{64}$/.test(recipientPublicKeyHex)) {
        throw new Error("invalid_target");
      }
      if (typeof input.body !== "string" || input.body.length === 0) {
        throw new Error("empty_message");
      }
      const sender = captureOwner();
      if (!sender) throw new Error("not_ready");
      const senderGuard = ownerGuard(sender);
      const clientMessageId = input.clientMessageId ?? makeClientMessageId();
      const createdAtMs = Date.now();
      const content: MessageTextContent = {
        type: "text",
        contentType: input.contentType ?? "text/plain",
        body: input.body,
        clientMessageId,
        createdAtMs
      };
      const result = await deps.channel.publishPrivate({
        recipientPublicKeyHex,
        protocol: MESSAGE_PRIVATE_PROTOCOL,
        content: content as unknown as JSONValue
      });
      if (!senderGuard()) throw new Error("owner_changed");
      const record: MessageRecord = {
        messageId: result.messageId,
        clientMessageId,
        senderPublicKeyHex: sender.publicKeyHex,
        recipientPublicKeyHex,
        contentType: content.contentType,
        body: content.body,
        createdAtMs,
        insertedAtMs: createdAtMs
      };
      if (result.signedMessage && result.signedMessage.byteLength > 0) {
        const fresh = await appendEvidence(sender, {
          peerPublicKeyHex: recipientPublicKeyHex,
          kind: "sent",
          bytes: result.signedMessage,
          timestamp: createdAtMs,
          messageId: result.messageId
        });
        if (!fresh) throw new Error("owner_changed");
      }
      if (senderGuard()) notify(record);
    },

    subscribeMessages(handler) {
      messageListeners.add(handler);
      return () => messageListeners.delete(handler);
    },

    subscribeChanges(handler) {
      changeListeners.add(handler);
      return () => changeListeners.delete(handler);
    },

    subscribeErrors(handler) {
      errorListeners.add(handler);
      return () => errorListeners.delete(handler);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      offChannel();
      offOwnerChanged?.();
      messageListeners.clear();
      changeListeners.clear();
      errorListeners.clear();
    }
  };
}
