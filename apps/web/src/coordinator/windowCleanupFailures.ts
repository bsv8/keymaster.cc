import type { PluginHost } from "@keymaster/runtime";

/** Scope publishes resource failures BEFORE its entire teardown settles.
 * Watching those native events avoids hiding the first error behind another
 * plugin/resource that is still exiting. The lock-attempt key fences deduping.
 */
export function watchWindowCleanupFailures(host: PluginHost, attemptKey: () => string | undefined, report: (details: string) => void): () => void {
  let observedAttempt: string | undefined;
  const seen = new Set<string>();
  return host.subscribe(() => {
    const attempt = attemptKey();
    if (!attempt) return;
    if (observedAttempt !== attempt) { observedAttempt = attempt; seen.clear(); }
    for (const pluginId of host.manifests()) {
      const ownerBound = host.getManifest(pluginId)?.units?.some(unit => unit.runtime === "window-main" && (unit.scopeKind === "owner-session" || unit.scopeKind === "connect-session"));
      if (!ownerBound) continue;
      const scope = host.scope(pluginId);
      if (!scope || scope.state === "active") continue;
      for (const resource of scope.resources()) {
        if (resource.state !== "pending" || !resource.error) continue;
        const key = `${scope.identity.instanceId}:${resource.resourceId}:${resource.error}`;
        if (seen.has(key)) continue;
        seen.add(key);
        report(`${pluginId}: ${resource.error}\n${JSON.stringify({ scope: scope.identity, resource }, null, 2)}`);
      }
    }
  });
}
