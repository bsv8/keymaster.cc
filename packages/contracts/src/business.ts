import type { I18nText } from "./i18n.js";

/** Navigation metadata; executable content is registered separately with Page. */
export interface FeatureEntry {
  path: string;
  routeId: string;
  visibleWhen?: (ctx: { unlocked: boolean }) => boolean;
  activeWhen?: (path: string) => boolean;
}
export interface BusinessFeature {
  id: string;
  label: I18nText;
  description?: I18nText;
  order: number;
  icon?: string;
  entry: FeatureEntry;
}
export interface BusinessDomain {
  id: string;
  label: I18nText;
  order: number;
  features: readonly BusinessFeature[];
}
export interface PluginBusinessContribution { domains: readonly BusinessDomain[]; }
