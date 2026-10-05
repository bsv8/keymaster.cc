import type { BusinessDomain, BusinessFeature, BusinessFeatureRegistry as Registry } from "@keymaster/contracts";

export interface BusinessFeatureRecord extends BusinessFeature { domainId: string; ownerPluginId: string }
export interface BusinessFeatureRegistry extends Registry {
  _ids(): { domains: string[]; features: string[] };
}

/** Navigation metadata only. Components and home projections belong to Page's private UI registry. */
export function createBusinessFeatureRegistry(): BusinessFeatureRegistry {
  const domains = new Map<string, { ownerPluginId: string; domain: BusinessDomain }>();
  const features = new Map<string, BusinessFeatureRecord>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach(listener => listener());
  const order = <T extends { id: string; order: number }>(a: T, b: T) => a.order - b.order || a.id.localeCompare(b.id);
  const domainFeatures = (id: string) => [...features.values()].filter(feature => feature.domainId === id).sort(order);
  const validate = (feature: BusinessFeature) => {
    const input = feature as BusinessFeature & { home?: unknown; views?: unknown };
    if (input.home !== undefined || input.views !== undefined || "component" in input.entry || !input.entry.routeId) throw new Error("Business entries accept navigation metadata; register executable UI with Page");
    if (!feature.id || !Number.isFinite(feature.order) || !feature.entry.path.startsWith("/")) throw new Error("Invalid business entry");
    if (features.has(feature.id)) throw new Error(`Business feature id "${feature.id}" is already registered`);
  };
  return {
    register(ownerPluginId, domain) {
      if (domains.has(domain.id)) throw new Error(`Business domain id "${domain.id}" is already registered`);
      const ids = new Set<string>();
      for (const feature of domain.features) {
        validate(feature);
        if (ids.has(feature.id)) throw new Error(`Business feature id "${feature.id}" is already registered`);
        ids.add(feature.id);
      }
      domains.set(domain.id, { ownerPluginId, domain });
      for (const feature of domain.features) features.set(feature.id, { ...feature, domainId: domain.id, ownerPluginId });
      notify();
    },
    registerFeature(ownerPluginId, domainId, feature) {
      validate(feature);
      features.set(feature.id, { ...feature, domainId, ownerPluginId }); notify();
    },
    unregisterFeature(id) {
      if (!features.delete(id)) throw new Error(`Business feature id "${id}" is not registered`);
      notify();
    },
    unregisterDomain(id) {
      const record = domains.get(id);
      if (!record) throw new Error(`Business domain id "${id}" is not registered`);
      for (const feature of domainFeatures(id)) if (feature.ownerPluginId === record.ownerPluginId) features.delete(feature.id);
      domains.delete(id); notify();
    },
    listDomains: () => [...domains.values()].map(record => ({ ...record.domain, features: domainFeatures(record.domain.id) })).sort(order),
    listFeatures: () => [...features.values()].filter(feature => domains.has(feature.domainId)).sort((a, b) => order(domains.get(a.domainId)!.domain, domains.get(b.domainId)!.domain) || order(a, b)),
    byOwnerPluginId: id => [...domains.values()].filter(record => record.ownerPluginId === id).map(record => ({ ...record.domain, features: domainFeatures(record.domain.id) })),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    _ids: () => ({ domains: [...domains.keys()], features: [...features.keys()] }),
  };
}
