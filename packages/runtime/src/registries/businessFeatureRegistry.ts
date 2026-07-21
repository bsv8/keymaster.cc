import type { BusinessDomain, BusinessFeature, FeatureHomeProjection } from "@keymaster/contracts";

export interface BusinessFeatureRecord extends BusinessFeature { domainId: string; ownerPluginId: string; }
export interface BusinessHomeProjectionRecord extends FeatureHomeProjection { featureId: string; ownerPluginId: string; }
export interface BusinessFeatureRegistry {
  register(ownerPluginId: string, domain: BusinessDomain): void;
  unregisterDomain(domainId: string): void;
  listDomains(): BusinessDomain[];
  listFeatures(): BusinessFeatureRecord[];
  listHomeProjections(): BusinessHomeProjectionRecord[];
  byOwnerPluginId(pluginId: string): BusinessDomain[];
  subscribe(handler: () => void): () => void;
  _ids(): { domains: string[]; features: string[]; projections: string[] };
}

export function createBusinessFeatureRegistry(): BusinessFeatureRegistry {
  const domains = new Map<string, { ownerPluginId: string; domain: BusinessDomain }>();
  const features = new Map<string, BusinessFeatureRecord>();
  const projections = new Map<string, BusinessHomeProjectionRecord>();
  const spaces = new Map<string, { ownerPluginId: string; label: unknown; order: number }>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const order = <T extends { id: string; order: number }>(a: T, b: T) => a.order - b.order || a.id.localeCompare(b.id);
  return {
    register(ownerPluginId, domain) {
      if (domains.has(domain.id)) throw new Error(`Business domain id "${domain.id}" is already registered`);
      const featureIds = new Set<string>();
      const localSpaces = new Map<string, { label: unknown; order: number }>();
      for (const feature of domain.features) {
        if (featureIds.has(feature.id) || features.has(feature.id)) throw new Error(`Business feature id "${feature.id}" is already registered`);
        featureIds.add(feature.id);
        for (const projection of feature.home ?? []) {
          if (!projection.space.id.startsWith(`${ownerPluginId}.`)) throw new Error(`Business space "${projection.space.id}" must be namespaced by owner plugin "${ownerPluginId}"`);
          if (projections.has(projection.id)) throw new Error(`Business home projection id "${projection.id}" is already registered`);
          const existingSpace = spaces.get(projection.space.id) ?? (localSpaces.has(projection.space.id) ? { ownerPluginId, ...localSpaces.get(projection.space.id)! } : undefined);
          if (existingSpace && (existingSpace.ownerPluginId !== ownerPluginId || existingSpace.order !== projection.space.order || JSON.stringify(existingSpace.label) !== JSON.stringify(projection.space.label))) {
            throw new Error(`Business space "${projection.space.id}" has conflicting owner or definition`);
          }
          localSpaces.set(projection.space.id, { label: projection.space.label, order: projection.space.order });
        }
      }
      domains.set(domain.id, { ownerPluginId, domain });
      for (const feature of domain.features) {
        features.set(feature.id, { ...feature, domainId: domain.id, ownerPluginId });
        for (const projection of feature.home ?? []) {
          spaces.set(projection.space.id, { ownerPluginId, label: projection.space.label, order: projection.space.order });
          projections.set(projection.id, { ...projection, featureId: feature.id, ownerPluginId });
        }
      }
      notify();
    },
    unregisterDomain(domainId) {
      const record = domains.get(domainId);
      if (!record) throw new Error(`Business domain id "${domainId}" is not registered`);
      for (const feature of record.domain.features) {
        features.delete(feature.id);
        for (const projection of feature.home ?? []) {
          projections.delete(projection.id);
          if (![...projections.values()].some((item) => item.space.id === projection.space.id)) spaces.delete(projection.space.id);
        }
      }
      domains.delete(domainId); notify();
    },
    listDomains: () => [...domains.values()].map((r) => r.domain).sort(order),
    listFeatures: () => [...features.values()].sort((a, b) => {
      const da = domains.get(a.domainId)!.domain;
      const db = domains.get(b.domainId)!.domain;
      return order(da, db) || order(a, b);
    }),
    listHomeProjections: () => [...projections.values()].sort((a, b) => a.space.order - b.space.order || a.space.id.localeCompare(b.space.id) || order(a, b)),
    byOwnerPluginId: (pluginId) => [...domains.values()].filter((r) => r.ownerPluginId === pluginId).map((r) => r.domain),
    subscribe: (handler) => { listeners.add(handler); return () => listeners.delete(handler); },
    _ids: () => ({ domains: [...domains.keys()], features: [...features.keys()], projections: [...projections.keys()] })
  };
}
