import { fundingCoin, previousTransactions, paymentRequester, cleanupPayments } from "../../../Coding/keymaster/vaultlink-integration/test/transfer-fixture.mjs";
import { walletStateFixtureSnapshot } from "@keymaster/runtime/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { VaultWalletState, ProtectedOutpointRegistry } from "@keymaster/contracts";
import { createP2pkhProtocolSpendService } from "./p2pkhProtocolSpend.js";
import { calculateP2pkhBalanceBreakdown } from "./p2pkhService.js";
import { createP2pkhStateRepository, disposeP2pkhStateRepository, openP2pkhStateRepository, resourceIdFor } from "./storage/p2pkhStateRepository.js";
import { createMemoryOwnerFileStore } from "./storage/testSupport/memoryOwnerFileStore.js";
import { calcTxidFromRawTxHex, deriveP2pkhAddress } from "./p2pkhSigner.js";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function makeClaimStore() {
  type ClaimState = "claimed" | "observed-consumed";
  const claims = new Map<string, {
    id: string;
    submissionId: string;
    resourceId: string;
    publicKeyHex: string;
    network: "main" | "test";
    txid: string;
    vout: number;
    value?: number;
    state: ClaimState;
    observation?: "unconfirmed" | "confirmed";
  }>();

  return {
    claims,
    async tryClaimInputs(input: {
      submissionId: string;
      resourceId: string;
      publicKeyHex: string;
      network: "main" | "test";
      inputs: Array<{ txid: string; vout: number; value?: number }>;
    }) {
      const claimIds: string[] = [];
      for (const u of input.inputs) {
        const id = `${input.resourceId}:${u.txid}:${u.vout}`;
        const existing = claims.get(id);
        if (existing && existing.state === "claimed" && existing.submissionId !== input.submissionId) {
          throw new Error(`P2PKH input already claimed by another submission: ${u.txid}:${u.vout} (submissionId=${existing.submissionId})`);
        }
        claims.set(id, {
          id,
          submissionId: input.submissionId,
          resourceId: input.resourceId,
          publicKeyHex: input.publicKeyHex,
          network: input.network,
          txid: u.txid,
          vout: u.vout,
          ...(u.value === undefined ? {} : { value: u.value }),
          state: "claimed"
        });
        claimIds.push(id);
      }
      return { claimIds };
    },
    async releaseLocalInputClaims(input: { publicKeyHex: string; claimIds: string[] }) {
      for (const id of input.claimIds) {
        const existing = claims.get(id);
        if (existing && existing.publicKeyHex !== input.publicKeyHex) {
          throw new Error(`claim owner mismatch for ${id}`);
        }
        claims.delete(id);
      }
    },
    markObservedConsumed(claimIds: string[]) {
      for (const id of claimIds) {
        const existing = claims.get(id);
        if (existing) {
          claims.set(id, { ...existing, state: "observed-consumed" });
        }
      }
    },
    list() {
      return [...claims.values()];
    },
    get(id: string) {
      return claims.get(id);
    }
  };
}

type TestBroadcast = (network: "main" | "test", rawTxHex: string) => Promise<{
  canonicalTxid: string;
}>;

function makeCentralBroadcast(
  broadcast: TestBroadcast = async (_network, rawTxHex) => ({
    canonicalTxid: calcTxidFromRawTxHex(rawTxHex),
  }),
  submitOnceResult?: unknown,
) {
  return {
    submitOnce: submitOnceResult !== undefined
      ? async () => submitOnceResult
      : async (input: { network: "main" | "test"; rawTxHex: string }) => ({
          status: "local-confirmed" as const,
          txid: (await broadcast(input.network, input.rawTxHex)).canonicalTxid,
        }),
  } as never;
}

