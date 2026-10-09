import type { ActiveKeyCrypto, BorrowedModuleFileStore, ForumService, ForumWorkerNetwork, MsFileContentService, P2pkhWorkerProtocolBinding, VaultWorkerCrypto, WocService } from "@keymaster/contracts";
import { createForumService } from "./domain/forumService.js";
import { createForumFundingSource } from "./domain/forumFundingSource.js";
import { createForumSelfOutputService } from "./domain/forumSelfOutputs.js";
import { createForumRepository } from "./storage/forumRepository.js";
import { hexToBytes } from "./protocol/bytes.js";

export interface ForumWorkerServiceDependencies {
  owner: string;
  epoch: string;
  assertActive(): void;
  signal?: AbortSignal;
  storage: BorrowedModuleFileStore;
  content: MsFileContentService;
  crypto: VaultWorkerCrypto;
  wallet: P2pkhWorkerProtocolBinding;
  network: ForumWorkerNetwork;
  query: WocService;
}

/** One owner-session instance owns all task mutation; Window only calls its RPC. */
export async function createForumWorkerService(deps: ForumWorkerServiceDependencies) {
  let disposed = false;
  const assertActive = () => { if (disposed) throw new Error("Forum Worker instance disposed"); deps.assertActive(); };
  const wallet = await deps.wallet.getService();
  assertActive();
  const repository = createForumRepository(deps.storage);
  const funding = createForumFundingSource({ protocolSpend: () => wallet.spend, funding: () => wallet.funding, protectedOutpoints: wallet.protectedOutpoints, woc: deps.query, repository });
  let crypto: ActiveKeyCrypto | undefined;
  let creatingCrypto: Promise<ActiveKeyCrypto> | undefined;
  const activeCrypto = async () => {
    assertActive();
    if (crypto) return crypto;
    creatingCrypto ??= (async () => {
      const candidate = await deps.crypto.createActiveKeyCrypto(deps.owner);
      try { assertActive(); } catch (error) { candidate.dispose("forum-revoked"); throw error; }
      const scoped: ActiveKeyCrypto = Object.freeze<ActiveKeyCrypto>({
        getIdentity: () => { assertActive(); return candidate.getIdentity(); },
        async signDigest(input) { assertActive(); const result = await candidate.signDigest(input); assertActive(); return result; },
        async deriveP2pkhAddress(input) { assertActive(); const result = await candidate.deriveP2pkhAddress(input); assertActive(); return result; },
        dispose: reason => candidate.dispose(reason),
      });
      crypto = scoped; return scoped;
    })();
    const pending = creatingCrypto;
    try { return await pending; } finally { if (creatingCrypto === pending) creatingCrypto = undefined; }
  };
  const raw = async (network: "main" | "test", txid: string, signal?: AbortSignal) => {
    assertActive();
    if (!deps.query.getRawTransaction) throw new Error("Chain raw source unavailable");
    const value = await deps.query.getRawTransaction(network, txid, signal ? { signal } : {});
    assertActive();
    if (!/^(?:[a-fA-F0-9]{2})+$/u.test(value) || value.length > 2 * 1024 * 1024) throw new Error("Forum chain raw is invalid or oversized");
    return hexToBytes(value);
  };
  const selfOutputs = createForumSelfOutputService({ ownerPublicKeyHex: () => { assertActive(); return deps.owner; },
    getRawTransaction: raw, protocolSpend: () => wallet.spend, protectedOutpoints: wallet.protectedOutpoints,
    deriveOwnerAddress: async (owner, network) => { assertActive(); const key = await deps.crypto.createActiveKeyCrypto(owner); try { const result = await key.deriveP2pkhAddress({ publicKeyHex: owner, network }); assertActive(); return result.address; } finally { key.dispose("forum-address-derived"); } },
  });
  const service = createForumService({ repository, ...(deps.signal ? { signal: deps.signal } : {}), content: deps.content, fundingSource: () => funding,
    ownerPublicKeyHex: () => { assertActive(); return deps.owner; },
    sessionEpoch: () => { assertActive(); return deps.epoch; },
    activeCrypto,
    protocolSpend: () => { assertActive(); return wallet.spend; },
    dispatchP2p: (operation, signal) => deps.network.roundtrip(operation as Parameters<ForumWorkerNetwork["roundtrip"]>[0], signal),
    fetchRootRaw: (input, options) => raw(input.network, input.txid, options?.signal),
    selfOutputs: () => { assertActive(); return selfOutputs; },
    async observeChain(network, txid, signal) { const result = await deps.query.getTransactionObservation(network, txid, signal ? { signal } : {}); assertActive(); return result.observation === "confirmed" ? "confirmed" : result.observation === "unconfirmed" ? "mempool" : "unknown"; },
    async observeBroadcast(input) { const result = await wallet.observer.observeProtocolSubmission(input); assertActive(); return result === "not-dispatched" ? "definitely-not-dispatched" : result === "rejected" || result === "dropped" ? "unknown" : result; },
  });
  return { service, dispose() { disposed = true; crypto?.dispose("forum-worker-revoked"); crypto = undefined; selfOutputs.dispose("forum-worker-revoked"); } };
}
