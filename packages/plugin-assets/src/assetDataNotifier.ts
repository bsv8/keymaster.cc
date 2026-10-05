import type { AssetDataNotifier, AssetDataInvalidationEvent } from "@keymaster/contracts";
export function createAssetDataNotifier(): AssetDataNotifier {
  const listeners = new Set<(event: AssetDataInvalidationEvent) => void>();
  const pending = new Map<string, AssetDataInvalidationEvent>();
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    const events = [...pending.values()];
    pending.clear();
    for (const event of events) {
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* 观察者不能改变失效结果。 */ }
      }
    }
  };
  return {
    emit(event) {
      const key = `${event.providerId}:${event.publicKeyHex ?? "none"}`;
      const previous = pending.get(key);
      pending.set(key, previous ? {
        ...previous,
        kinds: [...new Set([...previous.kinds, ...event.kinds])],
        revision: Math.max(previous.revision, event.revision),
        ...(previous.utxoSeqs || event.utxoSeqs ? {
          utxoSeqs: {
            ...(previous.utxoSeqs?.main !== undefined || event.utxoSeqs?.main !== undefined
              ? { main: Math.max(previous.utxoSeqs?.main ?? 0, event.utxoSeqs?.main ?? 0) }
              : {}),
            ...(previous.utxoSeqs?.test !== undefined || event.utxoSeqs?.test !== undefined
              ? { test: Math.max(previous.utxoSeqs?.test ?? 0, event.utxoSeqs?.test ?? 0) }
              : {}),
          },
        } : {}),
      } : event);
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** 创建延迟模块 K-V 句柄；领域 authority 仍在最终 I/O 边界复核绑定。 */