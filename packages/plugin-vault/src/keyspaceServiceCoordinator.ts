// 页面侧 Keyspace facade。
//
// Keyspace 只暴露 key 生命周期；存储绑定通过 Host/Coordinator 内部权威
// 注入，业务插件只能使用 Host 已绑定的 ctx.storage。

import type {
  CoordinatorValueResult,
  KeyIdentity,
  KeyspaceService,
  SessionCoordinatorClient
} from "@keymaster/contracts";
import type { SessionStateMirror } from "./sessionStateMirror.js";
import type { MessageBus } from "@keymaster/runtime";

type CoordinatorClientLike = Pick<SessionCoordinatorClient, "backgroundCancelByKey" | "vaultOperation">;
export type KeyspaceCoordinatorHandle = KeyspaceService;

function unwrap<T>(result: CoordinatorValueResult<unknown>, operation: string): T {
  if (result.status === "ok") return result.value as T;
  const message = "message" in result
    ? result.message
    : result.status === "blocked"
      ? (typeof result.reason === "string" ? result.reason : result.reason.fallback)
      : `${operation} failed: ${result.status}`;
  throw new Error(message);
}

export function createKeyspaceServiceCoordinator(client: CoordinatorClientLike, mirror: SessionStateMirror, messageBus: MessageBus): KeyspaceCoordinatorHandle {
  const handlers = new Set<(value: { activePublicKeyHex?: string; generation?: number }) => void>();
  let state = mirror.getSnapshot();
  mirror.subscribe((snapshot) => {
    const previous = state;
    state = snapshot;
    if (previous.activePublicKeyHex !== snapshot.activePublicKeyHex || previous.keyspaceGeneration !== snapshot.keyspaceGeneration) {
      for (const handler of handlers) handler({ activePublicKeyHex: snapshot.activePublicKeyHex, generation: snapshot.keyspaceGeneration });
    }
  });

  const current = () => mirror.getSnapshot();
  const requireReady = (): string => {
    const snapshot = current();
    if (snapshot.vaultStatus !== "unlocked" || !snapshot.activePublicKeyHex) throw new Error("Active key is unavailable");
    return snapshot.activePublicKeyHex.toLowerCase();
  };

  async function prepareDeleteKeyInternal(publicKeyHex: string): Promise<void> {
    const cancelResult = await client.backgroundCancelByKey(publicKeyHex);
    if (cancelResult.status !== "accepted" && cancelResult.status !== "ok") throw new Error("Background cancellation failed");
    messageBus.publish("key.deleting", { publicKeyHex });
  }

  return {
    async listKeys() { return unwrap<KeyIdentity[]>(await client.vaultOperation("listKeys"), "listKeys"); },
    async getKey(publicKeyHex) { return unwrap<KeyIdentity | undefined>(await client.vaultOperation("getKey", { publicKeyHex }), "getKey"); },
    active: () => ({ activePublicKeyHex: current().activePublicKeyHex, generation: current().keyspaceGeneration }),
    selected: () => current().selectedPublicKeyHex,
    async setActive() { throw new Error("Active key changes must go through vault.activateKey with password"); },
    requireActiveKey: () => {
      const publicKeyHex = requireReady();
      return { publicKeyHex, label: "", capabilities: [], createdAt: "" };
    },
    onActiveKeyChanged(handler) {
      handlers.add(handler);
      const snapshot = current();
      handler({ activePublicKeyHex: snapshot.activePublicKeyHex, generation: snapshot.keyspaceGeneration });
      return () => handlers.delete(handler);
    },
    async prepareDeleteKey(publicKeyHex) { await prepareDeleteKeyInternal(publicKeyHex); },
    async deleteKey(input) {
      const keys = unwrap<KeyIdentity[]>(await client.vaultOperation("listKeys"), "listKeys");
      const target = keys.find((key) => key.publicKeyHex === input.publicKeyHex);
      if (!target) throw new Error("Key not found");
      if (!target.label) throw new Error("Key label is unavailable");
      if (input.confirmationLabel !== target.label) throw new Error("Key label mismatch");
      await prepareDeleteKeyInternal(input.publicKeyHex);
      await unwrap<void>(await client.vaultOperation({ type: "deleteKey", publicKeyHex: input.publicKeyHex, confirmationLabel: input.confirmationLabel }), "deleteKey");
      messageBus.publish("key.deleted", { publicKeyHex: input.publicKeyHex });
    },
    isInitializing: () => false,
    onInitializationChange: () => () => undefined
  };
}
