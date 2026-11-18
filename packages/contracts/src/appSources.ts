import { defineCapability } from "webloom-framework";
import type { AppDisplay } from "./appDisplay.js";
export interface AppSourceUrl { display: AppDisplay; url: string; origin: string; verifiedAt?: number }
export interface AppSourceFiles { display: AppDisplay; indexseedhashhex: string; verifiedAt?: number }
export interface AppSourceEntry { appVersion: string; appPublicKeyHex: string; name?: string; description?: string; icon?: string; urls: AppSourceUrl[]; files: AppSourceFiles[] }
/** Market only fetches directory material; wallet settings and application state belong to Connect. */
export interface AppMarketSync { sync(): Promise<readonly AppSourceEntry[]> }
export const APP_MARKET_SYNC_CAPABILITY = defineCapability<AppMarketSync>({ kind: "local", id: "market.sync", version: "1" });
/** Invalidates source material, never grants the caller authority to delete an application. */
export interface AppSourceInvalidation { invalidateSource(applicationKeys: readonly string[]): Promise<void> }
export const APP_SOURCE_INVALIDATION_CAPABILITY = defineCapability<AppSourceInvalidation>({ kind: "local", id: "connect.app-source", version: "1" });
