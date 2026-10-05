import { walletStateFixtureSnapshot } from "@keymaster/runtime/test-support";
// 消息 service 单测：Channel 私信 + 新 files 证据存储（sent/received/timeindex）。

import { describe, expect, it, vi } from "vitest";
import { MESSAGE_PRIVATE_PROTOCOL } from "@keymaster/contracts";
import type {
  VaultLifecycleSnapshot,
  BorrowedOwnerFileStore,
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  VaultWalletState,
  OpenedPrivateEnvelope
} from "@keymaster/contracts";
import { masterSeedHashHex } from "./storage/masterSeed.js";
import { createMessageService } from "./messageService.js";
import { createInMemoryModuleFileStore } from "@keymaster/runtime/storage";

const OWNER = "02" + "aa".repeat(32);
const PEER = "03" + "bb".repeat(32);
const OTHER = "03" + "cc".repeat(32);

function memoryFiles(): { files: BorrowedOwnerFileStore; map: Map<string, Uint8Array> } {
  const store = createInMemoryModuleFileStore();
  // 镜像只供断言与“制造 raw 缺失”使用；句柄行为仍由 in-memory store 决定。
  const map = new Map<string, Uint8Array>();
  const files: BorrowedOwnerFileStore = {
    walletGeneration: store.walletGeneration,
    sessionEpoch: store.sessionEpoch,
    runGeneration: store.runGeneration,
    list: (input) => store.list(input),
    get: (path, options) => store.get(path, options),
    getRange: (path, range, options) => store.getRange(path, range, options),
    async put(path, bytes, options) {
      map.set(path, new Uint8Array(bytes));
      return store.put(path, bytes, options);
    },
    async delete(path, options) {
      map.delete(path);
      return store.delete(path, options);
    },
    async batch(input, options) {
      for (const operation of input.operations) {
        if (operation.type === "put") map.set(operation.path, new Uint8Array(operation.bytes));
        else map.delete(operation.path);
      }
      return store.batch(input, options);
    }
  };
  return { files, map };
}

function walletState(): { walletState: VaultWalletState; state: VaultLifecycleSnapshot } {
  const state: VaultLifecycleSnapshot = walletStateFixtureSnapshot({ activePublicKeyHex: OWNER });
  const service: VaultWalletState = {
    snapshot: () => walletStateFixtureSnapshot((() => state)(), () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" })),

    subscribe: () => () => undefined
  };
  return { walletState: service, state };
}

function signedPlaintextBytes(input: {
  messageId: string;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    protocol: MESSAGE_PRIVATE_PROTOCOL,
    message_id: input.messageId,
    issued_at_ms: input.createdAtMs,
    expires_at_ms: input.createdAtMs + 60_000,
    body: {
      type: "deliver",
      content: {
        type: "text",
        contentType: "text/plain",
        body: input.body,
        clientMessageId: input.clientMessageId,
        createdAtMs: input.createdAtMs
      }
    },
    signature: "test-signature"
  }));
}

function channel(): {
  runtime: ChannelRuntime;
  published: Array<{ recipientPublicKeyHex: string; protocol: string; content: unknown }>;
  opened: Uint8Array[];
  emit: (event: ChannelPrivateMessageEvent) => void;
} {
  let handler: ((event: ChannelPrivateMessageEvent) => void) | undefined;
  const published: Array<{ recipientPublicKeyHex: string; protocol: string; content: unknown }> = [];
  const opened: Uint8Array[] = [];
  let sequence = 0;
  const nextMessageId = (): string => `A${String(++sequence).padStart(2, "0")}${"B".repeat(40)}`.slice(0, 43);
  const pendingOpen = new Map<string, OpenedPrivateEnvelope>();
  const runtime: ChannelRuntime = {
    isReady: () => true,
    publish: async () => ({ messageId: `public-${++sequence}` }),
    publishPrivate: async (input) => {
      published.push({ recipientPublicKeyHex: input.recipientPublicKeyHex, protocol: input.protocol, content: input.content });
      const messageId = nextMessageId();
      const content = input.content as { body?: string; clientMessageId?: string; createdAtMs?: number };
      const signedMessage = signedPlaintextBytes({
        messageId,
        body: content.body ?? "",
        clientMessageId: content.clientMessageId ?? "client",
        createdAtMs: content.createdAtMs ?? Date.now()
      });
      pendingOpen.set(masterSeedHashHex(signedMessage), {
        channel: `bsv8.inbox.${OWNER}`,
        protocol: MESSAGE_PRIVATE_PROTOCOL,
        messageId,
        publisherPublicKeyHex: PEER,
        issuedAtMs: content.createdAtMs ?? Date.now(),
        expiresAtMs: (content.createdAtMs ?? Date.now()) + 60_000,
        content: input.content as never
      });
      return { messageId, signedMessage };
    },
    openPrivateEnvelope: async ({ envelope }) => {
      opened.push(envelope);
      const known = pendingOpen.get(masterSeedHashHex(envelope));
      if (known) return known;
      throw new Error("OPEN_FAILED");
    },
    subscriptionSet: async (channels) => ({ channels }),
    subscriptionStatus: (value) => ({ channel: value, phase: "idle", errorCode: null, errorMessage: null, updatedAtMs: 0 }),
    subscribeSubscriptionStatus: () => () => undefined,
    subscribe: () => () => undefined,
    subscribePrivate: (next) => {
      handler = next;
      return () => { handler = undefined; };
    }
  };
  return { runtime, published, opened, emit: (event) => handler?.(event) };
}

