// 消息业务 service。
//
// 消息只通过 Channel 的固定 `bsv8.message.v1` 私信协议收发；历史记录只写入
// 当前 owner 的本地 key-scoped K-V。这里不查询远端历史、不查询在线状态，也不
// 暴露 Supplier、SSP 或私钥字段。

import type {
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  JSONValue,
  KeyValueStore,
  KeyspaceService,
  MessageContentType,
  MessageRecord
} from "@keymaster/contracts";
import { MESSAGE_PRIVATE_PROTOCOL } from "@keymaster/contracts";
import { createMessageRepository, type MessageRepositoryOwnerGuard } from "./storage/messageRepository.js";

/** 消息业务插件公开的 service。 */
export interface MessageService {
  /** 当前 owner 已解锁且 Channel runtime 可用。 */
  isReady(): boolean;
  /** 读取当前 owner 的本地消息历史。 */
  listMessages(input?: { limit?: number; afterMessageId?: string }): Promise<MessageRecord[]>;
  /** 读取当前 owner 的本地单条消息。 */
  getMessage(messageId: string): Promise<MessageRecord | null>;
  /** 发送一条文本私信，并在本地落库。 */
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
  storage?: KeyValueStore;
}

/** 构造消息 service。 */
export function createMessageService(deps: MessageServiceDeps): MessageService {
  const messageListeners = new Set<(message: MessageRecord) => void>();
  const changeListeners = new Set<() => void>();
  const messageRepository = deps.storage ? createMessageRepository(deps.storage) : undefined;
  let disposed = false;

  function ownerPublicKeyHex(): string | undefined {
    return deps.keyspace.active().activePublicKeyHex?.trim().toLowerCase();
  }

  interface OwnerOperation {
    publicKeyHex: string;
    /** keyspace generation 可选；没有该字段的测试实现仍按 owner 隔离。 */
    generation?: number;
  }

  function captureOwner(): OwnerOperation | undefined {
    const active = deps.keyspace.active();
    const publicKeyHex = active.activePublicKeyHex?.trim().toLowerCase();
    return publicKeyHex ? { publicKeyHex, generation: active.generation } : undefined;
  }

  function ownerGuard(owner: OwnerOperation): MessageRepositoryOwnerGuard {
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

  async function acknowledge(event: ChannelPrivateMessageEvent, guard: MessageRepositoryOwnerGuard): Promise<void> {
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
    if (!messageRepository) return;
    const owner = captureOwner();
    if (!owner || !isMessageContent(event.content)) return;
    if (event.content.type === "ack") return;
    const guard = ownerGuard(owner);

    const record: MessageRecord = {
      messageId: event.messageId,
      clientMessageId: event.content.clientMessageId,
      senderPublicKeyHex: event.publisherPublicKeyHex,
      recipientPublicKeyHex: owner.publicKeyHex,
      contentType: event.content.contentType,
      body: event.content.body,
      createdAtMs: event.content.createdAtMs,
      insertedAtMs: Date.now()
    };
    try {
      await messageRepository.put(record, guard);
      if (!guard()) return;
      notify(record);
      await acknowledge(event, guard);
    } catch {
      // 锁定、切 key 或本地 K-V 关闭时，丢弃本次事件；不伪造成功通知。
    }
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
      if (!owner || !messageRepository) throw new Error("not_ready");
      const rows = await messageRepository.list(ownerGuard(owner));
      rows.sort((a, b) => b.insertedAtMs - a.insertedAtMs || b.messageId.localeCompare(a.messageId));
      const afterMessageId = input?.afterMessageId;
      const foundAfter = afterMessageId ? rows.findIndex((row) => row.messageId === afterMessageId) : -1;
      const start = foundAfter >= 0 ? foundAfter + 1 : 0;
      const limit = Math.min(10_000, Math.max(0, Math.floor(input?.limit ?? 10_000)));
      return rows.slice(start, start + limit);
    },

    async getMessage(messageId) {
      const owner = captureOwner();
      if (!owner || !messageRepository) throw new Error("not_ready");
      return (await messageRepository.get(messageId, ownerGuard(owner))) ?? null;
    },

    async sendTextMessage(input) {
      if (disposed || !messageRepository || !deps.channel.isReady() || !ownerPublicKeyHex()) throw new Error("not_ready");
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
        insertedAtMs: Date.now()
      };
      await messageRepository.put(record, senderGuard);
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

    dispose() {
      if (disposed) return;
      disposed = true;
      offChannel();
      offOwnerChanged?.();
      void deps.channel.subscriptionSet([]).catch(() => undefined);
      messageListeners.clear();
      changeListeners.clear();
    }
  };
}

/** 生成发送方业务幂等键。 */
function makeClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `km-msg-${crypto.randomUUID()}`;
  }
  return `km-msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
