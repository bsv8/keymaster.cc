import { describe, expect, it, vi } from "vitest";
import { encodeErrorResponse, encodeInformationResponse } from "satoshi-payment-interface/wire";
import { parse } from "satoshi-payment-interface/wire";
import { createSatSubscriptionState } from "./satState.js";
import { createSatSpiService, type SatP2pkhService } from "./satSpi.js";
import { SatTransportError } from "./satProvider.js";

const OWNER = "02" + "11".repeat(32);
const SUPPLIER_KEY = "03" + "22".repeat(32);
const SUPPLIER = { supplierId: "primary", name: "Primary", supplierPublicKeyHex: SUPPLIER_KEY, multiaddrs: ["/ip4/127.0.0.1/tcp/9000"], enabled: true };
const INFO = { currencies: [{ currency: "BSV", network: "main", paymentAddress: "1supplier", balance: 10_000n }], projectType: "test", projectInfoCbor: new Uint8Array([0xa0]) };

function makeFixture(input: { failFirstCollect?: boolean; balanceAfterCollect?: bigint } = {}) {
  const store = createSatSubscriptionState({ ownerPublicKeyHex: OWNER, initial: { suppliers: [SUPPLIER], ownerSettings: { ownerPublicKeyHex: OWNER, defaultPublishSupplierId: "primary", receiveSupplierIds: [] } } });
  const requests: Uint8Array[] = [];
  let failCollect = input.failFirstCollect ?? true;
  const runtime = {
    ownerPublicKeyHex: OWNER,
    ownerGeneration: 1,
    stateStore: store,
    requestSpi: vi.fn(async (_supplierId: string, wire: Uint8Array) => {
      const request = parse(wire);
      requests.push(wire.slice());
      if (request.kind === 3 && failCollect) {
        failCollect = false;
        throw new SatTransportError("response lost", { sentBoundary: "unknown" });
      }
      const information = request.kind === 3 && input.balanceAfterCollect !== undefined
        ? { ...INFO, currencies: INFO.currencies.map((item) => ({ ...item, balance: input.balanceAfterCollect! })) }
        : INFO;
      return encodeInformationResponse(request.requestId, information);
    })
  };
  const p2pkh: SatP2pkhService = {
    prepareTransfer: vi.fn(async (input) => ({ ...input, network: "main", feeRateSatoshisPerKb: input.feeRateSatoshisPerKb, changeAddress: "1change", estimatedFeeSatoshis: 5, rawTxHex: "00" })),
    submitTransfer: vi.fn(async () => ({ status: "local-confirmed", txid: "aa".repeat(32) }))
  };
  const service = createSatSpiService({
    getRuntime: () => runtime,
    getOwnerPublicKeyHex: () => OWNER,
    stateForOwner: async () => store,
    getP2pkh: () => p2pkh,
    deriveMainAddress: async () => "1owner"
  });
  return { store, runtime, p2pkh, service, requests };
}

