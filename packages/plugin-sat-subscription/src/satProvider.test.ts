import { describe, expect, it, vi } from "vitest";
import { newActionResult, newPublish, parseActionResult, newRequestId } from "sat-subscription-protocol/client";
import { parseRequestEnvelope } from "sat-subscription-protocol/wire";
import { cborEncode } from "@keymaster/contracts";
import { base64urlEncode } from "bsv8-channel-protocol";
import type { MessageProviderOperations, ProviderSealedMessageRecord } from "@keymaster/contracts";
import { createSatSubscriptionState } from "./satState.js";
import { createSatSubscriptionProvider, SatSubscriptionError, SatTransportError, type SatSupplierConnection } from "./satProvider.js";

const OWNER = "02" + "11".repeat(32);
const SUPPLIER_A = "03" + "22".repeat(32);
const SUPPLIER_B = "02" + "33".repeat(32);

function connection(supplierId: string, publicKeyHex: string, requestSsp: SatSupplierConnection["requestSsp"]): SatSupplierConnection {
  return {
    supplierId,
    connectionId: `${supplierId}-connection`,
    ownerSessionEpoch: OWNER,
    supplierGeneration: 1,
    authenticatedPublicKeyHex: publicKeyHex,
    state: "online",
    requestSsp,
    requestSpi: async () => new Uint8Array(),
    subscribeSspRequests: () => () => undefined,
    close: vi.fn()
  };
}

function makeStore() {
  return createSatSubscriptionState({
    ownerPublicKeyHex: OWNER,
    initial: {
      suppliers: [
        { supplierId: "primary", name: "Primary", supplierPublicKeyHex: SUPPLIER_A, multiaddrs: ["/ip4/127.0.0.1/tcp/9000"], enabled: true },
        { supplierId: "backup", name: "Backup", supplierPublicKeyHex: SUPPLIER_B, multiaddrs: ["/ip4/127.0.0.1/tcp/9001"], enabled: true }
      ],
      ownerSettings: { ownerPublicKeyHex: OWNER, defaultPublishSupplierId: "primary", receiveSupplierIds: [] }
    }
  });
}

