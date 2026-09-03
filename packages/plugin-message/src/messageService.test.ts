// 消息 service 单测：Channel 私信 + 当前 owner 本地历史。

import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import type {
  ActiveKeyState,
  ChannelPrivateMessageEvent,
  ChannelRuntime,
  KeyspaceService
} from "@keymaster/contracts";
import { MESSAGE_PRIVATE_PROTOCOL } from "@keymaster/contracts";
import { createMessageDb } from "./messageDb.js";
import { createMessageService } from "./messageService.js";

const OWNER = "02" + "aa".repeat(32);
const OTHER_OWNER = "03" + "cc".repeat(32);
const PEER = "03" + "bb".repeat(32);
let databaseSequence = 0;

interface TestKeyspace {
  keyspace: KeyspaceService;
  state: ActiveKeyState;
  databaseNameFor(ownerPublicKeyHex: string): string;
}

function keyspace(): TestKeyspace {
  const state: ActiveKeyState = { activePublicKeyHex: OWNER };
  const databaseNamePrefix = `message-service-test-${databaseSequence++}`;
  const databaseNameFor = (ownerPublicKeyHex: string) => `${databaseNamePrefix}-${ownerPublicKeyHex.toLowerCase()}`;
  const value: KeyspaceService = {
    listKeys: async () => [],
    getKey: async () => undefined,
    active: () => state,
    selected: () => OWNER,
    setActive: async () => undefined,
    requireActiveKey: () => ({ publicKeyHex: OWNER, label: "test", capabilities: [], createdAt: "now" }),
    onActiveKeyChanged: () => () => undefined,
    openKeyStorage: async (input) => new Promise((resolve, reject) => {
      const databaseName = databaseNameFor(input.publicKeyHex);
      const request = indexedDB.open(databaseName, input.version);
      request.onupgradeneeded = (event) => input.upgrade(request.result, (event as IDBVersionChangeEvent).oldVersion, input.version, request.transaction ?? undefined);
      request.onsuccess = () => resolve({ db: request.result, name: databaseName, close: () => request.result.close() });
      request.onerror = () => reject(request.error);
    }),
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
  return { keyspace: value, state, databaseNameFor };
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
    const service = createMessageService({ channel: transport.runtime, keyspace: keyspace().keyspace });
    expect(service.isReady()).toBe(true);
    service.dispose?.();
  });

  it("publishes a private message and stores only the local record", async () => {
    const transport = channel();
    const service = createMessageService({ channel: transport.runtime, keyspace: keyspace().keyspace });

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
    const service = createMessageService({ channel: transport.runtime, keyspace: keyspace().keyspace });
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
    const service = createMessageService({ channel: transport.runtime, keyspace: keyspace().keyspace });
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
    const service = createMessageService({ channel: transport.runtime, keyspace: testKeyspace.keyspace });

    const pendingSend = service.sendTextMessage({ recipientPublicKeyHex: PEER, body: "owner fenced" });
    await vi.waitFor(() => expect(transport.publishPrivate).toHaveBeenCalled());
    testKeyspace.state.activePublicKeyHex = OTHER_OWNER;
    testKeyspace.state.generation = 2;
    releasePublish({ messageId: "late-message" });

    await expect(pendingSend).rejects.toThrow("owner_changed");
    const db = createMessageDb(testKeyspace.keyspace);
    testKeyspace.state.activePublicKeyHex = OWNER;
    testKeyspace.state.generation = 1;
    await expect(db.list(OWNER)).resolves.toEqual([]);
    testKeyspace.state.activePublicKeyHex = OTHER_OWNER;
    testKeyspace.state.generation = 2;
    await expect(db.list(OTHER_OWNER)).resolves.toEqual([]);
    service.dispose?.();
  });

  it("drops an incoming message when the owner changes before the DB write", async () => {
    const testKeyspace = keyspace();
    const transport = channel();
    const service = createMessageService({ channel: transport.runtime, keyspace: testKeyspace.keyspace });
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

    await vi.waitFor(async () => expect(await createMessageDb(testKeyspace.keyspace).list(OTHER_OWNER)).toEqual([]));
    expect(transport.publishPrivate).not.toHaveBeenCalled();
    testKeyspace.state.activePublicKeyHex = OWNER;
    testKeyspace.state.generation = 1;
    await expect(createMessageDb(testKeyspace.keyspace).list(OWNER)).resolves.toEqual([]);
    service.dispose?.();
  });

  it("preserves an existing messages store while upgrading it to version 2", async () => {
    const testKeyspace = keyspace();
    const databaseName = testKeyspace.databaseNameFor(OWNER);
    const record = {
      messageId: "legacy-message",
      clientMessageId: "legacy-client",
      senderPublicKeyHex: OWNER,
      recipientPublicKeyHex: PEER,
      contentType: "text/plain",
      body: "legacy history",
      createdAtMs: 1,
      insertedAtMs: 2
    };
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("messages", { keyPath: "messageId" }).put(record);
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });

    const db = createMessageDb(testKeyspace.keyspace);
    await expect(db.list(OWNER)).resolves.toEqual([record]);
    const handle = await testKeyspace.keyspace.openKeyStorage({
      publicKeyHex: OWNER,
      pluginId: "message",
      storageId: "history",
      version: 2,
      upgrade: () => undefined
    });
    expect(handle.db.objectStoreNames.contains("messages")).toBe(true);
    expect(handle.db.transaction("messages", "readonly").objectStore("messages").indexNames.contains("insertedAtMs")).toBe(true);
    handle.close();
  });
});