function makeService(options?: {
  previousTransactions?: (network: "main" | "test", inputs: readonly { txid: string }[]) => Promise<string[]>;
  claimStore?: ReturnType<typeof makeClaimStore>;
  broadcast?: TestBroadcast;
  submitOnceResult?: unknown;
  protectedOutpoints?: ProtectedOutpointRegistry;
}) {
  const privHex = options?.claimStore ? "00000000000000000000000000000000000000000000000000000000000000a1" : "00000000000000000000000000000000000000000000000000000000000000aa";
  const owner = deriveP2pkhAddress(privHex, "main");
  const claimStore = options?.claimStore ?? makeClaimStore();
  const payment=paymentRequester(privHex),paymentActions:string[]=[];
  const service = createP2pkhProtocolSpendService({
    previousTransactions: options?.previousTransactions ?? previousTransactions,
    vault: {
      requestPayment: async (command: Parameters<typeof payment>[0]) => {paymentActions.push(command.action);return payment(command);},
      status: () => "unlocked",
      createActiveKeyCrypto: async () => ({
        signDigest: async (input: { publicKeyHex: string; digest: ArrayBuffer; format: "der" | "compact" }) => {
          expect(input.publicKeyHex).toBe(owner.publicKeyHex);
          const sig = secp256k1.sign(new Uint8Array(input.digest), hexToBytes(privHex), {
            lowS: true,
            prehash: false,
            format: input.format
          });
          return {
            publicKeyHex: owner.publicKeyHex,
            format: input.format,
            signature: sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
          };
        }
      })
    } as never,
    centralBroadcastService: makeCentralBroadcast(options?.broadcast, options?.submitOnceResult),
    claimStore,
    protectedOutpoints: options?.protectedOutpoints,
    getKeyForOwner: async (ownerPublicKeyHex: string) => {
      expect(ownerPublicKeyHex).toBe(owner.publicKeyHex);
      return { publicKeyHex: owner.publicKeyHex };
    }
  });
  return { service, owner, claimStore,paymentActions };
}

const INTEGRATION_PRIV = "00000000000000000000000000000000000000000000000000000000000000c1";
const INTEGRATION_OWNER = deriveP2pkhAddress(INTEGRATION_PRIV, "main");
const integrationStores = new Map<string, import("./storage/testSupport/memoryOwnerFileStore.js").MemoryOwnerFileStore>();

function openIntegrationStore(publicKeyHex: string): import("./storage/testSupport/memoryOwnerFileStore.js").MemoryOwnerFileStore {
    const existing = integrationStores.get(publicKeyHex);
    if (existing) return existing;
    const store = createMemoryOwnerFileStore();
    integrationStores.set(publicKeyHex, store);
    return store;
}

function makeIntegrationWalletState(publicKeyHex: string): VaultWalletState {
  return {
    snapshot: () => walletStateFixtureSnapshot((() => ({ activePublicKeyHex: publicKeyHex }))(), () => ({bsvNetwork: "main" as const,
      publicKeyHex,
      label: "integration",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z"
    })),

    subscribe: () => () => undefined
  };
}

async function openIntegrationRepository(): Promise<{
  close(): void;
  stateRepository: ReturnType<typeof createP2pkhStateRepository>;
}> {
  const bundle = await openP2pkhStateRepository(openIntegrationStore(INTEGRATION_OWNER.publicKeyHex));
  return {
    close: () => bundle.close(),
    stateRepository: createP2pkhStateRepository(bundle)
  };
}

async function resetIntegrationRepository(): Promise<void> {
  disposeP2pkhStateRepository();
  integrationStores.delete(INTEGRATION_OWNER.publicKeyHex);
}

afterEach(async () => {
  await resetIntegrationRepository();
  await cleanupPayments();
});

