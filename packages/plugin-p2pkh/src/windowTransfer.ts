import { assertP2pkhTransferRequestFields } from "@keymaster/contracts";
import type { bindWalletIdentity, P2pkhCoordinatorControl, P2pkhWorkerTransferBinding } from "@keymaster/contracts";

/** Window 的私有装配适配：业务请求不传身份，RPC 证据由绑定自动补入。 */
export function createWindowTransferBinding(input: {
  wallet: ReturnType<typeof bindWalletIdentity>;
  coordinator: Pick<P2pkhCoordinatorControl, "getBootstrapSnapshot" | "p2pkhTransferPrepare" | "p2pkhTransferSubmit">;
}): P2pkhWorkerTransferBinding {
  const { wallet, coordinator } = input;
  const service = Object.freeze({
    getGlobalSettings() {
      wallet.assertActive();
      return { ...coordinator.getBootstrapSnapshot().p2pkhSettings, bsvNetwork: wallet.identity.bsvNetwork };
    },
    async prepareTransfer(request: import("@keymaster/contracts").P2pkhTransferRequest) {
      wallet.assertActive();
      assertP2pkhTransferRequestFields(request);
      const result = await coordinator.p2pkhTransferPrepare({
        ...request,
        assetId: wallet.identity.bsvNetwork === "test" ? "bsvtest" : "bsv",
        network: wallet.identity.bsvNetwork,
        ownerPublicKeyHex: wallet.identity.publicKeyHex,
      });
      wallet.assertActive();
      if (result.status !== "ok") throw new Error(`P2PKH transfer prepare failed: ${result.status}`);
      if (result.value.ownerPublicKeyHex !== wallet.identity.publicKeyHex || result.value.network !== wallet.identity.bsvNetwork) throw new Error("Worker transfer preview identity mismatch");
      return result.value;
    },
    async submitTransfer(preview: unknown) {
      wallet.assertActive();
      const record = preview as { previewId?: string; ownerPublicKeyHex?: string; network?: string } | null;
      if (!record?.previewId || record.ownerPublicKeyHex !== wallet.identity.publicKeyHex || record.network !== wallet.identity.bsvNetwork) throw new Error("P2PKH transfer preview identity mismatch");
      const result = await coordinator.p2pkhTransferSubmit({ previewId: record.previewId, ownerPublicKeyHex: wallet.identity.publicKeyHex });
      wallet.assertActive();
      if (result.status !== "ok") throw new Error(`P2PKH transfer submit failed: ${result.status}`);
      return { ...result.value, localInputClaimIds: [...result.value.localInputClaimIds] };
    },
  });
  return Object.freeze({ async getService() { wallet.assertActive(); return service; } });
}
