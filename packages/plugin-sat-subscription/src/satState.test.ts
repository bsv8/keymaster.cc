import { describe, expect, it, vi } from "vitest";
import { createSatSubscriptionState } from "./satState.js";

const OWNER = "02" + "11".repeat(32);
const SUPPLIER_KEY = "03" + "22".repeat(32);
const supplier = { supplierId: "primary", name: "Primary", supplierPublicKeyHex: SUPPLIER_KEY, multiaddrs: ["/ip4/127.0.0.1/tcp/9000"], enabled: true };

function state() {
  return createSatSubscriptionState({
    ownerPublicKeyHex: OWNER,
    initial: {
      ownerSettings: { ownerPublicKeyHex: OWNER, defaultPublishSupplierId: null, receiveSupplierIds: [] },
      suppliers: [supplier]
    }
  });
}

describe("SatSubscription owner state", () => {
  it("persists a supplier catalog generation across mutations", async () => {
    const store = state();
    expect(store.supplierGeneration()).toBe(1);
    await store.upsertSupplier({ ...supplier, name: "Primary v2" });
    expect(store.supplierGeneration()).toBe(2);
    await store.deleteSupplier("primary");
    expect(store.supplierGeneration()).toBe(3);
  });

  it("keeps desired and observed subscription states separate", async () => {
    const store = state();
    await store.setDesiredSubscription({ supplierId: "primary", channel: "topic", state: "subscribing" });
    await store.setObservedSubscription({ supplierId: "primary", channel: "topic", state: "unsubscribed", source: "refresh", observedAtMs: 10 });
    expect(store.listSubscriptions("primary")[0]).toMatchObject({ desired: "subscribing", observed: "unsubscribed", observedAtMs: 10 });
  });

  it("records duplicate and conflicting Channel deliveries without storing content", async () => {
    const store = state();
    const messageIdBase64Url = "A".repeat(43);
    const input = { dedupKey: "bsv8.message.v1\u0000" + OWNER + "\u0000" + messageIdBase64Url, direction: "inbound" as const, contentDigestHex: "aa".repeat(32), fromPublicKeyHex: OWNER, recipientPublicKeyHex: OWNER, messageIdBase64Url, ingressSupplierId: "primary", firstPersistedAtMs: 20 };
    expect(await store.rememberChannel(input)).toBe("new");
    expect(await store.rememberChannel({ ...input, ingressSupplierId: "primary" })).toBe("duplicate");
    expect(await store.rememberChannel({ ...input, contentDigestHex: "bb".repeat(32) })).toBe("conflict");
    expect(store.getChannel(input.dedupKey)).toMatchObject({ ackState: "conflict", firstPersistedAtMs: 20 });
  });

  it("keeps the first ingress stable and tracks later Supplier ACKs independently", async () => {
    const store = state();
    const input = {
      dedupKey: "bsv8.message.v1\u0000" + OWNER + "\u0000" + "B".repeat(43),
      direction: "inbound" as const,
      contentDigestHex: "aa".repeat(32),
      fromPublicKeyHex: OWNER,
      recipientPublicKeyHex: OWNER,
      messageIdBase64Url: "B".repeat(43),
      ingressSupplierId: "primary",
      firstPersistedAtMs: 20
    };
    expect(await store.rememberChannel(input)).toBe("new");
    expect(await store.rememberChannel({ ...input, ingressSupplierId: "backup" })).toBe("duplicate");

    const record = store.getChannel(input.dedupKey)!;
    expect(record.ingressSupplierId).toBe("primary");
    expect(record.ackBySupplier).toEqual(expect.arrayContaining([
      expect.objectContaining({ supplierId: "primary", state: "pending" }),
      expect.objectContaining({ supplierId: "backup", state: "pending" })
    ]));

    await store.updateChannelAck({ dedupKey: input.dedupKey, supplierId: "backup", state: "acknowledged" });
    expect(store.getChannel(input.dedupKey)).toMatchObject({
      ingressSupplierId: "primary",
      ackState: "pending"
    });
    expect(store.getChannel(input.dedupKey)?.ackBySupplier).toEqual(expect.arrayContaining([
      expect.objectContaining({ supplierId: "backup", state: "acknowledged" })
    ]));
  });

  it("bounds fee audit and returns defensive supplier values", async () => {
    const save = vi.fn(async () => undefined);
    const store = createSatSubscriptionState({ ownerPublicKeyHex: OWNER, initial: { suppliers: [supplier], ownerSettings: { ownerPublicKeyHex: OWNER, defaultPublishSupplierId: null, receiveSupplierIds: [] } }, persistence: { save } });
    for (let index = 0; index < 300; index += 1) {
      await store.recordFee({ action: "publish", supplierId: "primary", channel: "topic", requestIdHex: "aa".repeat(32), chargedAmount: "0", result: "ok", createdAtMs: index });
    }
    expect(store.listFeeAudit().length).toBe(256);
    const copy = store.getSupplier("primary")!;
    copy.multiaddrs.push("/ip4/127.0.0.1/tcp/1");
    expect(store.getSupplier("primary")!.multiaddrs).toHaveLength(1);
    expect(save).toHaveBeenCalled();
  });

  it("marks legacy unresolved Collect records as non-recoverable", () => {
    const store = createSatSubscriptionState({
      ownerPublicKeyHex: OWNER,
      initial: {
        suppliers: [supplier],
        collectResults: [{
          requestIdHex: "aa".repeat(32),
          supplierId: "primary",
          currency: "BSV",
          network: "main",
          amount: 100n,
          paymentAddress: "1owner",
          state: "pending"
        }]
      }
    });
    expect(store.getCollectResult("aa".repeat(32))).toMatchObject({
      state: "unknown_result",
      recoveryBlocked: true,
      errorCode: "unknown_result"
    });
  });
});
