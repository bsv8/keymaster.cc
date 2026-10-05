import { useCallback, useSyncExternalStore } from "react";
import type { LifecycleScope, PluginConsumer } from "webloom-framework";
/** UI exits as soon as its Scope is revoked, before deferred instance disposal finishes. */
export function useInstanceActive(consumer: PluginConsumer, scope: LifecycleScope): boolean {
  const snapshot = useCallback(() => consumer.status === "active" && scope.state === "active", [consumer, scope]);
  const subscribe = useCallback((changed: () => void) => {
    const offConsumer = consumer.subscribe(changed);
    const offScope = scope.onRevoke(changed);
    return () => { offConsumer(); offScope(); };
  }, [consumer, scope]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