describe("Sat SPI service", () => {
  it("keeps Information balances as bigint and creates an owner-bound top-up preview", async () => {
    const fixture = makeFixture();
    const info = await fixture.service.getInformation({ supplierId: "primary" });
    expect(info.currencies[0]?.balance).toBe(10_000n);
    const preview = await fixture.service.prepareTopUp({ supplierId: "primary", amountSatoshis: 1234n });
    expect(preview.amountSatoshis).toBe(1234n);
    expect(fixture.p2pkh.prepareTransfer).toHaveBeenCalledWith(expect.objectContaining({ ownerPublicKeyHex: OWNER, amountSatoshis: 1234, recipientAddress: "1supplier" }));
  });

  it("stores unknown Collect results and retries with the exact same request wire", async () => {
    const fixture = makeFixture();
    const first = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "main", amount: 100n });
    expect(first.state).toBe("unknown_result");
    const firstCollect = fixture.requests.find((wire) => parse(wire).kind === 3)!;
    const second = await fixture.service.retryCollect({ requestIdHex: first.requestIdHex });
    expect(second.state).toBe("succeeded");
    const collectRequests = fixture.requests.filter((wire) => parse(wire).kind === 3);
    expect(collectRequests).toHaveLength(2);
    expect([...parse(firstCollect).requestId]).toEqual([...parse(collectRequests[1]!).requestId]);
  });

  it("does not allow a different unresolved Collect content", async () => {
    const fixture = makeFixture();
    await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "main", amount: 100n });
    await expect(fixture.service.retryCollect({ requestIdHex: fixture.store.snapshot().collectResults[0]!.requestIdHex, requestWire: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({ code: "conflict" });
  });

  it("retries a lost Collect response without querying the now-lower balance", async () => {
    const fixture = makeFixture({ balanceAfterCollect: 0n });
    const first = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "main", amount: 100n });
    expect(first.state).toBe("unknown_result");
    const retried = await fixture.service.retryCollect({ requestIdHex: first.requestIdHex });
    expect(retried.state).toBe("succeeded");
    // retryCollect 只重发保存的 Collect Wire；不会先发新的 Information 查询。
    expect(fixture.requests.filter((wire) => parse(wire).kind === 1)).toHaveLength(1);
  });

  it("creates a fresh request id for a second active Collect of the same amount", async () => {
    const fixture = makeFixture({ failFirstCollect: false });
    const first = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "main", amount: 100n });
    const second = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "main", amount: 100n });
    expect(first.state).toBe("succeeded");
    expect(second.state).toBe("succeeded");
    expect(second.requestIdHex).not.toBe(first.requestIdHex);
  });

  it("rejects retry after owner or Supplier generation changes", async () => {
    const ownerChanged = makeFixture();
    const ownerPending = await ownerChanged.service.collectNew({ supplierId: "primary", currency: "BSV", network: "main", amount: 100n });
    ownerChanged.runtime.ownerGeneration = 2;
    await expect(ownerChanged.service.retryCollect({ requestIdHex: ownerPending.requestIdHex })).rejects.toMatchObject({ code: "conflict" });

    const supplierChanged = makeFixture();
    const supplierPending = await supplierChanged.service.collectNew({ supplierId: "primary", currency: "BSV", network: "main", amount: 100n });
    await supplierChanged.store.upsertSupplier({ ...SUPPLIER, name: "Primary changed" });
    await expect(supplierChanged.service.retryCollect({ requestIdHex: supplierPending.requestIdHex })).rejects.toMatchObject({ code: "conflict" });
  });

  it("fails closed for a legacy unresolved Collect without recovery metadata", async () => {
    const requestIdHex = "bb".repeat(32);
    const store = createSatSubscriptionState({
      ownerPublicKeyHex: OWNER,
      initial: {
        suppliers: [SUPPLIER],
        collectResults: [{
          requestIdHex,
          supplierId: "primary",
          currency: "BSV",
          network: "main",
          amount: 100n,
          paymentAddress: "1owner",
          state: "pending"
        }]
      }
    });
    const requestSpi = vi.fn(async () => new Uint8Array());
    const service = createSatSpiService({
      getRuntime: () => ({ ownerPublicKeyHex: OWNER, ownerGeneration: 1, supplierGeneration: 1, stateStore: store, requestSpi }),
      getOwnerPublicKeyHex: () => OWNER,
      stateForOwner: async () => store,
      getP2pkh: () => null,
      deriveMainAddress: async () => "1owner"
    });

    await expect(service.retryCollect({ requestIdHex })).rejects.toMatchObject({ code: "unknown_result" });
    expect(requestSpi).not.toHaveBeenCalled();
    expect(store.getCollectResult(requestIdHex)).toMatchObject({ state: "unknown_result", recoveryBlocked: true });
  });

  it("uses the real p2pkh result only after the preview is revalidated", async () => {
    const fixture = makeFixture();
    const preview = await fixture.service.prepareTopUp({ supplierId: "primary", amountSatoshis: 1234n });
    const result = await fixture.service.submitTopUp(preview);
    expect(result).toMatchObject({ status: "local-confirmed", txid: "aa".repeat(32) });
    expect(fixture.p2pkh.submitTransfer).toHaveBeenCalledTimes(1);
  });

  it("maps SPI business errors without exposing raw response data", async () => {
    const store = createSatSubscriptionState({ ownerPublicKeyHex: OWNER, initial: { suppliers: [SUPPLIER] } });
    const runtime = { ownerPublicKeyHex: OWNER, stateStore: store, requestSpi: async (_id: string, wire: Uint8Array) => encodeErrorResponse({ requestId: parse(wire).requestId, code: "UNSUPPORTED_CURRENCY", message: "private server detail" }) };
    const service = createSatSpiService({ getRuntime: () => runtime, getOwnerPublicKeyHex: () => OWNER, stateForOwner: async () => store, getP2pkh: () => null, deriveMainAddress: async () => "1owner" });
    await expect(service.getInformation({ supplierId: "primary" })).rejects.toMatchObject({ code: "unavailable" });
  });
});
