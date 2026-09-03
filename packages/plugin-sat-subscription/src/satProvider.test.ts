import { describe, expect, it, vi } from "vitest";
import {
  newActionResult,
  newPublish,
  newRequestId,
  newSubscriptionsResponse,
  parseActionResult
} from "sat-subscription-protocol/client";
import { Kind } from "sat-subscription-protocol/protocol";
import { decodeRequest, parseRequestEnvelope } from "sat-subscription-protocol/wire";
import type { SatIncomingPublish } from "@keymaster/contracts";
import { createSatSubscriptionState } from "./satState.js";
import {
  createSatSubscriptionProvider,
  SatSubscriptionError,
  SatTransportError,
  type SatSupplierConnection
} from "./satProvider.js";

const OWNER = "02" + "11".repeat(32);
const SUPPLIER_A = "03" + "22".repeat(32);
const SUPPLIER_B = "02" + "33".repeat(32);

function connection(
  supplierId: string,
  publicKeyHex: string,
  requestSsp: SatSupplierConnection["requestSsp"],
  onSubscribe: (handler: (wire: Uint8Array) => Promise<Uint8Array>) => void,
  supplierGeneration = 1
): SatSupplierConnection {
  return {
    supplierId,
    connectionId: `${supplierId}-connection`,
    ownerSessionEpoch: OWNER,
    supplierGeneration,
    authenticatedPublicKeyHex: publicKeyHex,
    state: "online",
    requestSsp,
    requestSpi: async () => new Uint8Array(),
    subscribeSspRequests: (handler) => {
      onSubscribe(handler);
      return () => undefined;
    },
    close: vi.fn()
  };
}

function makeStore(
  receiveSupplierIds: string[] = [],
  subscriptions: Array<{
    supplierId: string;
    channel: string;
    desired: "unknown" | "subscribing" | "subscribed" | "unsubscribing" | "unsubscribed" | "unknown_result";
    observed: "unknown" | "subscribing" | "subscribed" | "unsubscribing" | "unsubscribed" | "unknown_result";
    observedAtMs: number;
    observedSource: "action" | "refresh" | "none";
    errorCode: null;
  }> = []
): ReturnType<typeof createSatSubscriptionState> {
  return createSatSubscriptionState({
    ownerPublicKeyHex: OWNER,
    initial: {
      suppliers: [
        { supplierId: "primary", name: "Primary", supplierPublicKeyHex: SUPPLIER_A, multiaddrs: ["/ip4/127.0.0.1/tcp/9000"], enabled: true },
        { supplierId: "backup", name: "Backup", supplierPublicKeyHex: SUPPLIER_B, multiaddrs: ["/ip4/127.0.0.1/tcp/9001"], enabled: true }
      ],
      ownerSettings: {
        ownerPublicKeyHex: OWNER,
        defaultPublishSupplierId: "primary",
        receiveSupplierIds
      },
      subscriptions
    }
  });
}

