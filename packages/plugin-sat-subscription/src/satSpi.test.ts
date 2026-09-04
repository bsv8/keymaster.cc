import { describe, expect, it, vi } from "vitest";
import { encodeErrorResponse, encodeInformationResponse } from "satoshi-payment-interface/wire";
import { parse } from "satoshi-payment-interface/wire";
import { createSatSubscriptionState } from "./satState.js";
import { createSatSpiService, mapSpiBsvNetwork, type SatP2pkhService } from "./satSpi.js";
import { SatTransportError } from "./satProvider.js";

const OWNER = "02" + "11".repeat(32);
const SUPPLIER_KEY = "03" + "22".repeat(32);
const SUPPLIER = { supplierId: "primary", name: "Primary", supplierPublicKeyHex: SUPPLIER_KEY, multiaddrs: ["/ip4/127.0.0.1/tcp/9000"], enabled: true };
const INFO = { currencies: [{ currency: "BSV", network: "mainnet", paymentAddress: "1supplier", balance: 10_000n }], projectType: "test", projectInfoCbor: new Uint8Array([0xa0]) };
const TESTNET_INFO = { currencies: [{ currency: "BSV", network: "testnet", paymentAddress: "mqrAdPBmbvhLohuqFneSmn8TfZahUvu9eJ", balance: 10_000n }], projectType: "test", projectInfoCbor: new Uint8Array([0xa0]) };

function makeFixture(input: { failFirstCollect?: boolean; balanceAfterCollect?: bigint; info?: typeof INFO; includeTestnet?: boolean } = {}) {
  const info = input.info ?? INFO;
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
        ? { ...info, currencies: info.currencies.map((item) => ({ ...item, balance: input.balanceAfterCollect! })) }
        : info;
      return encodeInformationResponse(request.requestId, information);
    })
  };
  const p2pkh: SatP2pkhService = {
    getGlobalSettings: () => ({ includeTestnet: input.includeTestnet ?? true }),
    prepareTransfer: vi.fn(async (input) => ({ ...input, network: input.assetId === "bsv" ? "main" : "test", feeRateSatoshisPerKb: input.feeRateSatoshisPerKb, changeAddress: "1change", estimatedFeeSatoshis: 5, rawTxHex: "00" })),
    submitTransfer: vi.fn(async () => ({ status: "local-confirmed", txid: "aa".repeat(32) }))
  };
  const deriveP2pkhAddress = vi.fn(async (_owner: string, network: "main" | "test") => network === "main" ? "1owner" : "mowner");
  const service = createSatSpiService({
    getRuntime: () => runtime,
    getOwnerPublicKeyHex: () => OWNER,
    stateForOwner: async () => store,
    getP2pkh: () => p2pkh,
    deriveP2pkhAddress
  });
  return { store, runtime, p2pkh, service, requests, deriveP2pkhAddress };
}

