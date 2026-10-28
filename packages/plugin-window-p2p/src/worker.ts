import { WINDOW_P2P_WORKER_BRIDGE_CAPABILITY, type WindowP2pExecutorBridge } from "@keymaster/contracts/window-p2p";
import type { PluginConsumer, LifecycleScope } from "webloom-framework";
import { defineBuiltinWorkerPlugin, VAULT_WALLET_STATE_CAPABILITY } from "@keymaster/contracts";

export function createWindowP2pWorkerPlugin(ports: {
  bridge: WindowP2pExecutorBridge;
  revokeLease(identity: { ownerPublicKeyHex: string; sessionEpoch: string; instanceId: string }): void;
}) {
  return defineBuiltinWorkerPlugin("window-p2p", [WINDOW_P2P_WORKER_BRIDGE_CAPABILITY], context => {
    const walletState = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope);
    const wallet = walletState.snapshot();
    if (!wallet.activePublicKeyHex || wallet.status !== "unlocked") throw new Error("Window P2P requires an unlocked owner");
    const identity = { ownerPublicKeyHex: wallet.activePublicKeyHex, sessionEpoch: wallet.sessionEpoch, instanceId: context.instanceId };
    context.provide(WINDOW_P2P_WORKER_BRIDGE_CAPABILITY, Object.freeze({
      bind(consumer: PluginConsumer, scope: LifecycleScope): WindowP2pExecutorBridge {
        const assertActive = () => { context.scope.assertActive(); scope.assertActive(); const current = walletState.snapshot(); if (current.status !== "unlocked" || current.activePublicKeyHex !== identity.ownerPublicKeyHex || current.sessionEpoch !== identity.sessionEpoch) throw new Error("Worker bridge owner session replaced"); if (consumer.status !== "active") throw new Error("Worker bridge consumer has been revoked"); };
        assertActive();
        return Object.freeze({ get available() { assertActive(); return ports.bridge.available; },
          async request(operation: Parameters<WindowP2pExecutorBridge["request"]>[0], signal?: AbortSignal) {
            assertActive();
            const combined = AbortSignal.any([context.scope.signal, scope.signal, ...(signal ? [signal] : [])]);
            const result = await ports.bridge.request(operation, combined);
            assertActive(); return result;
          },
        });
      },
    }));
    context.scope.onRevoke(() => ports.revokeLease(identity));
  });
}

export { createWindowP2pWorkerRuntime, type WindowP2pExecutorLeaseState, type ActiveSatInboundHandler, type WindowP2pExecutorRequest } from "./workerRuntime.js";
