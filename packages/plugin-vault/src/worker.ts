import {
  bindWalletIdentity, defineBuiltinWorkerPlugin, VAULT_WALLET_STATE_CAPABILITY, VAULT_WORKER_CRYPTO_CAPABILITY,
  COORDINATOR_CRYPTO_RPC_CAPABILITY, VAULT_WORKER_WALLET_CONTROL_CAPABILITY, type VaultWorkerWalletControl, type ActiveKeyCrypto, type VaultWalletState,
} from "@keymaster/contracts";
import type { LifecycleScope, PluginConsumer } from "webloom-framework";
import { createWalletStateAccess } from "./walletStateAccess.js";
import { createWorkerCryptoRpc, type WorkerCryptoRpcDependencies } from "./workerCryptoRpc.js";

export function createVaultWorkerRuntime(ports: {
  walletState: VaultWalletState;
  walletControl: VaultWorkerWalletControl;
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
        if (consumer.status !== "active") throw new Error("Wallet control consumer has been revoked");
        const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
          context.scope.assertActive(); scope.assertActive();
          const result = await operation();
          context.scope.assertActive(); scope.assertActive();
          return result;
        };
        return Object.freeze({
          coldStart: () => invoke(ports.walletControl.coldStart),
          persistence: () => invoke(ports.walletControl.persistence),
          execute: (control: Parameters<VaultWorkerWalletControl["execute"]>[0]) => invoke(() => ports.walletControl.execute(control)),
        });
      },
    }));
    context.handle(COORDINATOR_CRYPTO_RPC_CAPABILITY, createWorkerCryptoRpc(ports.cryptoRpc));
    context.provide(VAULT_WALLET_STATE_CAPABILITY, createWalletStateAccess(ports.walletState, context.scope));
    context.provide(VAULT_WORKER_CRYPTO_CAPABILITY, Object.freeze({
      async createActiveKeyCrypto() {
        context.scope.assertActive();
        const wallet = bindWalletIdentity(ports.walletState, context.scope.signal);
        const crypto = await ports.activeCrypto(wallet.identity.publicKeyHex, context.scope);
        try { context.scope.assertActive(); wallet.assertActive(); } catch (error) { crypto.dispose("vault-provider-revoked"); throw error; }
        return crypto;
      },
    }));
  });
  return { plugin, providerScope: () => providerScope };
}

export { createVaultWorkerKeys } from "./workerKeys.js";

export { createVaultWalletWorker } from "./workerWallet.js";

export { createVaultWorkerOperations } from "./workerOperations.js";