describe("SatSubscriptionProvider", () => {
  it("declares no remote history/online query and publishes through only the default supplier", async () => {
    const store = makeStore();
    const primary = vi.fn(async (wire: Uint8Array) => {
      const requestId = parseRequestEnvelope(wire).requestId;
      return newActionResult({ requestId, success: true, chargedAmount: "0.000000000000000001", errorCode: "" });
    });
    const backup = vi.fn(async (wire: Uint8Array) => {
      const requestId = parseRequestEnvelope(wire).requestId;
      return newActionResult({ requestId, success: true, chargedAmount: "0", errorCode: "" });
    });
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      channelCrypto: {} as never,
      transport: { connect: async ({ supplier }) => connection(supplier.supplierId, supplier.supplierPublicKeyHex, supplier.supplierId === "primary" ? primary : backup) }
    });
    expect(provider.features).toEqual({ remoteHistory: false, onlineQuery: false, deliveryAck: true });
    await provider.bind({ signer: { publicKeyHex: OWNER, signChallenge: async () => "" } });
    const service = provider.service()!;
    await expect(service.publish({ channel: "topic", contentJson: new TextEncoder().encode("{}") })).resolves.toMatchObject({ chargedAmount: "0.000000000000000001" });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
    await expect(provider.checkOnline({ publicKeyHexes: [OWNER] })).resolves.toEqual({ [OWNER]: "unknown" });
  });

  it("fails closed on default transport uncertainty without switching suppliers", async () => {
    const store = makeStore();
    const primary = vi.fn(async () => { throw new SatTransportError("connection lost", { sentBoundary: "unknown" }); });
    const backup = vi.fn(async (wire: Uint8Array) => {
      const requestId = parseRequestEnvelope(wire).requestId;
      return newActionResult({ requestId, success: true, chargedAmount: "0", errorCode: "" });
    });
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      channelCrypto: {} as never,
      transport: { connect: async ({ supplier }) => connection(supplier.supplierId, supplier.supplierPublicKeyHex, supplier.supplierId === "primary" ? primary : backup) }
    });
    await provider.bind({ signer: { publicKeyHex: OWNER, signChallenge: async () => "" } });
    await expect(provider.service()!.publish({ channel: "topic", contentJson: new TextEncoder().encode("{}") })).rejects.toMatchObject({ code: "unknown_result" });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
    expect(store.listFeeAudit().at(-1)).toMatchObject({ result: "unknown_result", errorCode: "unknown_result" });
  });

  it("rejects an authenticated Supplier identity that does not match the pin", async () => {
    const store = makeStore();
    await store.deleteSupplier("backup");
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      channelCrypto: {} as never,
      transport: { connect: async ({ supplier }) => connection(supplier.supplierId, supplier.supplierId === "primary" ? SUPPLIER_B : supplier.supplierPublicKeyHex, async () => new Uint8Array()) }
    });
    await provider.bind({ signer: { publicKeyHex: OWNER, signChallenge: async () => "" } });
    expect(provider.health().isHealthy).toBe(false);
    expect(provider.health().lastError).toContain("pin");
  });

  it("keeps remote list/get unavailable instead of returning fake empty history", async () => {
    const store = makeStore();
    const provider = createSatSubscriptionProvider({ stateForOwner: async () => store, channelCrypto: {} as never, transport: { connect: async ({ supplier }) => connection(supplier.supplierId, supplier.supplierPublicKeyHex, async () => new Uint8Array()) } });
    const handle = await provider.bind({ signer: { publicKeyHex: OWNER, signChallenge: async () => "" } });
    await expect((handle as unknown as { listMessages(): Promise<unknown> }).listMessages()).rejects.toMatchObject({ code: "unavailable" });
    await provider.shutdown();
    await provider.shutdown();
    expect(provider.health().isHealthy).toBe(false);
  });

  it("returns an ActionResult for inbound Publish and separates duplicate delivery from AppMsg events", async () => {
    const store = makeStore();
    await store.setOwnerSettings({ ownerPublicKeyHex: OWNER, defaultPublishSupplierId: "primary", receiveSupplierIds: ["primary", "backup"] });
    const messageId = "A".repeat(43);
    const envelopeBytes = cborEncode([
      1,
      hexToBytes(OWNER),
      1,
      "https://sender.example:443",
      hexToBytes(OWNER),
      1,
      "https://recipient.example:443",
      "client-1",
      1,
      1,
      new Uint8Array(12),
      new Uint8Array([1])
    ]);
    const appMsgContent = new TextEncoder().encode(JSON.stringify({
      version: 1,
      envelopeBase64Url: base64urlEncode(envelopeBytes),
      signatureBase64Url: base64urlEncode(new Uint8Array(64))
    }));
    const opened = {
      channel: `bsv8.inbox.${OWNER}`,
      fromPublicKeyHex: OWNER,
      toPublicKeyHex: OWNER,
      messageIdBase64Url: messageId,
      signedDigestHex: "aa".repeat(32),
      protocol: "bsv8.message.v1",
      bodyType: "deliver" as const,
      contentJson: appMsgContent,
      issuedAtMs: 1,
      expiresAtMs: 2
    };
    const handlers = new Map<string, (wire: Uint8Array) => Promise<Uint8Array>>();
    const ackRequests: Uint8Array[] = [];
    const ackRequestsBySupplier = new Map<string, Uint8Array[]>();
    let earlyResponse: Promise<Uint8Array> | undefined;
    const channelCrypto = {
      open: vi.fn(async () => opened),
      sealAck: vi.fn(async () => ({
        channel: "bsv8.inbox." + OWNER,
        messageIdBase64Url: "B".repeat(43),
        envelopeJson: new TextEncoder().encode("{}"),
        fromPublicKeyHex: OWNER,
        expiresAtMs: 3
      }))
    };
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      channelCrypto: channelCrypto as never,
      transport: {
        connect: async ({ supplier, ownerSessionEpoch, supplierGeneration, onSspRequest }) => {
          // 模拟 adapter 在 connect 返回前已经收到并缓存了第一条 Publish。
          if (supplier.supplierId === "primary") {
            earlyResponse = onSspRequest?.(newPublish(newRequestId(), opened.channel, opened.contentJson));
          }
          return {
          supplierId: supplier.supplierId,
          connectionId: `${supplier.supplierId}-connection`,
          ownerSessionEpoch,
          supplierGeneration,
          authenticatedPublicKeyHex: supplier.supplierPublicKeyHex,
          state: "online" as const,
          requestSsp: async (wire: Uint8Array) => {
            ackRequests.push(wire.slice());
            const requests = ackRequestsBySupplier.get(supplier.supplierId) ?? [];
            requests.push(wire.slice());
            ackRequestsBySupplier.set(supplier.supplierId, requests);
            return newActionResult({ requestId: parseRequestEnvelope(wire).requestId, success: true, chargedAmount: "0", errorCode: "" });
          },
          requestSpi: async () => new Uint8Array(),
          subscribeSspRequests: (handler: (wire: Uint8Array) => Promise<Uint8Array>) => {
            handlers.set(supplier.supplierId, handler);
            return () => handlers.delete(supplier.supplierId);
          },
          close: vi.fn()
          };
        }
      }
    });
    const handle = await provider.bind({ signer: { publicKeyHex: OWNER, signChallenge: async () => "" } }) as MessageProviderOperations;
    const receivedRecords: ProviderSealedMessageRecord[] = [];
    const records: Array<{ messageId: string; ingressSupplierId?: string; deliveryRelation?: string }> = [];
    handle.subscribeMessages((record) => {
      receivedRecords.push(record);
      records.push({ messageId: record.messageId, ingressSupplierId: record.ingressSupplierId, deliveryRelation: record.deliveryRelation });
    });

    // 第一条请求在 bind 返回前到达，provider 必须缓存业务投影并仍返回 ActionResult。
    const first = await earlyResponse!;
    const duplicate = await handlers.get("backup")!(newPublish(newRequestId(), opened.channel, opened.contentJson));
    expect(parseActionResult(first).success).toBe(true);
    expect(parseActionResult(duplicate).success).toBe(true);
    expect(records).toEqual([
      { messageId, ingressSupplierId: "primary", deliveryRelation: "new" },
      { messageId, ingressSupplierId: "backup", deliveryRelation: "duplicate" }
    ]);
    expect(store.getChannel(`bsv8.message.v1\u0000${OWNER}\u0000${messageId}`)?.ingressSupplierId).toBe("primary");
    const firstRecord = receivedRecords[0]!;
    await expect(handle.ackMessage!({ ...firstRecord, senderPublicKeyHex: SUPPLIER_B })).rejects.toMatchObject({ code: "conflict" });
    await expect(handle.ackMessage!({ ...firstRecord, messageId: "Z".repeat(43) })).rejects.toMatchObject({ code: "conflict" });
    const firstClaim = {
      deliveryId: firstRecord.deliveryId!,
      supplierId: firstRecord.ingressSupplierId!,
      ackClaimToken: firstRecord.ackClaimToken!,
    };
    await Promise.all([
      handle.ackMessage!(firstClaim),
      handle.ackMessage!(firstClaim),
    ]);
    expect(ackRequests).toHaveLength(1);
    // Duplicate ingress 仍要 ACK 原路；它携带自己的 deliveryId/claim，
    // 不能读取第一条记录可变的 ingressSupplierId。
    await handle.ackMessage!(receivedRecords[1]!);
    expect(ackRequestsBySupplier.get("primary")).toHaveLength(1);
    expect(ackRequestsBySupplier.get("backup")).toHaveLength(1);
  });

  it("rejects the 65th inbound delivery when no subscriber is attached", async () => {
    const store = makeStore();
    await store.setOwnerSettings({ ownerPublicKeyHex: OWNER, defaultPublishSupplierId: "primary", receiveSupplierIds: ["primary"] });
    const messageId = "C".repeat(43);
    const envelopeBytes = cborEncode([
      1,
      hexToBytes(OWNER),
      1,
      "https://sender.example:443",
      hexToBytes(OWNER),
      1,
      "https://recipient.example:443",
      "queue-test",
      1,
      1,
      new Uint8Array(12),
      new Uint8Array([1])
    ]);
    const contentJson = new TextEncoder().encode(JSON.stringify({
      version: 1,
      envelopeBase64Url: base64urlEncode(envelopeBytes),
      signatureBase64Url: base64urlEncode(new Uint8Array(64))
    }));
    const opened = {
      channel: "bsv8.inbox." + OWNER,
      fromPublicKeyHex: OWNER,
      toPublicKeyHex: OWNER,
      messageIdBase64Url: messageId,
      signedDigestHex: "bb".repeat(32),
      protocol: "bsv8.message.v1",
      bodyType: "deliver" as const,
      contentJson,
      issuedAtMs: 1,
      expiresAtMs: 2
    };
    const channelCrypto = { open: vi.fn(async () => opened) };
    let inboundHandler!: (wire: Uint8Array) => Promise<Uint8Array>;
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      channelCrypto: channelCrypto as never,
      transport: {
        connect: async ({ supplier }) => {
          const base = connection(supplier.supplierId, supplier.supplierPublicKeyHex, async (wire) => newActionResult({
            requestId: parseRequestEnvelope(wire).requestId,
            success: true,
            chargedAmount: "0",
            errorCode: ""
          }));
          if (supplier.supplierId !== "primary") return base;
          return {
            ...base,
            subscribeSspRequests: (handler: (wire: Uint8Array) => Promise<Uint8Array>) => {
              inboundHandler = handler;
              return () => undefined;
            }
          };
        }
      }
    });
    const handle = await provider.bind({ signer: { publicKeyHex: OWNER, signChallenge: async () => "" } }) as MessageProviderOperations;

    // 并发进入时也必须先原子预占 queue slot；不能让 65 个 handler
    // 共同观察到“尚有空位”后再静默丢弃。
    const responses = await Promise.all(
      Array.from({ length: 65 }, () => inboundHandler(newPublish(newRequestId(), opened.channel, contentJson)))
    );
    expect(responses.slice(0, 64).every((wire) => parseActionResult(wire).success)).toBe(true);
    expect(parseActionResult(responses[64]!).success).toBe(false);
    expect(parseActionResult(responses[64]!).errorCode).toBe("INVALID_REQUEST");

    // 解除 pending queue 后，未 ACK 的 active claim 仍必须受独立硬上限保护。
    handle.subscribeMessages(() => undefined);
    const claimTableFull = await inboundHandler(newPublish(newRequestId(), opened.channel, contentJson));
    expect(parseActionResult(claimTableFull).success).toBe(false);
    expect(parseActionResult(claimTableFull).errorCode).toBe("INVALID_REQUEST");
  });
});

function hexToBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index += 1) output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}
