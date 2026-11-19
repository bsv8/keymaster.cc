import { defineCapability } from "webloom-framework";
import type { AppDisplay } from "./appDisplay.js";
export interface AppSourceUrl { display: AppDisplay; url: string; origin: string; verifiedAt?: number }
export interface AppSourceFiles { display: AppDisplay; indexseedhashhex: string; verifiedAt?: number }
export interface AppSourceEntry { appVersion: string; appPublicKeyHex: string; name?: string; description?: string; icon?: string; urls: AppSourceUrl[]; files: AppSourceFiles[] }
/**
 * 来源标识由 Market 层分配并保证唯一：内置市场固定 market-default，
 * 第三方市场为 market_<随机值>；手工来源固定 manual。Connect 把来源 ID
 * 当作关联键，不复验其拼写；同一公钥可同时拥有多个来源。
 */
export const DEFAULT_MARKET_SOURCE_ID = "market-default";
export const MANUAL_SOURCE_ID = "manual";
export type AppSourceId = string;
/** 提交已验证发布：来源标识只在调用方名下有效，仅 Market 可声明依赖并调用。 */
export interface AppSourceSubmit {
  kind: "submit";
  sourceId: string;
  appPublicKeyHex: string;
  appVersion: string;
  publication: AppSourceEntry;
}
/** 标记来源失效：只解除指定来源，不删除应用。 */
export interface AppSourceInvalidate {
  kind: "invalidate";
  sourceId: string;
  appPublicKeyHex: string;
}
export type AppSourceChange = AppSourceSubmit | AppSourceInvalidate;
export type AppSourceChangeStatus = "applied" | "unchanged" | "lower-version-rejected" | "failed";
export interface AppSourceChangeResult {
  sourceId: string;
  appPublicKeyHex: string;
  status: AppSourceChangeStatus;
  reason?: string;
}
/**
 * Connect 提供的受限批次写入能力。
 *
 * 仅允许声明了依赖并获得授权的来源插件（Market）调用。调用方身份取自
 * WebLoom 受限上下文；请求内的来源标识只在该调用方名下有效。接口无需理解
 * 市场快照、pending 或抓取时间，逐条返回应用结果。
 */
export interface ConnectAppSourceBatch {
  applyChanges(changes: readonly AppSourceChange[]): Promise<readonly AppSourceChangeResult[]>;
}
export const CONNECT_APP_SOURCE_BATCH_CAPABILITY = defineCapability<ConnectAppSourceBatch>({ kind: "local", id: "connect.app-source-batch", version: "1" });
