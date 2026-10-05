import { defineCapability, type LifecycleScope, type PluginConsumer } from "webloom-framework";
import type { ScopedRegistryView } from "webloom-framework/advanced";
import type { ReactNode } from "react";
import type { I18nText } from "./i18n.js";

export interface UriActionDescription { readonly id: string; readonly label: I18nText; readonly description?: I18nText }
/** resolve 必须只解析输入；业务确认、写入和执行只能发生在内部 UI。 */
export interface UriActionHandler {
  readonly id: string;
  readonly order?: number;
  resolve(input: string): readonly UriActionDescription[];
  render(actionId: string, input: string, close: () => void): ReactNode;
}
export interface UriActionRegistration { register(handler: UriActionHandler): void; unregister(id: string): void }
export interface UriActionRegistry { bind(consumer: PluginConsumer, scope: LifecycleScope): ScopedRegistryView<UriActionRegistration> }
export interface UriActionCandidate { readonly id: string; readonly pluginId: string; readonly label: I18nText; readonly description?: I18nText }
/** 标识仅属于当前调用实例；不包含原始输入、组件、处理器或业务服务。 */
export interface UriActionResolution { readonly id: string; readonly candidates: readonly UriActionCandidate[] }
export interface UriActionView {
  resolve(input: string): UriActionResolution;
  activate(resolutionId: string, candidateId: string): void;
  release(resolutionId: string): void;
}
export interface UriActionResolver { bind(consumer: PluginConsumer, scope: LifecycleScope): UriActionView }
export interface ScanUiView { open(input?: string): void }
export interface ScanUiAccess { bind(consumer: PluginConsumer, scope: LifecycleScope): ScanUiView }
export const URI_ACTION_REGISTRY_CAPABILITY = defineCapability<UriActionRegistry>({ kind: "local", id: "uri.action.registry", version: "1" });
export const URI_ACTION_RESOLVER_CAPABILITY = defineCapability<UriActionResolver>({ kind: "local", id: "uri.action.resolver", version: "1" });
export const SCAN_UI_CAPABILITY = defineCapability<ScanUiAccess>({ kind: "local", id: "scan.ui", version: "1" });