describe("Sat SPI service", () => {
  it("maps only the formal SPI BSV network names", () => {
    expect(mapSpiBsvNetwork("mainnet")).toEqual({ spiNetwork: "mainnet", p2pkhNetwork: "main", assetId: "bsv" });
    expect(mapSpiBsvNetwork("testnet")).toEqual({ spiNetwork: "testnet", p2pkhNetwork: "test", assetId: "bsvtest" });
    expect(() => mapSpiBsvNetwork("main")).toThrow("供应商 BSV 网络不受支持");
    expect(() => mapSpiBsvNetwork("TESTNET")).toThrow("供应商 BSV 网络不受支持");
  });

  it("keeps Information balances as bigint and creates an owner-bound top-up preview", async () => {
    const fixture = makeFixture();
    const info = await fixture.service.getInformation({ supplierId: "primary" });
    expect(info.currencies[0]?.balance).toBe(10_000n);
    const preview = await fixture.service.prepareTopUp({ supplierId: "primary", amountSatoshis: 1234n });
    expect(preview.amountSatoshis).toBe(1234n);
    expect(fixture.p2pkh.prepareTransfer).toHaveBeenCalledWith(expect.objectContaining({ ownerPublicKeyHex: OWNER, amountSatoshis: 1234, recipientAddress: "1supplier" }));
  });

  it("prepares and submits a BSV testnet top-up with bsvtest/test", async () => {
    const fixture = makeFixture({ info: TESTNET_INFO, includeTestnet: true });
    const preview = await fixture.service.prepareTopUp({ supplierId: "primary", currency: "BSV", network: "testnet", amountSatoshis: 1234n });
    expect(preview).toMatchObject({ network: "testnet", paymentAddress: TESTNET_INFO.currencies[0]!.paymentAddress });
    expect(fixture.p2pkh.prepareTransfer).toHaveBeenCalledWith(expect.objectContaining({ assetId: "bsvtest", recipientAddress: TESTNET_INFO.currencies[0]!.paymentAddress }));
    expect((await fixture.service.submitTopUp(preview)).status).toBe("local-confirmed");
    expect(fixture.p2pkh.submitTransfer).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsupported Information network before preparing a transfer", async () => {
    const fixture = makeFixture({ info: { ...INFO, currencies: [{ ...INFO.currencies[0]!, network: "regtest" }] } });
    await expect(fixture.service.prepareTopUp({ supplierId: "primary", amountSatoshis: 1234n })).rejects.toThrow("供应商 BSV 网络不受支持");
    expect(fixture.p2pkh.prepareTransfer).not.toHaveBeenCalled();
  });

  it("returns unavailable when P2PKH testnet is disabled", async () => {
    const fixture = makeFixture({ info: TESTNET_INFO, includeTestnet: false });
    await expect(fixture.service.prepareTopUp({ supplierId: "primary", currency: "BSV", network: "testnet", amountSatoshis: 1234n })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("P2PKH 设置未启用测试网")
    });
    expect(fixture.p2pkh.prepareTransfer).not.toHaveBeenCalled();
  });

  it("derives the owner Collect address on the SPI testnet", async () => {
    const fixture = makeFixture({ info: TESTNET_INFO, includeTestnet: true });
    const result = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "testnet", amount: 100n });
    expect(result.state).toBe("unknown_result");
    expect(fixture.p2pkh.prepareTransfer).not.toHaveBeenCalled();
    expect(fixture.p2pkh.getGlobalSettings).toBeDefined();
    expect(fixture.p2pkh).toBeDefined();
    expect(fixture.deriveP2pkhAddress).toHaveBeenCalledWith(OWNER, "test");
    const wire = fixture.requests.find((candidate) => parse(candidate).kind === 3)!;
    const parsed = parse(wire);
    if (!("items" in parsed)) throw new Error("expected a CollectRequest");
    expect(parsed.items[0]?.paymentAddress).toBe("mowner");
  });

  it("does not broadcast a testnet preview after its network or owner is tampered", async () => {
    const fixture = makeFixture({ info: TESTNET_INFO, includeTestnet: true });
    const preview = await fixture.service.prepareTopUp({ supplierId: "primary", currency: "BSV", network: "testnet", amountSatoshis: 1234n });
    await expect(fixture.service.submitTopUp({ ...preview, p2pkhPreview: { ...(preview.p2pkhPreview as object), ownerPublicKeyHex: "03" + "44".repeat(32) } })).rejects.toMatchObject({ code: "identity" });
    await expect(fixture.service.submitTopUp({ ...preview, network: "mainnet" })).rejects.toMatchObject({ code: "conflict" });
    expect(fixture.p2pkh.submitTransfer).not.toHaveBeenCalled();
  });

  it("stores unknown Collect results and retries with the exact same request wire", async () => {
    const fixture = makeFixture();
    const first = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "mainnet", amount: 100n });
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
    await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "mainnet", amount: 100n });
    await expect(fixture.service.retryCollect({ requestIdHex: fixture.store.snapshot().collectResults[0]!.requestIdHex, requestWire: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({ code: "conflict" });
  });

  it("retries a lost Collect response without querying the now-lower balance", async () => {
    const fixture = makeFixture({ balanceAfterCollect: 0n });
    const first = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "mainnet", amount: 100n });
    expect(first.state).toBe("unknown_result");
    const retried = await fixture.service.retryCollect({ requestIdHex: first.requestIdHex });
    expect(retried.state).toBe("succeeded");
    // retryCollect 只重发保存的 Collect Wire；不会先发新的 Information 查询。
    expect(fixture.requests.filter((wire) => parse(wire).kind === 1)).toHaveLength(1);
  });

  it("creates a fresh request id for a second active Collect of the same amount", async () => {
    const fixture = makeFixture({ failFirstCollect: false });
    const first = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "mainnet", amount: 100n });
    const second = await fixture.service.collectNew({ supplierId: "primary", currency: "BSV", network: "mainnet", amount: 100n });
    expect(first.state).toBe("succeeded");
    expect(second.state).toBe("succeeded");
    expect(second.requestIdHex).not.toBe(first.requestIdHex);
  });

  it("rejects retry after owner or Supplier generation changes", async () => {
    const ownerChanged = makeFixture();
    const ownerPending = await ownerChanged.service.collectNew({ supplierId: "primary", currency: "BSV", network: "mainnet", amount: 100n });
    ownerChanged.runtime.ownerGeneration = 2;
    await expect(ownerChanged.service.retryCollect({ requestIdHex: ownerPending.requestIdHex })).rejects.toMatchObject({ code: "conflict" });

    const supplierChanged = makeFixture();
    const supplierPending = await supplierChanged.service.collectNew({ supplierId: "primary", currency: "BSV", network: "mainnet", amount: 100n });
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
          network: "mainnet",
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
      deriveP2pkhAddress: async () => "1owner"
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
    const service = createSatSpiService({ getRuntime: () => runtime, getOwnerPublicKeyHex: () => OWNER, stateForOwner: async () => store, getP2pkh: () => null, deriveP2pkhAddress: async () => "1owner" });
    await expect(service.getInformation({ supplierId: "primary" })).rejects.toMatchObject({ code: "unavailable" });
  });
});