describe("createP2pkhProtocolSpendService", () => {
  it("signs with verified local previous transaction bytes while the WoC hex index is unavailable", async () => {
    const reader = vi.fn(async () => { throw new Error("WOC 404 hex index not ready"); });
    const { service, owner } = makeService({ previousTransactions: reader });
    const coin = { ...fundingCoin(owner.publicKeyHex, 10000), address: owner.address };
    const [raw] = await previousTransactions("main", [coin]);
    const preview = await service.presign({ ownerPublicKeyHex: owner.publicKeyHex, network: "main", feeRateSatoshisPerKb: 1,
      inputs: [{ ...coin, previousTransactionHex: raw }], outputs: [{ value: 9900, scriptHex: "51" }], noChangeRule: { maxMinerFeeSatoshis: 100 } });
    expect(preview.txid).toMatch(/^[0-9a-f]{64}$/u);
    expect(reader).not.toHaveBeenCalled();
  });

  it.each(["txid", "value"])("rejects local previous transaction evidence with mismatched %s before signing", async mismatch => {
    const { service, owner, paymentActions } = makeService();
    const coin = { ...fundingCoin(owner.publicKeyHex, 10000), address: owner.address };
    const [raw] = await previousTransactions("main", [coin]);
    const evidence = { ...coin, previousTransactionHex: raw, ...(mismatch === "txid" ? { txid: "ab".repeat(32) } : { value: 10001 }) };
    await expect(service.presign({ ownerPublicKeyHex: owner.publicKeyHex, network: "main", feeRateSatoshisPerKb: 1,
      inputs: [evidence], outputs: [{ value: 9900, scriptHex: "51" }], noChangeRule: { maxMinerFeeSatoshis: 101 } })).rejects.toThrow();
    expect(paymentActions).toEqual([]);
  });

  it("unsigned previews allocate no claims or payment budget; submit signs once and rejects changed, canceled and reused tickets",async()=>{
    const {service,owner,claimStore,paymentActions}=makeService();
    const input={ownerPublicKeyHex:owner.publicKeyHex,network:"main" as const,inputs:[{...fundingCoin(owner.publicKeyHex,10000,"91".repeat(32)),address:owner.address}],outputs:[{value:1000,scriptHex:"6a"}],changeAddress:owner.address,feeRateSatoshisPerKb:1};
    const preview=await service.prepare(input);expect(preview.txid).toBe("");expect(preview.previewId).toBeTruthy();expect(claimStore.list()).toHaveLength(0);expect(paymentActions).toHaveLength(0);
    await expect(service.submit({...preview,changeSatoshis:preview.changeSatoshis-1})).rejects.toThrow("changed");expect(paymentActions).toHaveLength(0);
    const result=await service.submit(preview);expect(result.txid).toBe(calcTxidFromRawTxHex(result.rawTxHex));expect(result.txid).not.toBe("");expect(paymentActions.filter(x=>x.startsWith("sign-"))).toHaveLength(1);expect(claimStore.list()).toHaveLength(1);
    await expect(service.submit(preview)).rejects.toThrow("already submitted");
    const canceled=await service.prepare({...input,inputs:[{...fundingCoin(owner.publicKeyHex,10000,"92".repeat(32)),address:owner.address}]});await service.releasePrepared!(canceled);await expect(service.submit(canceled)).rejects.toThrow("already submitted");expect(paymentActions.filter(x=>x.startsWith("sign-"))).toHaveLength(1);
  });
  it("accepts a sufficient fee when DER length changes with the change output", async () => {
    const { service, owner } = makeService();
    for (let fixture = 1; fixture <= 24; fixture++) {
      const preview = await service.presign({ ownerPublicKeyHex: owner.publicKeyHex, requestingPluginId: "msfile", network: "main",
        inputs: [{ ...fundingCoin(owner.publicKeyHex, 5000, fixture.toString(16).padStart(64, "0")), address: owner.address }],
        outputs: [{ scriptHex: "51", value: 202 }], changeAddress: owner.address, feeRateSatoshisPerKb: 1000 });
      expect(preview.estimatedFeeSatoshis).toBeGreaterThanOrEqual(preview.serializedSizeBytes);
      expect(preview.changeSatoshis + preview.estimatedFeeSatoshis + 202).toBe(5000);
    }
  });
  it("prepares and submits arbitrary output plans", async () => {
    const { service, owner, claimStore } = makeService();
    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "11".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });

    expect(preview.ownerPublicKeyHex).toBe(owner.publicKeyHex);
    expect(preview.changeSatoshis).toBeGreaterThanOrEqual(0);
    expect(preview.txid).toBe(calcTxidFromRawTxHex(preview.rawTxHex));
    expect(preview.outputs[0]!.scriptHex).toBe("6a");
    expect(preview.inputClaimIds).toHaveLength(1);
    expect(preview.submissionId).toMatch(/[0-9a-f-]{36}/);
    expect(claimStore.list()).toHaveLength(1);
    expect(claimStore.list()[0]?.state).toBe("claimed");
    expect(claimStore.list()[0]?.observation).toBeUndefined();

    const result = await service.submit(preview);
    expect(result.status).toBe("broadcast-pending-woc");
    expect(result.txid).toBe(preview.txid);
    expect(result.inputClaimIds).toEqual(preview.inputClaimIds);
    expect(result.submissionId).toBe(preview.submissionId);
    expect(result.observation).toBeUndefined();
  });

  it("claims inputs under resourceIdFor(network)", async () => {
    const { service, owner, claimStore } = makeService();
    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "ab".repeat(32), 1), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });

    expect(claimStore.list()[0]?.resourceId).toBe(resourceIdFor("main"));
    expect(preview.inputClaimIds).toHaveLength(1);
    expect(preview.inputClaimIds?.[0]).toContain(resourceIdFor("main"));
  });

  it("records the verified input value on protocol claims so balance deducts it immediately", async () => {
    const { stateRepository } = await openIntegrationRepository();
    const txid = fundingCoin(INTEGRATION_OWNER.publicKeyHex, 10000, "12".repeat(32)).txid;
    const inputValue = 10_000;
    const service = createP2pkhProtocolSpendService({
      previousTransactions,
      vault: {
        requestPayment: paymentRequester(INTEGRATION_PRIV),
        status: () => "unlocked",
        createActiveKeyCrypto: async () => ({
          signDigest: async () => ({
            publicKeyHex: INTEGRATION_OWNER.publicKeyHex,
            format: "der" as const,
            signature: new Uint8Array(64).buffer
          })
        })
      } as never,
      centralBroadcastService: makeCentralBroadcast(async () => ({ canonicalTxid: txid })),
      claimStore: {
        tryClaimInputs: async (input) => stateRepository.tryClaimInputs(input),
        releaseLocalInputClaims: async (input) => stateRepository.releaseLocalInputClaims(input.claimIds)
      },
      getKeyForOwner: async () => ({ publicKeyHex: INTEGRATION_OWNER.publicKeyHex })
    });

    await service.presign({
      ownerPublicKeyHex: INTEGRATION_OWNER.publicKeyHex,
      network: "main",
      inputs: [{ txid, vout: 0, value: inputValue, address: INTEGRATION_OWNER.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: INTEGRATION_OWNER.address
    });

    const claims = await stateRepository.listLocalInputClaimsByResource(resourceIdFor("main"));
    const protocolClaim = claims.find((row) => row.txid === txid);
    expect(protocolClaim?.value).toBe(inputValue);
    // 协议 claim 只服务于协议资产自身；普通 P2PKH 余额仍完全以 WoC 快照为准。
    const breakdown = calculateP2pkhBalanceBreakdown({
      snapshot: {
        available: true,
        state: "fresh",
        syncedAt: "t",
        items: [{ txid, vout: 0, value: inputValue, height: 1, status: "confirmed", isSpentInMempoolTx: false }]
      }
    });
    expect(breakdown.spendable).toBe(inputValue);
  });

  it("rejects protocol spend when transfer has already claimed the same outpoint, and vice versa", async () => {
    const { stateRepository } = await openIntegrationRepository();
    const resourceId = resourceIdFor("main");
    const txid = fundingCoin(INTEGRATION_OWNER.publicKeyHex, 10000, "cd".repeat(32)).txid;
    const vout = 0;
    await stateRepository.tryClaimInputs({ submissionId: "transfer-submission-1", resourceId, publicKeyHex: INTEGRATION_OWNER.publicKeyHex, network: "main", inputs: [{ txid, vout }] });

    const protocolSpendAfterTransfer = createP2pkhProtocolSpendService({
      previousTransactions,
      vault: {
        requestPayment: paymentRequester(INTEGRATION_PRIV),
        status: () => "unlocked",
        createActiveKeyCrypto: async () => ({
          signDigest: async () => ({
            publicKeyHex: INTEGRATION_OWNER.publicKeyHex,
            format: "der" as const,
            signature: new Uint8Array(64).buffer
          })
        })
      } as never,
      centralBroadcastService: makeCentralBroadcast(async () => ({ canonicalTxid: txid })),
      claimStore: {
        tryClaimInputs: async (input) => stateRepository.tryClaimInputs(input),
        releaseLocalInputClaims: async (input) => stateRepository.releaseLocalInputClaims(input.claimIds)
      },
      getKeyForOwner: async () => ({ publicKeyHex: INTEGRATION_OWNER.publicKeyHex })
    });

    await expect(protocolSpendAfterTransfer.presign({
      ownerPublicKeyHex: INTEGRATION_OWNER.publicKeyHex,
      network: "main",
      inputs: [{ txid, vout, value: 10_000, address: INTEGRATION_OWNER.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: INTEGRATION_OWNER.address
    })).rejects.toThrow(/already claimed/);

    const protocolFirst = createP2pkhProtocolSpendService({
      previousTransactions,
      vault: {
        requestPayment: paymentRequester(INTEGRATION_PRIV),
        status: () => "unlocked",
        createActiveKeyCrypto: async () => ({
          signDigest: async () => ({
            publicKeyHex: INTEGRATION_OWNER.publicKeyHex,
            format: "der" as const,
            signature: new Uint8Array(64).buffer
          })
        })
      } as never,
      centralBroadcastService: makeCentralBroadcast(async () => ({ canonicalTxid: txid })),
      claimStore: {
        tryClaimInputs: async (input) => stateRepository.tryClaimInputs(input),
        releaseLocalInputClaims: async (input) => stateRepository.releaseLocalInputClaims(input.claimIds)
      },
      getKeyForOwner: async () => ({ publicKeyHex: INTEGRATION_OWNER.publicKeyHex })
    });

    await protocolFirst.presign({
      ownerPublicKeyHex: INTEGRATION_OWNER.publicKeyHex,
      network: "main",
      inputs: [{ txid: fundingCoin(INTEGRATION_OWNER.publicKeyHex, 10000, "ef".repeat(32)).txid, vout: 0, value: 10_000, address: INTEGRATION_OWNER.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: INTEGRATION_OWNER.address
    });

    await expect(stateRepository.tryClaimInputs({ submissionId: "transfer-submission-2", resourceId, publicKeyHex: INTEGRATION_OWNER.publicKeyHex, network: "main", inputs: [{ txid: fundingCoin(INTEGRATION_OWNER.publicKeyHex, 10000, "ef".repeat(32)).txid, vout: 0 }] })).rejects.toThrow(/already claimed/);
  });

  it("rejects the second concurrent prepare for the same funding UTXO", async () => {
    const { service, owner } = makeService();
    const input = {
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main" as const,
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "22".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    };

    const [first, second] = await Promise.allSettled([service.presign(input), service.presign(input)]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(String(second.reason)).toMatch(/already claimed/);
    }
  });

  it("releases claims after rejected broadcast and allows re-preview", async () => {
    const { service, owner, claimStore } = makeService({
      broadcast: vi.fn(async () => {
        throw new Error("bad-txns-inputs-spent");
      })
    });

    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "33".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });
    const result = await service.submit(preview);
    expect(result.status).toBe("rejected");
    expect(claimStore.list()).toHaveLength(0);

    const retry = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "33".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });
    expect(retry.inputClaimIds).toHaveLength(1);
  });

  it("releases claims when the worker gate returns not-dispatched", async () => {
    const releaseClaims = vi.fn(async () => {});
    const protectedTxid = "55".repeat(32);
    const protectedOutpoints = {
      register: vi.fn(),
      unregister: vi.fn(),
      list: vi.fn(() => [{ txid: protectedTxid, vout: 0, network: "main" as const, ownerPluginId: "token-bsv21" }]),
      isProtected: vi.fn((input: { txid: string; vout: number; network: string }) => input.txid === protectedTxid && input.vout === 0 && input.network === "main"),
      onChange: vi.fn(() => () => {}),
      claimProtectedInputs: vi.fn(async () => ({ claimIds: ["protected-claim-1"] })),
      releaseClaims,
      _ids: vi.fn(() => ["token-bsv21"]),
    } as unknown as ProtectedOutpointRegistry;
    const { service, owner, claimStore } = makeService({
      submitOnceResult: { status: "not-dispatched", reason: "snapshot-stale", currentSeq: 9 },
      protectedOutpoints,
    });

    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      requestingPluginId: "token-bsv21",
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, protectedTxid, 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });
    expect(preview.protectedClaimIds).toEqual(["protected-claim-1"]);

    const result = await service.submit(preview);
    // 中文：门禁拒绝属于"确定未派发"，必须立刻释放占用并按 rejected 收口。
    expect(result.status).toBe("rejected");
    expect(result.error).toBe("snapshot-stale");
    expect(releaseClaims).toHaveBeenCalledWith(["protected-claim-1"]);
    expect(claimStore.list()).toHaveLength(0);
  });

  it("keeps claims after unknown broadcast and blocks re-preview", async () => {
    const { service, owner, claimStore } = makeService({
      broadcast: vi.fn(async () => {
        throw new Error("network timeout");
      })
    });

    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "44".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });
    const result = await service.submit(preview);
    expect(result.status).toBe("unknown");
    expect(claimStore.list()).toHaveLength(1);

    await expect(service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "44".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    })).rejects.toThrow(/already claimed/);
  });

  it("claims both protected token inputs and plain funding inputs", async () => {
    const releaseClaims = vi.fn(async () => {});
    const claimProtectedInputs = vi.fn(async () => ({ claimIds: ["protected-claim-1"] }));
    const protectedOutpoints: ProtectedOutpointRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      list: vi.fn(() => [{
        txid: "55".repeat(32),
        vout: 0,
        network: "main" as const,
        ownerPluginId: "token-bsv21"
      }]),
      isProtected: vi.fn((input) => input.txid === "55".repeat(32) && input.vout === 0 && input.network === "main"),
      onChange: vi.fn(() => () => {}),
      claimProtectedInputs,
      releaseClaims,
      _ids: vi.fn(() => ["token-bsv21"])
    };
    const { service, owner, claimStore } = makeService({ protectedOutpoints });

    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      requestingPluginId: "token-bsv21",
      network: "main",
      inputs: [
        { ...fundingCoin(owner.publicKeyHex, 10_000, "55".repeat(32), 0), address: owner.address },
        { ...fundingCoin(owner.publicKeyHex, 5_000, "66".repeat(32), 1), address: owner.address }
      ],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });

    expect(claimProtectedInputs).toHaveBeenCalledTimes(1);
    expect(preview.inputClaimIds).toHaveLength(2);
    expect(claimStore.list()).toHaveLength(2);
  });

  it("can mark claims observed-consumed during WOC reconcile", async () => {
    const { service, owner, claimStore } = makeService();
    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "77".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a", label: "op-return" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address
    });

    claimStore.markObservedConsumed(preview.inputClaimIds ?? []);
    const claimId = preview.inputClaimIds?.[0];
    expect(claimId).toBeTypeOf("string");
    expect(claimId ? claimStore.get(claimId)?.state : undefined).toBe("observed-consumed");

    await claimStore.releaseLocalInputClaims({
      publicKeyHex: owner.publicKeyHex,
      claimIds: preview.inputClaimIds ?? []
    });
    expect(claimStore.list()).toHaveLength(0);
  });
});

