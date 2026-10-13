import { describe, expect, it } from "vitest";
import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";
import { createIndexedDbWalletStore, createPlatformRootStore } from "@keymaster/platform-storage/coordinator";
import { createP2pkhFileRepository } from "@keymaster/plugin-p2pkh/coordinator";

describe("P2PKH 历史存储装配", () => {
  it("同一公钥的主网和测试网历史由外层身份根隔离", async () => {
    const wallet = createIndexedDbWalletStore({ databaseName: `p2pkh-history-${crypto.randomUUID()}` });
    // 使用合法的 secp256k1 公钥；两个网络复用同一把 Key。
    const owner = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const repositories = new Map<"main" | "test", ReturnType<typeof createP2pkhFileRepository>>();
    try {
      for (const bsvNetwork of ["main", "test"] as const) {
        const root = createPlatformRootStore({ identity: { bsvNetwork, publicKeyHex: owner }, store: wallet,
          generations: () => ({ walletGeneration: "wallet", sessionEpoch: "epoch", runGeneration: "run" }) });
        const files = await root.openModuleFileStore({ declaration: CENTRAL_STORAGE_DECLARATIONS.p2pkhFiles });
        const repository = createP2pkhFileRepository(files);
        repositories.set(bsvNetwork, repository);
        await repository.writeHistory(bsvNetwork, [{ txid: (bsvNetwork === "main" ? "aa" : "bb").repeat(32), height: 10 }]);
      }
      await expect(repositories.get("main")!.readHistory("main")).resolves.toEqual([{ txid: "aa".repeat(32), height: 10 }]);
      await expect(repositories.get("test")!.readHistory("test")).resolves.toEqual([{ txid: "bb".repeat(32), height: 10 }]);
      expect((await wallet.list()).objects.map(object => object.path).sort()).toEqual([
        `main/${owner}/p2pkh/history.json`, `test/${owner}/p2pkh/history.json`,
      ]);
    } finally { wallet.close(); }
  });

});
