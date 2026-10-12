import {
  defineBuiltinWorkerPlugin, VAULT_WALLET_STATE_CAPABILITY, VAULT_WORKER_CRYPTO_CAPABILITY,
  COORDINATOR_CRYPTO_RPC_CAPABILITY, VAULT_WORKER_WALLET_CONTROL_CAPABILITY, type VaultWorkerWalletControl, type ActiveKeyCrypto, type VaultWalletState,
} from "@keymaster/contracts";
import type { LifecycleScope, PluginConsumer } from "webloom-framework";
import { createWalletStateAccess } from "./walletStateAccess.js";
import { createWorkerCryptoRpc, type WorkerCryptoRpcDependencies } from "./workerCryptoRpc.js";

export function createVaultWorkerRuntime(ports: {
  walletState: VaultWalletState;
  walletControl: VaultWorkerWalletControl;
  isIssued(consumer: PluginConsumer, scope: LifecycleScope): boolean;
  cryptoRpc: WorkerCryptoRpcDependencies;
  activeCrypto(owner: string, providerScope?: LifecycleScope): Promise<ActiveKeyCrypto>;
}) {
  let providerScope: LifecycleScope | undefined;
  const plugin = defineBuiltinWorkerPlugin("vault", [VAULT_WALLET_STATE_CAPABILITY, VAULT_WORKER_CRYPTO_CAPABILITY, COORDINATOR_CRYPTO_RPC_CAPABILITY, VAULT_WORKER_WALLET_CONTROL_CAPABILITY], context => {
    providerScope = context.scope;
    context.scope.onRevoke(() => { if (providerScope === context.scope) providerScope = undefined; });
    context.provide(VAULT_WORKER_WALLET_CONTROL_CAPABILITY, Object.freeze({
      bind(consumer: PluginConsumer, scope: LifecycleScope): VaultWorkerWalletControl {
        context.scope.assertActive(); scope.assertActive();
        if (!ports.isIssued(consumer, scope)) throw new Error("Unissued wallet control consumer");
        const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
          context.scope.assertActive(); scope.assertActive();
          const result = await operation();
          context.scope.assertActive(); scope.assertActive();
          return result;
        };
        return Object.freeze({
          coldStart: () => invoke(ports.walletControl.coldStart),
          persistence: () => invoke(ports.walletControl.persistence), closeHardware: () => invoke(ports.walletControl.closeHardware),
          execute: (control: Parameters<VaultWorkerWalletControl["execute"]>[0]) => invoke(() => ports.walletControl.execute(control)),
        });
      },
    }));
    context.handle(COORDINATOR_CRYPTO_RPC_CAPABILITY, createWorkerCryptoRpc(ports.cryptoRpc));
    context.provide(VAULT_WALLET_STATE_CAPABILITY, createWalletStateAccess(ports.walletState, context.scope, ports.isIssued));
    context.provide(VAULT_WORKER_CRYPTO_CAPABILITY, Object.freeze({
      async createActiveKeyCrypto(owner: string) {
        context.scope.assertActive();
        const crypto = await ports.activeCrypto(owner, context.scope);
        try { context.scope.assertActive(); } catch (error) { crypto.dispose("vault-provider-revoked"); throw error; }
        return crypto;
      },
    }));
  });
  return { plugin, providerScope: () => providerScope };
}

export { createVaultWorkerKeys } from "./workerKeys.js";

export { createVaultWalletWorker } from "./workerWallet.js";

export { createVaultWorkerOperations } from "./workerOperations.js";