/**
 * 受控无找零构建。
 *
 * 协议固定输出交易没有找零输出，余额差必须精确成为矿工费；同时固定位置的
 * 零值输出（索引费为 0 的 vout 0）是协议的一部分，不能被当成非法金额拒掉。
 */
describe("受控无找零构建", () => {
  it("余额差精确成为矿工费，且不超过确认的预算", async () => {
    const { service, owner } = makeService();
    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 1_100, "88".repeat(32), 0), address: owner.address }],
      outputs: [
        { value: 100, scriptHex: "6a", label: "forum-vout-0" },
        { value: 1, scriptHex: "6a", label: "forum-vout-1" },
        { value: 500, scriptHex: "6a", label: "forum-vout-2" },
      ],
      feeRateSatoshisPerKb: 1,
      noChangeRule: { maxMinerFeeSatoshis: 600, allowZeroValueOutputs: true },
    });
    // 1100 - 601 = 499 sat 全部成为矿工费，没有找零输出。
    expect(preview.changeSatoshis).toBe(0);
    expect(preview.changeAddress).toBeUndefined();
    expect(preview.estimatedFeeSatoshis).toBe(499);
    expect(preview.outputs).toHaveLength(3);
  });

  it("矿工费超过确认预算时拒绝构造", async () => {
    const { service, owner } = makeService();
    await expect(service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "99".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a" }],
      feeRateSatoshisPerKb: 1,
      noChangeRule: { maxMinerFeeSatoshis: 10, allowZeroValueOutputs: true },
    })).rejects.toThrow(/larger miner fee/);
  });

  it("输入不足以覆盖固定输出时拒绝构造", async () => {
    const { service, owner } = makeService();
    await expect(service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 100, "aa".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a" }],
      feeRateSatoshisPerKb: 1,
      noChangeRule: { maxMinerFeeSatoshis: 600, allowZeroValueOutputs: true },
    })).rejects.toThrow(/insufficient inputs/);
  });

  it("允许零值输出：索引费为零时 vout 0 仍然保留", async () => {
    const { service, owner } = makeService();
    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 500, "bb".repeat(32), 0), address: owner.address }],
      outputs: [
        { value: 0, scriptHex: "6a", label: "forum-vout-0" },
        { value: 1, scriptHex: "6a", label: "forum-vout-1" },
      ],
      feeRateSatoshisPerKb: 1,
      noChangeRule: { maxMinerFeeSatoshis: 600, allowZeroValueOutputs: true },
    });
    expect(preview.outputs.map((output) => output.value)).toEqual([0, 1]);
    expect(preview.estimatedFeeSatoshis).toBe(499);
  });

  it("没有显式声明时仍然拒绝零值输出", async () => {
    const { service, owner } = makeService();
    await expect(service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 500, "cc".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 0, scriptHex: "6a" }],
      feeRateSatoshisPerKb: 1,
      noChangeRule: { maxMinerFeeSatoshis: 600 },
    })).rejects.toThrow(/Output value/);
  });

  it("未声明无找零规则时保留原来的余款拒绝", async () => {
    const { service, owner } = makeService();
    await expect(service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 10_000, "dd".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a" }],
      feeRateSatoshisPerKb: 1,
    })).rejects.toThrow(/requires changeAddress/);
  });

  it("无找零规则与 changeAddress 互斥", async () => {
    const { service, owner } = makeService();
    await expect(service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 1_100, "ee".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a" }],
      feeRateSatoshisPerKb: 1,
      changeAddress: owner.address,
      noChangeRule: { maxMinerFeeSatoshis: 600, allowZeroValueOutputs: true },
    })).rejects.toThrow(/not both/);
  });

  it("无找零模式也照样占用输入并落盘预签名", async () => {
    const { service, owner, claimStore } = makeService();
    const preview = await service.presign({
      ownerPublicKeyHex: owner.publicKeyHex,
      network: "main",
      inputs: [{ ...fundingCoin(owner.publicKeyHex, 1_100, "ef".repeat(32), 0), address: owner.address }],
      outputs: [{ value: 1_000, scriptHex: "6a" }],
      feeRateSatoshisPerKb: 1,
      noChangeRule: { maxMinerFeeSatoshis: 600, allowZeroValueOutputs: true },
    });
    expect(preview.inputClaimIds).toHaveLength(1);
    expect(preview.submissionId).toBeTruthy();
    expect(claimStore.list()).toHaveLength(1);
  });
});