function receivedEvent(input: {
  messageId: string;
  body: string;
  clientMessageId: string;
  createdAtMs: number;
  rawEnvelope: Uint8Array;
}): ChannelPrivateMessageEvent {
  return {
    channel: `bsv8.inbox.${OWNER}`,
    publisherPublicKeyHex: PEER,
    messageId: input.messageId,
    protocol: MESSAGE_PRIVATE_PROTOCOL,
    content: {
      type: "text",
      contentType: "text/plain",
      body: input.body,
      clientMessageId: input.clientMessageId,
      createdAtMs: input.createdAtMs
    },
    rawEnvelope: input.rawEnvelope
  };
}

function indexFiles(map: Map<string, Uint8Array>, peer: string): string[] {
  return [...map.keys()].filter((key) => key.startsWith(`${peer}/timeindex/`)).sort();
}

describe("messageService evidence storage", () => {
  it("发送后保存签名明文 raw 与时间索引，并可按会话读回", async () => {
    const { files, map } = memoryFiles();
    const c = channel();
    const k = walletState();
    const service = createMessageService({ channel: c.runtime, walletState: k.walletState, files });

    await service.sendTextMessage({ recipientPublicKeyHex: PEER, body: "你好", clientMessageId: "c-1" });
    expect(c.published).toHaveLength(1);

    const sentKeys = [...map.keys()].filter((key) => key.startsWith(`${PEER}/sent/`));
    expect(sentKeys).toHaveLength(1);
    expect(sentKeys[0]).toMatch(new RegExp(`^${PEER}/sent/[0-9a-f]{64}\\.json$`));
    const raw = map.get(sentKeys[0]!)!;
    expect(sentKeys[0]).toContain(masterSeedHashHex(raw));

    const indexKeys = indexFiles(map, PEER);
    expect(indexKeys).toHaveLength(1);
    const index = JSON.parse(new TextDecoder().decode(map.get(indexKeys[0]!)!)) as Record<string, unknown>;
    expect(index).toMatchObject({ format: "keymaster.message-index", version: 1, kind: "sent" });
    expect(index.rawHash).toBe(masterSeedHashHex(raw));

    const messages = await service.listMessages({ peerPublicKeyHex: PEER });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderPublicKeyHex: OWNER, recipientPublicKeyHex: PEER, body: "你好" });
  });

  it("收到私信后保存加密信封 raw 与时间索引，并通过 Coordinator 解码", async () => {
    const { files, map } = memoryFiles();
    const c = channel();
    const k = walletState();
    const service = createMessageService({ channel: c.runtime, walletState: k.walletState, files });

    const envelope = new TextEncoder().encode(JSON.stringify({ envelope_version: 1, ciphertext: "x" }));
    await c.runtime.publishPrivate({ recipientPublicKeyHex: OWNER, protocol: MESSAGE_PRIVATE_PROTOCOL, content: { type: "text", contentType: "text/plain", body: "自己", clientMessageId: "self", createdAtMs: 1 } });
    // 让收到的 envelope 可以被 openPrivateEnvelope 识别：复用发布 fake 的映射。
    const publishResult = await c.runtime.publishPrivate({ recipientPublicKeyHex: OWNER, protocol: MESSAGE_PRIVATE_PROTOCOL, content: { type: "text", contentType: "text/plain", body: "来自对端", clientMessageId: "c-2", createdAtMs: 5 } });
    const receivedRaw = publishResult.signedMessage!;
    void envelope;

    c.emit(receivedEvent({ messageId: publishResult.messageId, body: "来自对端", clientMessageId: "c-2", createdAtMs: 5, rawEnvelope: receivedRaw }));
    await vi.waitFor(() => expect(indexFiles(map, PEER)).toHaveLength(1));

    const receivedKeys = [...map.keys()].filter((key) => key.startsWith(`${PEER}/received/`));
    expect(receivedKeys).toHaveLength(1);
    expect(receivedKeys[0]).toContain(masterSeedHashHex(receivedRaw));

    const messages = await service.listMessages({ peerPublicKeyHex: PEER });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderPublicKeyHex: PEER, recipientPublicKeyHex: OWNER, body: "来自对端" });
    expect(c.opened).toHaveLength(1);
  });

  it("raw 缺失时索引保留并标记缺失，不伪造正文", async () => {
    const { files, map } = memoryFiles();
    const c = channel();
    const k = walletState();
    const service = createMessageService({ channel: c.runtime, walletState: k.walletState, files });
    await service.sendTextMessage({ recipientPublicKeyHex: PEER, body: "会被删", clientMessageId: "c-3" });

    // 通过句柄删除，确保底层 store 真的丢掉 raw（索引仍保留）。
    for (const key of [...map.keys()]) if (key.startsWith(`${PEER}/sent/`)) await files.delete(key);
    const messages = await service.listMessages({ peerPublicKeyHex: PEER });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ body: "", rawMissing: true, messageId: expect.any(String) });
  });

  it("重复投递同一消息只展示一条，并保留最早观察时间", async () => {
    const { files, map } = memoryFiles();
    const c = channel();
    const k = walletState();
    const service = createMessageService({ channel: c.runtime, walletState: k.walletState, files });
    const publishResult = await c.runtime.publishPrivate({ recipientPublicKeyHex: OWNER, protocol: MESSAGE_PRIVATE_PROTOCOL, content: { type: "text", contentType: "text/plain", body: "重复", clientMessageId: "c-4", createdAtMs: 7 } });
    const rawEnvelope = publishResult.signedMessage!;
    const event = receivedEvent({ messageId: publishResult.messageId, body: "重复", clientMessageId: "c-4", createdAtMs: 7, rawEnvelope });
    c.emit(event);
    await vi.waitFor(() => expect(indexFiles(map, PEER)).toHaveLength(1));
    c.emit(event);
    await vi.waitFor(() => expect(indexFiles(map, PEER)).toHaveLength(2));

    const messages = await service.listMessages({ peerPublicKeyHex: PEER });
    expect(messages).toHaveLength(1);
    const timestamps = indexFiles(map, PEER).map((key) => Number(key.split("/").pop()!.slice(0, 13)));
    expect(messages[0]!.insertedAtMs).toBe(Math.min(...timestamps));
  });

  it("发送前的参数错误不会写任何证据", async () => {
    const { files, map } = memoryFiles();
    const c = channel();
    const k = walletState();
    const service = createMessageService({ channel: c.runtime, walletState: k.walletState, files });
    await expect(service.sendTextMessage({ recipientPublicKeyHex: "bad", body: "x" })).rejects.toThrow(/invalid_target/);
    await expect(service.sendTextMessage({ recipientPublicKeyHex: OTHER, body: "" })).rejects.toThrow(/empty_message/);
    expect(map.size).toBe(0);
  });
});

it("discards a delayed message publish after the same public key is unlocked in a new epoch", async () => {
  const { files, map } = memoryFiles(); const c = channel(); const k = walletState();
  const original = c.runtime.publishPrivate.bind(c.runtime);
  let finish!: () => void;
  c.runtime.publishPrivate = async input => { await new Promise<void>(resolve => { finish = resolve; }); return original(input); };
  const service = createMessageService({ channel: c.runtime, walletState: k.walletState, files });
  const pending = service.sendTextMessage({ recipientPublicKeyHex: PEER, body: "old session", clientMessageId: "old-epoch" });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  k.state.sessionEpoch = "same-key-new-epoch";
  finish(); await expect(pending).rejects.toThrow();
  expect(map.size).toBe(0); service.dispose?.();
});