describe("SatSubscriptionProvider", () => {
  it("publishes through the configured default Supplier", async () => {
    const store = makeStore();
    const primary = vi.fn(async (wire: Uint8Array) => newActionResult({
      requestId: parseRequestEnvelope(wire).requestId,
      success: true,
      chargedAmount: "0",
      errorCode: ""
    }));
    const backup = vi.fn(async () => new Uint8Array());
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest }) => connection(
          supplier.supplierId,
          supplier.supplierPublicKeyHex,
          supplier.supplierId === "primary" ? primary : backup,
          (handler) => { void onSspRequest; void handler; }
        )
      }
    });

    await provider.bind({ ownerPublicKeyHex: OWNER });
    const service = provider.service();
    if (!service) throw new Error("expected Sat service");
    await expect(service.publish({ channel: "topic", contentJson: new TextEncoder().encode("{}") }))
      .resolves.toMatchObject({ chargedAmount: "0" });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(backup).not.toHaveBeenCalled();
    await provider.shutdown();
  });

  it("maps the single physical Channel subscription to every configured receive Supplier", async () => {
    const store = makeStore(["primary", "backup"]);
    const requests = new Map<string, ReturnType<typeof vi.fn>>();
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest, supplierGeneration }) => {
          const request = vi.fn(async (wire: Uint8Array) => newActionResult({
            requestId: parseRequestEnvelope(wire).requestId,
            success: true,
            chargedAmount: "0",
            errorCode: ""
          }));
          requests.set(supplier.supplierId, request);
          return connection(supplier.supplierId, supplier.supplierPublicKeyHex, request, (handler) => { void onSspRequest; void handler; }, supplierGeneration);
        }
      }
    });
    const handle = await provider.bind({ ownerPublicKeyHex: OWNER });
    const service = provider.service();
    if (!service) throw new Error("expected Sat service");
    await handle.subscribePhysical(`bsv8.inbox.${OWNER}`);
    await handle.unsubscribePhysical(`bsv8.inbox.${OWNER}`);
    expect(requests.get("primary")).toHaveBeenCalledTimes(2);
    expect(requests.get("backup")).toHaveBeenCalledTimes(2);
    await provider.shutdown();
  });

  it("keeps successful Supplier/channel triples settled when another Supplier partially fails", async () => {
    const store = makeStore(["primary", "backup"]);
    const subscribeCalls = new Map<string, number>();
    const refreshCalls = new Map<string, number>();
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest }) => {
          const request = vi.fn(async (wire: Uint8Array) => {
            const envelope = parseRequestEnvelope(wire);
            if (envelope.message.kind === Kind.SubscriptionsRequest) {
              refreshCalls.set(supplier.supplierId, (refreshCalls.get(supplier.supplierId) ?? 0) + 1);
              return newSubscriptionsResponse({ requestId: envelope.requestId, chargedAmount: "0", channels: [] });
            }
            if (envelope.message.kind === Kind.Subscribe) {
              const count = (subscribeCalls.get(supplier.supplierId) ?? 0) + 1;
              subscribeCalls.set(supplier.supplierId, count);
              if (supplier.supplierId === "backup" && count === 1) {
                throw new SatTransportError("backup request was not sent", { sentBoundary: "not-sent" });
              }
            }
            return newActionResult({
              requestId: envelope.requestId,
              success: true,
              chargedAmount: "1",
              errorCode: ""
            });
          });
          return connection(supplier.supplierId, supplier.supplierPublicKeyHex, request, (handler) => { void onSspRequest; void handler; });
        }
      }
    });
    const handle = await provider.bind({ ownerPublicKeyHex: OWNER });
    const service = provider.service();
    if (!service) throw new Error("expected Sat service");

    await expect(handle.subscribePhysical("topic")).rejects.toBeInstanceOf(SatSubscriptionError);
    await expect(handle.subscribePhysical("topic")).resolves.toBeUndefined();

    expect(subscribeCalls.get("primary")).toBe(1);
    expect(subscribeCalls.get("backup")).toBe(2);
    expect(refreshCalls.get("backup")).toBe(1);
    const chargedSubscriptions = store.listFeeAudit().filter((item) => item.action === "subscribe" && item.chargedAmount === "1");
    expect(chargedSubscriptions.map((item) => item.supplierId).sort()).toEqual(["backup", "primary"]);
    await provider.shutdown();
  });

  it("queries remote state before retrying an unknown subscription result", async () => {
    const store = makeStore(["primary"]);
    let subscribeCalls = 0;
    let refreshCalls = 0;
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest }) => {
          const request = vi.fn(async (wire: Uint8Array) => {
            const envelope = parseRequestEnvelope(wire);
            if (envelope.message.kind === Kind.Subscribe) {
              subscribeCalls += 1;
              if (subscribeCalls === 1) throw new SatTransportError("response lost", { sentBoundary: "unknown" });
            }
            if (envelope.message.kind === Kind.SubscriptionsRequest) {
              refreshCalls += 1;
              return newSubscriptionsResponse({ requestId: envelope.requestId, chargedAmount: "0", channels: ["topic"] });
            }
            return newActionResult({ requestId: envelope.requestId, success: true, chargedAmount: "1", errorCode: "" });
          });
          return connection(supplier.supplierId, supplier.supplierPublicKeyHex, request, (handler) => { void onSspRequest; void handler; });
        }
      }
    });
    const handle = await provider.bind({ ownerPublicKeyHex: OWNER });
    const service = provider.service();
    if (!service) throw new Error("expected Sat service");

    await expect(handle.subscribePhysical("topic")).rejects.toMatchObject({ code: "unknown_result" });
    await expect(handle.subscribePhysical("topic")).resolves.toBeUndefined();

    expect(subscribeCalls).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(store.listFeeAudit().filter((item) => item.action === "subscribe")).toHaveLength(1);
    expect(store.listSubscriptions("primary")[0]).toMatchObject({ desired: "subscribed", observed: "subscribed" });
    await provider.shutdown();
  });

  it("reconnects a Supplier after a connection state failure without configuration changes", async () => {
    const store = makeStore(["primary"]);
    const backup = store.getSupplier("backup");
    if (!backup) throw new Error("expected backup Supplier");
    await store.upsertSupplier({ ...backup, enabled: false });
    let connectionCount = 0;
    let refreshCount = 0;
    let notifyState: ((state: "online" | "degraded" | "closed") => void) | undefined;
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest, supplierGeneration }) => {
          connectionCount += 1;
          const connectionId = `${supplier.supplierId}-connection-${connectionCount}`;
          const request = vi.fn(async (wire: Uint8Array) => {
            const envelope = parseRequestEnvelope(wire);
            if (envelope.message.kind === Kind.SubscriptionsRequest) {
              refreshCount += 1;
              return newSubscriptionsResponse({ requestId: envelope.requestId, chargedAmount: "0", channels: [] });
            }
            return newActionResult({ requestId: envelope.requestId, success: true, chargedAmount: "0", errorCode: "" });
          });
          const active = connection(
            supplier.supplierId,
            supplier.supplierPublicKeyHex,
            request,
            (handler) => { void onSspRequest; void handler; },
            supplierGeneration
          );
          return {
            ...active,
            connectionId,
            onStateChange: (handler: (state: "online" | "degraded" | "closed") => void) => {
              notifyState = handler;
              return () => {
                if (notifyState === handler) notifyState = undefined;
              };
            }
          };
        }
      }
    });

    await provider.bind({ ownerPublicKeyHex: OWNER });
    expect(connectionCount).toBe(1);
    notifyState?.("degraded");

    await vi.waitFor(() => expect(connectionCount).toBe(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(refreshCount).toBe(1), { timeout: 2_000 });
    await provider.shutdown();
  });

  it("独立重试重连后的订阅刷新与物理收敛", async () => {
    const store = makeStore(["primary"]);
    const backup = store.getSupplier("backup");
    if (!backup) throw new Error("expected backup Supplier");
    await store.upsertSupplier({ ...backup, enabled: false });
    let connectionCount = 0;
    let refreshCount = 0;
    let subscribeCount = 0;
    let notifyState: ((state: "online" | "degraded" | "closed") => void) | undefined;
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest, supplierGeneration }) => {
          connectionCount += 1;
          const connectionId = `${supplier.supplierId}-reconcile-${connectionCount}`;
          const request = vi.fn(async (wire: Uint8Array) => {
            const envelope = parseRequestEnvelope(wire);
            if (envelope.message.kind === Kind.SubscriptionsRequest) {
              refreshCount += 1;
              // 重连后的第一次 refresh 故意失败，验证“在线但未收敛”
              // 会单独重试。
              if (refreshCount === 1) throw new SatTransportError("refresh temporarily unavailable", { sentBoundary: "unknown" });
              return newSubscriptionsResponse({ requestId: envelope.requestId, chargedAmount: "0", channels: [] });
            }
            if (envelope.message.kind === Kind.Subscribe) subscribeCount += 1;
            return newActionResult({ requestId: envelope.requestId, success: true, chargedAmount: "0", errorCode: "" });
          });
          const active = connection(
            supplier.supplierId,
            supplier.supplierPublicKeyHex,
            request,
            (handler) => { void onSspRequest; void handler; },
            supplierGeneration
          );
          return {
            ...active,
            connectionId,
            onStateChange: (handler: (state: "online" | "degraded" | "closed") => void) => {
              notifyState = handler;
              return () => {
                if (notifyState === handler) notifyState = undefined;
              };
            }
          };
        }
      }
    });

    const handle = await provider.bind({ ownerPublicKeyHex: OWNER });
    await handle.subscribePhysical("topic");
    expect(refreshCount).toBe(0);
    expect(subscribeCount).toBe(1);
    notifyState?.("degraded");

    await vi.waitFor(() => expect(connectionCount).toBe(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(refreshCount).toBeGreaterThanOrEqual(2), { timeout: 4_000 });
    await vi.waitFor(() => expect(subscribeCount).toBe(2), { timeout: 4_000 });
    await provider.shutdown();
  });

  it("Worker 重启时不恢复旧 App 订阅，只在新 Mux 集合到达后清理历史证据", async () => {
    const store = makeStore(["primary"], [{
      supplierId: "primary",
      channel: "old-app-topic",
      desired: "subscribed",
      observed: "subscribed",
      observedAtMs: 1,
      observedSource: "action",
      errorCode: null
    }]);
    const requests: Array<{ kind: number; channel?: string }> = [];
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest, supplierGeneration }) => {
          const request = vi.fn(async (wire: Uint8Array) => {
            const envelope = parseRequestEnvelope(wire);
            const document = decodeRequest(envelope);
            const channel = document.subscribe?.channel ?? document.unsubscribe?.channel;
            requests.push({ kind: envelope.message.kind, channel });
            if (envelope.message.kind === Kind.SubscriptionsRequest) {
              return newSubscriptionsResponse({ requestId: envelope.requestId, chargedAmount: "0", channels: ["old-app-topic"] });
            }
            return newActionResult({ requestId: envelope.requestId, success: true, chargedAmount: "1", errorCode: "" });
          });
          return connection(supplier.supplierId, supplier.supplierPublicKeyHex, request, (handler) => { void onSspRequest; void handler; }, supplierGeneration);
        }
      }
    });

    const handle = await provider.bind({ ownerPublicKeyHex: OWNER });
    expect(requests).toEqual([]);

    await handle.subscribePhysical("new-app-topic");
    expect(requests).toEqual([
      { kind: Kind.Subscribe, channel: "new-app-topic" },
      { kind: Kind.SubscriptionsRequest },
      { kind: Kind.Unsubscribe, channel: "old-app-topic" }
    ]);
    expect(store.listFeeAudit().filter((item) => item.action === "subscribe")).toHaveLength(1);
    expect(store.listFeeAudit().filter((item) => item.action === "unsubscribe")).toHaveLength(1);
    await provider.shutdown();
  });

  it("reconciles supplier enable/disable changes without charging unrelated triples", async () => {
    const store = makeStore(["primary"]);
    const requests: Array<{ supplierId: string; kind: number }> = [];
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest }) => {
          const request = vi.fn(async (wire: Uint8Array) => {
            const envelope = parseRequestEnvelope(wire);
            requests.push({ supplierId: supplier.supplierId, kind: envelope.message.kind });
            if (envelope.message.kind === Kind.SubscriptionsRequest) {
              return newSubscriptionsResponse({ requestId: envelope.requestId, chargedAmount: "0", channels: ["topic"] });
            }
            return newActionResult({ requestId: envelope.requestId, success: true, chargedAmount: "1", errorCode: "" });
          });
          return connection(supplier.supplierId, supplier.supplierPublicKeyHex, request, (handler) => { void onSspRequest; void handler; });
        }
      }
    });
    const handle = await provider.bind({ ownerPublicKeyHex: OWNER });
    const service = provider.service();
    const admin = provider.adminService();
    if (!service || !admin) throw new Error("expected Sat services");
    await handle.subscribePhysical("topic");
    await admin.setOwnerSettings({ ownerPublicKeyHex: OWNER, defaultPublishSupplierId: "primary", receiveSupplierIds: [] });
    await admin.setOwnerSettings({ ownerPublicKeyHex: OWNER, defaultPublishSupplierId: "primary", receiveSupplierIds: ["primary"] });

    expect(requests.map((item) => item.kind)).toEqual([Kind.Subscribe, Kind.Unsubscribe, Kind.Subscribe]);
    expect(store.listFeeAudit().filter((item) => item.action === "subscribe" || item.action === "unsubscribe")).toHaveLength(3);
    await provider.shutdown();
  });

  it("cleans a disabled Supplier with its own identity and leaves the other triple settled", async () => {
    const store = makeStore(["primary", "backup"]);
    const requests: Array<{ supplierId: string; kind: number }> = [];
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest, supplierGeneration }) => {
          const request = vi.fn(async (wire: Uint8Array) => {
            const envelope = parseRequestEnvelope(wire);
            requests.push({ supplierId: supplier.supplierId, kind: envelope.message.kind });
            if (envelope.message.kind === Kind.SubscriptionsRequest) {
              return newSubscriptionsResponse({ requestId: envelope.requestId, chargedAmount: "0", channels: ["topic"] });
            }
            return newActionResult({ requestId: envelope.requestId, success: true, chargedAmount: "1", errorCode: "" });
          });
          return connection(supplier.supplierId, supplier.supplierPublicKeyHex, request, (handler) => { void onSspRequest; void handler; }, supplierGeneration);
        }
      }
    });
    const handle = await provider.bind({ ownerPublicKeyHex: OWNER });
    const service = provider.service();
    const admin = provider.adminService();
    if (!service || !admin) throw new Error("expected Sat services");

    await handle.subscribePhysical("topic");
    await admin.upsertSupplier({
      supplierId: "primary",
      name: "Primary",
      supplierPublicKeyHex: SUPPLIER_A,
      multiaddrs: ["/ip4/127.0.0.1/tcp/9000"],
      enabled: false
    });

    expect(requests).toEqual([
      { supplierId: "primary", kind: Kind.Subscribe },
      { supplierId: "backup", kind: Kind.Subscribe },
      { supplierId: "primary", kind: Kind.Unsubscribe },
      { supplierId: "backup", kind: Kind.SubscriptionsRequest }
    ]);
    expect(store.listFeeAudit().filter((item) => item.action === "subscribe" || item.action === "unsubscribe")).toHaveLength(3);
    await provider.shutdown();
  });

  it("forwards only raw valid SSP Publish events to the Coordinator boundary", async () => {
    const store = makeStore(["primary"]);
    let inbound: ((wire: Uint8Array) => Promise<Uint8Array>) | undefined;
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest }) => connection(
          supplier.supplierId,
          supplier.supplierPublicKeyHex,
          async (wire) => newActionResult({
            requestId: parseRequestEnvelope(wire).requestId,
            success: true,
            chargedAmount: "0",
            errorCode: ""
          }),
          (handler) => { if (supplier.supplierId === "primary") inbound = handler; void onSspRequest; }
        )
      }
    });
    await provider.bind({ ownerPublicKeyHex: OWNER });
    const received: SatIncomingPublish[] = [];
    provider.service()?.subscribeEvents((event) => { received.push(event); });
    const response = await inbound!(newPublish(newRequestId(), "topic", new TextEncoder().encode("{\"ok\":true}")));
    expect(parseActionResult(response).success).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ channel: "topic", ingressSupplierId: "primary" });
    await provider.shutdown();
  });

  it("returns an SSP rejection when the Coordinator rejects an unknown private protocol", async () => {
    const store = makeStore(["primary"]);
    let inbound: ((wire: Uint8Array) => Promise<Uint8Array>) | undefined;
    const provider = createSatSubscriptionProvider({
      stateForOwner: async () => store,
      transport: {
        connect: async ({ supplier, onSspRequest }) => connection(
          supplier.supplierId,
          supplier.supplierPublicKeyHex,
          async (wire) => newActionResult({
            requestId: parseRequestEnvelope(wire).requestId,
            success: true,
            chargedAmount: "0",
            errorCode: ""
          }),
          (handler) => { if (supplier.supplierId === "primary") inbound = handler; void onSspRequest; }
        )
      }
    });
    await provider.bind({ ownerPublicKeyHex: OWNER });
    provider.service()?.subscribeEvents(async () => {
      throw { domain: "channel-inbound", code: "UNSUPPORTED_PROTOCOL" };
    });

    const response = await inbound!(newPublish(newRequestId(), "bsv8.inbox.topic", new TextEncoder().encode("{}")));
    const action = parseActionResult(response);
    expect(action.success).toBe(false);
    expect(action.errorCode).toBe("INVALID_REQUEST");
    await provider.shutdown();
  });

  it("fails physical subscription closed when no receive Supplier is configured", async () => {
    const store = makeStore();
    const provider = createSatSubscriptionProvider({ stateForOwner: async () => store });
    const handle = await provider.bind({ ownerPublicKeyHex: OWNER });
    await expect(handle.subscribePhysical("topic")).rejects.toBeInstanceOf(SatSubscriptionError);
    await provider.shutdown();
  });
});
