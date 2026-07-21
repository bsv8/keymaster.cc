import type { ComponentType } from "react";
import type { I18nText } from "./i18n.js";

/** Business declarations are owned by a plugin; runtime must not know their vocabulary. */
export type FeatureEntry =
  | { path: string; component: ComponentType; routeId?: never; visibleWhen?: (ctx: { unlocked: boolean }) => boolean }
  | { path: string; routeId: string; component?: never; visibleWhen?: (ctx: { unlocked: boolean }) => boolean };
export interface FeatureView {
  id: string;
  path: string;
  label: I18nText;
  description?: I18nText;
  breadcrumb?: readonly I18nText[];
  component: ComponentType;
}
export interface FeatureHomeProjection {
  id: string;
  space: { id: `${string}.${string}`; label: I18nText; order: number };
  order: number;
  component: ComponentType;
  visibleWhen?: (ctx: { unlocked: boolean }) => boolean;
}
export interface BusinessFeature {
  id: string;
  label: I18nText;
  description?: I18nText;
  order: number;
  icon?: string;
  entry: FeatureEntry;
  views?: readonly FeatureView[];
  home?: readonly FeatureHomeProjection[];
}
export interface BusinessDomain {
  id: string;
  label: I18nText;
  order: number;
  features: readonly BusinessFeature[];
}
export interface PluginBusinessContribution { domains: readonly BusinessDomain[]; }
