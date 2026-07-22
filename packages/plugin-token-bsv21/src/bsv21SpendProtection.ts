// BSV-21 受保护 outpoint provider。
//
// 设计缘由：
//   - 选币层需要知道哪些 outpoint 不能被 plain funding 使用；
//   - 当前 snapshot DB 还没有完整 outpoint 真值时，provider 会返回空；
//   - 一旦 snapshot 里回填 outpoint，这里会自动开始保护对应输入。

import type { AssetDataNotifier, KeyspaceService, ProtectedOutpointProvider } from "@keymaster/contracts";
import type { Bsv21Db } from "./bsv21Db.js";

export interface Bsv21SpendProtectionOptions {
  db: Bsv21Db;
  keyspace: KeyspaceService;
  assetDataNotifier?: AssetDataNotifier;
}

export function createBsv21SpendProtectionProvider(options: Bsv21SpendProtectionOptions): ProtectedOutpointProvider {
  if (!options || !options.db || !options.keyspace) {
    throw new Error("createBsv21SpendProtectionProvider: db and keyspace are required");
  }
  const listeners = new Set<() => void>();
  let offNotifier: (() => void) | undefined;
  if (options.assetDataNotifier) {
    offNotifier = options.assetDataNotifier.subscribe((event) => {
      if (event.providerId === "bsv21") {
        for (const listener of listeners) listener();
      }
    });
  }

  return {
    id: "bsv21",
    ownerPluginId: "token-bsv21",
    async listProtectedOutpoints() {
      const state = options.keyspace.active();
      if (!state.activePublicKeyHex) return [];
      const snapshots = await options.db.list();
      return snapshots
        .flatMap((snapshot) => {
          if (!snapshot.outpoint) return [];
          const [txid, voutStr] = snapshot.outpoint.split("_");
          const vout = Number(voutStr);
          if (!txid || !Number.isFinite(vout)) return [];
          return [{
            txid,
            vout,
            network: snapshot.network,
            ownerPluginId: "token-bsv21",
            publicKeyHex: state.activePublicKeyHex,
            kind: "bsv21",
            reason: `BSV-21 origin ${snapshot.origin}`
          }];
        });
    },
    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispose() {
      offNotifier?.();
      offNotifier = undefined;
    }
  };
}
