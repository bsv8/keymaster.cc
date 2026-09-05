// 消息 service 单测：Channel 私信 + 当前 owner 本地历史。

import { describe, expect, it, vi } from "vitest";
import type {
  ActiveKeyState,
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  OwnerAppStore,
  KeyspaceService
} from "@keymaster/contracts";
import { MESSAGE_PRIVATE_PROTOCOL } from "@keymaster/contracts";
import { createInMemoryKeyValueStore } from "@keymaster/runtime";
import { createMessageRepository } from "./storage/messageRepository.js";
import { createMessageService } from "./messageService.js";

const OWNER = "02" + "aa".repeat(32);
const OTHER_OWNER = "03" + "cc".repeat(32);
const PEER = "03" + "bb".repeat(32);
interface TestKeyspace {
  keyspace: KeyspaceService;
  state: ActiveKeyState;
  stores: Map<string, OwnerAppStore>;
}

function keyspace(): TestKeyspace {
  const state: ActiveKeyState = { activePublicKeyHex: OWNER };
  const stores = new Map<string, OwnerAppStore>();
  stores.set(OWNER, createInMemoryKeyValueStore({ scope: "key", ownerPublicKeyHex: OWNER, applicationStorageId: "Messages", schemaVersion: 1, bucketId: "test", bucketGeneration: 1 }) as OwnerAppStore);
  const value: KeyspaceService = {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => state,
    selected: () => OWNER,
    setActive: async () => undefined,
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined,
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
  return { keyspace: value, state, stores };
}

function channel(input: {
  publishPrivate?: (value: Parameters<ChannelRuntime["publishPrivate"]>[0]) => Promise<{ messageId: string }>;
} = {}): {
  runtime: ChannelRuntime;
  publishPrivate: ReturnType<typeof vi.fn>;
  emit: (event: ChannelPrivateMessageEvent) => void;
} {
  let privateHandler: ((event: ChannelPrivateMessageEvent) => void) | undefined;
  let sequence = 0;
  const publishPrivate = vi.fn(input.publishPrivate ?? (async () => ({ messageId: `message-${++sequence}` })));
  const runtime: ChannelRuntime = {
    isReady: () => true,
    publish: async () => ({ messageId: `public-${++sequence}` }),
    publishPrivate,
    subscriptionSet: async (channels) => ({ channels }),
    subscribe: () => () => undefined,
    subscribePrivate: (handler) => {
      privateHandler = handler;
      return () => { privateHandler = undefined; };
    }
  };
  return { runtime, publishPrivate, emit: (event) => privateHandler?.(event) };
}

describe("createMessageService", () => {
  it("reports readiness from the owner-scoped Channel runtime", () => {
    const transport = channel();
    const fixture = keyspace();
    const service = createMessageService({ channel: transport.runtime, keyspace: fixture.keyspace, storage: fixture.stores.get(OWNER) });
    expect(service.isReady()).toBe(true);
    service.dispose?.();
  });

  it("publishes a private message and stores only the local record", async () => {
    const transport = channel();
    const fixture = keyspace();
    const service = createMessageService({ channel: transport.runtime, keyspace: fixture.keyspace, storage: fixture.stores.get(OWNER) });

    await service.sendTextMessage({ recipientPublicKeyHex: PEER, body: "hello" });

    expect(transport.publishPrivate).toHaveBeenCalledWith(expect.objectContaining({
      recipientPublicKeyHex: PEER,
      protocol: MESSAGE_PRIVATE_PROTOCOL,
      content: expect.objectContaining({ type: "text", body: "hello" })
    }));
    await expect(service.listMessages()).resolves.toEqual([
      expect.objectContaining({ senderPublicKeyHex: OWNER, recipientPublicKeyHex: PEER, body: "hello" })
    ]);
    service.dispose?.();
  });

  it("persists a valid incoming message and sends an independent ACK", async () => {
    const transport = channel();
    const fixture = keyspace();
    const service = createMessageService({ channel: transport.runtime, keyspace: fixture.keyspace, storage: fixture.stores.get(OWNER) });
    transport.emit({
      channel: `bsv8.inbox.${OWNER}`,
      publisherPublicKeyHex: PEER,
      messageId: "incoming-1",
      protocol: MESSAGE_PRIVATE_PROTOCOL,
      content: {
        type: "text",
        contentType: "text/plain",
        body: "hello back",
        clientMessageId: "client-1",
        createdAtMs: 123
      }
    });

    await vi.waitFor(async () => expect(await service.listMessages()).toHaveLength(1));
    expect(transport.publishPrivate).toHaveBeenCalledWith({
      recipientPublicKeyHex: PEER,
      protocol: MESSAGE_PRIVATE_PROTOCOL,
      content: { type: "ack", acknowledged_message_id: "incoming-1" }
    });
    service.dispose?.();
  });

  it("rejects an invalid target before publishing", async () => {
    const transport = channel();
    const fixture = keyspace();
    const service = createMessageService({ channel: transport.runtime, keyspace: fixture.keyspace, storage: fixture.stores.get(OWNER) });
    await expect(service.sendTextMessage({ recipientPublicKeyHex: "not-a-public-key", body: "hello" }))
      .rejects.toThrow("invalid_target");
    expect(transport.publishPrivate).not.toHaveBeenCalled();
    service.dispose?.();
  });

  it("does not write a send that completes after the owner session changes", async () => {
    const testKeyspace = keyspace();
    let releasePublish!: (value: { messageId: string }) => void;
    const publishGate = new Promise<{ messageId: string }>((resolve) => { releasePublish = resolve; });
    const transport = channel({ publishPrivate: async () => publishGate });
    const service = createMessageService({ channel: transport.runtime, keyspace: testKeyspace.keyspace, storage: testKeyspace.stores.get(OWNER) });

    const pendingSend = service.sendTextMessage({ recipientPublicKeyHex: PEER, body: "owner fenced" });
    await vi.waitFor(() => expect(transport.publishPrivate).toHaveBeenCalled());
    testKeyspace.state.activePublicKeyHex = OTHER_OWNER;
    testKeyspace.state.generation = 2;
    releasePublish({ messageId: "late-message" });

    await expect(pendingSend).rejects.toThrow("owner_changed");
    const db = createMessageRepository(testKeyspace.stores.get(OWNER)!);
    testKeyspace.state.activePublicKeyHex = OWNER;
    testKeyspace.state.generation = 1;
    await expect(db.list()).resolves.toEqual([]);
    testKeyspace.state.activePublicKeyHex = OTHER_OWNER;
    testKeyspace.state.generation = 2;
    await expect(db.list()).resolves.toEqual([]);
    service.dispose?.();
  });

  it("drops an incoming message when the owner changes before the DB write", async () => {
    const testKeyspace = keyspace();
    const transport = channel();
    const service = createMessageService({ channel: transport.runtime, keyspace: testKeyspace.keyspace, storage: testKeyspace.stores.get(OWNER) });
    transport.emit({
      channel: `bsv8.inbox.${OWNER}`,
      publisherPublicKeyHex: PEER,
      messageId: "incoming-owner-switch",
      protocol: MESSAGE_PRIVATE_PROTOCOL,
      content: {
        type: "text",
        contentType: "text/plain",
        body: "must not cross owner",
        clientMessageId: "client-owner-switch",
        createdAtMs: 123
      }
    });
    testKeyspace.state.activePublicKeyHex = OTHER_OWNER;
    testKeyspace.state.generation = 2;

    await vi.waitFor(async () => expect(await createMessageRepository(testKeyspace.stores.get(OWNER)!).list()).toEqual([]));
    expect(transport.publishPrivate).not.toHaveBeenCalled();
    testKeyspace.state.activePublicKeyHex = OWNER;
    testKeyspace.state.generation = 1;
    await expect(createMessageRepository(testKeyspace.stores.get(OWNER)!).list()).resolves.toEqual([]);
    service.dispose?.();
  });

  it("writes message history as owner K-V records", async () => {
    const testKeyspace = keyspace();
    const transport = channel();
    const service = createMessageService({ channel: transport.runtime, keyspace: testKeyspace.keyspace, storage: testKeyspace.stores.get(OWNER) });
    await service.sendTextMessage({ recipientPublicKeyHex: PEER, body: "stored in K-V" });
    const entries = await testKeyspace.stores.get(OWNER)!.list({ partition: "messages", prefix: "message/" });
    expect(entries.entries).toHaveLength(1);
    expect(entries.entries[0]?.value).toEqual(expect.objectContaining({ body: "stored in K-V" }));
    service.dispose?.();
  });
});
