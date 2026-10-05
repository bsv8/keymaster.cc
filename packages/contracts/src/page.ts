// page 只公开注册和渲染入口，不公开贡献方组件、consumer 或私有服务列表。
import { defineCapability, type PluginConsumer, type LifecycleScope } from "webloom-framework";
import type { ScopedRegistryView } from "webloom-framework/advanced";
import type { ReactNode } from "react";
import type { I18nText } from "./i18n.js";

export interface PageUiLocation {
  readonly path: string;
  readonly children?: ReactNode;
  readonly width?: "narrow" | "wide" | "wizard";
  readonly params: Readonly<Record<string, string>>;
}
interface PageUiCommon { id: string; order?: number; label: I18nText; render(location: PageUiLocation): ReactNode }
export type PageUiContribution = PageUiCommon & (
  | { kind: "page"; path: string; settingsPlacement?: "after" | "embedded" }
  | { kind: "settings-block"; path: string }
  | { kind: "frame"; slot: PageFrameSlot }
  | { kind: "home"; slot: "main" | "aside"; space?: { id: string; label: I18nText; order: number }; visibleWhen?: (context: { unlocked: boolean }) => boolean }
  | { kind: "header"; slot: "topbar" | "above-header" }
);
export interface PageUiRegistration {
  register(entry: PageUiContribution): void;
  unregister(id: string): void;
}
export interface PageUiRegistry {
  /** 使用贡献方真实 consumer 与 Scope 创建框架注册视图，归属不接受自报字符串。 */
  bind(consumer: PluginConsumer, scope: LifecycleScope): ScopedRegistryView<PageUiRegistration>;
}
export type PageFrameSlot = "unlocked-shell" | "wallet-entry" | "wallet-guard" | "storage-guard" | "protocol-popup" | "onboarding" | "uri-action";
export interface PageUiRenderer {
  /** 精确路径优先，其次按静态段优先匹配 :param 路径。 */
  hasPage(path: string): boolean;
  hasSettings(path: string): boolean;
  revision(): number;
  renderPage(path: string): ReactNode;
  renderSettings(path: string): ReactNode;
  renderFrame(slot: PageFrameSlot, children?: ReactNode, width?: "narrow" | "wide" | "wizard"): ReactNode;
  renderHome(slot: "main" | "aside", unlocked: boolean): ReactNode;
  renderHeader(slot: "topbar" | "above-header"): ReactNode;
  subscribe(listener: () => void): () => void;
}
export const PAGE_UI_REGISTRY_CAPABILITY = defineCapability<PageUiRegistry>({ kind: "local", id: "page.ui.registry", version: "1" });
export const PAGE_UI_RENDERER_CAPABILITY = defineCapability<PageUiRenderer>({ kind: "local", id: "page.ui.renderer", version: "1" });
