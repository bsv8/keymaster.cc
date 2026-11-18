import {validateAppVersion,compareAppVersions} from "./publicationShape.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { assertAppPublicKeyHex, validateAppDisplay, traceDev, type AppDisplay, type AppSourceEntry, type AppMarketSync } from "@keymaster/contracts";
export const APP_DIRECTORY_TTL_MS = 600000;
export type AppMarketEntryInput = AppSourceEntry;
import type { AppDirectoryEntry, AppLocalInput, AppPendingEntry, AppDirectoryDocument, AppDirectoryRepository } from "./appDirectoryTypes.js";
export type { AppDirectoryEntry, AppLocalInput, AppPendingEntry } from "./appDirectoryTypes.js";
export interface AppLaunchTarget { url: string; name?: string; description?: string; expectedAppPublicKeyHex?: string; pendingId?: string; marketListed: boolean; local: boolean; favorite: boolean }
export interface AppDirectorySnapshot { entries: AppDirectoryEntry[]; favoriteKeys: string[]; pending: AppPendingEntry[]; deletedKeys: string[]; loading: boolean; error: string | null; persistError: string | null; lastSuccessfulFetchAt: number | null }
export interface AppDirectoryService {
 subscribe(listener: () => void): () => void;
 getSnapshot(): AppDirectorySnapshot;
 list(): Promise<AppDirectorySnapshot>;
 observePublication(material: AppSourceEntry): Promise<void>;
 toggleFavorite(key: string, material?: AppSourceEntry): Promise<void>;
 addLocal(input: AppLocalInput): Promise<AppPendingEntry>;
 invalidateSource(keys: readonly string[]): Promise<void>;
 invalidateLocal(key: string): Promise<void>;
 reconcile(): Promise<void>;
 removePending(id: string): Promise<void>;
 select(key: string, selection: { url?: string; indexseedhashhex?: string }): Promise<void>;
 resolvePending(id: string, key: string, url: string, display: AppDisplay): Promise<void>;
 restoreApp(key: string): Promise<void>;
 deleteApp(key: string): Promise<void>;
}
export type WindowAppDirectory = Pick<AppDirectoryService,
 "subscribe" | "getSnapshot" | "list" | "toggleFavorite" | "addLocal" |
 "invalidateSource" | "invalidateLocal" | "removePending" | "select" | "deleteApp">;
export interface AppDirectoryServiceOptions {
 repository: AppDirectoryRepository;
 getMarket(): AppMarketSync | undefined;
 hasUsage(key: string): boolean;
 forgetApp(key: string, commit: () => Promise<void>): Promise<void>;
 assertActive(): void;
 now?: () => number;
}
export function canonicalAppOrigin(input:string):string|null {try{const u=new URL(input);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.origin==="null")return null;return u.origin}catch{return null}}
function fullURL(input:unknown):string {if(typeof input!=="string"||!canonicalAppOrigin(input))throw new Error("Invalid App URL");return new URL(input).href}
function seed(input:unknown):string {if(typeof input!=="string"||!/^[0-9a-f]{64}$/.test(input))throw new Error("Invalid Files seed");return input}
function channel(input:{url?:string;indexseedhashhex?:string}) {if((input.url===undefined)===(input.indexseedhashhex===undefined))throw new Error("Exactly one URL or seed is required");return input.url!==undefined?{url:fullURL(input.url)}:{indexseedhashhex:seed(input.indexseedhashhex)}}
function entry(input:unknown, allowEmpty = false):AppMarketEntryInput {
 if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid market entry");const e=input as AppMarketEntryInput;
 const appVersion=validateAppVersion(e.appVersion);const appPublicKeyHex=assertAppPublicKeyHex(e.appPublicKeyHex);secp256k1.Point.fromHex(appPublicKeyHex);if(!Array.isArray(e.urls)||!Array.isArray(e.files)||!allowEmpty&&!e.urls.length&&!e.files.length)throw new Error("Invalid App channels");
 const urls=e.urls.map(u=>{if(!u||typeof u!=="object"||canonicalAppOrigin(u.url)!==u.origin)throw new Error("Invalid URL entry");return {url:fullURL(u.url),origin:u.origin,display:validateAppDisplay(u.display)}});
 const files=e.files.map(f=>({indexseedhashhex:seed(f?.indexseedhashhex),display:validateAppDisplay(f?.display)}));
 if(new Set(urls.map(u=>u.url)).size!==urls.length||new Set(files.map(f=>f.indexseedhashhex)).size!==files.length)throw new Error("Duplicate App channel");
 const display:Pick<AppMarketEntryInput,"name"|"description"|"icon">={};for(const k of ["name","description","icon"] as const){if(e[k]!==undefined){if(typeof e[k]!=="string")throw new Error("Invalid App display field");display[k]=e[k]}}
 if(urls.length>1||files.length>1)throw new Error("Multiple current publication channels");return {appVersion,appPublicKeyHex,...display,urls,files};
}
function validateMarket(input:unknown):AppMarketEntryInput[]{if(!Array.isArray(input))throw new Error("Invalid market snapshot");const result=input.map(value => entry(value));if(new Set(result.map(e=>e.appPublicKeyHex)).size!==result.length)throw new Error("Duplicate App public key");return result}
/** Keep the user's choice only while that exact channel still exists. */
function normalizeSelection(app: AppDirectoryEntry): void {
 const selected = app.selected;
 if (selected && !(selected.url ? app.urls.some(u => u.url === selected.url) : app.files.some(f => f.indexseedhashhex === selected.indexseedhashhex))) delete app.selected;
}
function mergeMarket(previous: AppDirectoryEntry | undefined, incoming: AppSourceEntry): AppDirectoryEntry {
 if(previous && compareAppVersions(incoming.appVersion,previous.appVersion)<0)throw new Error("Older appVersion rejected");
 return {...incoming, favorite:previous?.favorite??false, local:previous?.local??false, marketListed:true};
}

/** Connect owns one application directory. No per-source documents or source management service. */
export function createAppDirectoryService(options: AppDirectoryServiceOptions): AppDirectoryService {
 const repo = options.repository, now = options.now ?? (() => Date.now());
 let state: AppDirectoryDocument = { version: 3, apps: {}, pending: [], deletedKeys: [], lastSuccessfulFetchAt: null };
 let revision: number | undefined, blocked: Error | undefined;
 let loading = false, error: string | null = null, persistError: string | null = null;
 const listeners = new Set<() => void>();
 let snapshot: AppDirectorySnapshot = { entries: [], favoriteKeys: [], pending: [], deletedKeys: [], loading, error, persistError, lastSuccessfulFetchAt: null };
 const publish = () => {
   const entries = Object.values(state.apps).map(value => {
     const e = structuredClone(value);
     normalizeSelection(e);
     const display = (e.selected?.url ? e.urls.find(u => u.url === e.selected?.url) : e.selected?.indexseedhashhex ? e.files.find(f => f.indexseedhashhex === e.selected?.indexseedhashhex) : e.urls[0] ?? e.files[0])?.display;
     if (display) Object.assign(e, display);
     return e;
   }).sort((a,b) => Number(b.favorite) - Number(a.favorite));
   snapshot = { entries, favoriteKeys: entries.filter(e => e.favorite).map(e => e.appPublicKeyHex), pending: state.pending, deletedKeys: state.deletedKeys, loading, error, persistError, lastSuccessfulFetchAt: state.lastSuccessfulFetchAt };
   listeners.forEach(listener => listener());
 };
 let ready: Promise<void> | undefined;
 const ensureReady = () => ready ??= (async () => {
   try {
     options.assertActive();
     const record = await repo.read();
     options.assertActive();
     if (!record) return;
     const doc = record.document;
     if (doc?.version !== 3 || !doc.apps || !Array.isArray(doc.pending) || !Array.isArray(doc.deletedKeys)) throw new Error("Invalid Connect application directory");
     if (doc.lastSuccessfulFetchAt !== null && (!Number.isFinite(doc.lastSuccessfulFetchAt) || doc.lastSuccessfulFetchAt < 0)) throw new Error("Invalid directory timestamp");
     for (const [key, value] of Object.entries(doc.apps)) {
       if (entry(value, true).appPublicKeyHex !== key || typeof value.favorite !== "boolean" || typeof value.local !== "boolean" || typeof value.marketListed !== "boolean") throw new Error("Invalid App state");
       if (value.selected) channel(value.selected);
       for (const channel of [...value.urls, ...value.files]) {
         if (channel.userAdded !== undefined && channel.userAdded !== true || channel.marketListed !== undefined && channel.marketListed !== true) throw new Error("Invalid App channel settings");
       }
     }
     for (const key of doc.deletedKeys) assertAppPublicKeyHex(key);
     if (new Set(doc.pending.map(p => p.pendingId)).size !== doc.pending.length) throw new Error("Duplicate pending identity");
     for (const p of doc.pending) { if (!p.pendingId || "appPublicKeyHex" in p) throw new Error("Invalid pending identity"); channel(p); }
     state = doc; revision = record.revision;
   } catch (cause) { blocked = cause instanceof Error ? cause : new Error(String(cause)); persistError = blocked.message; }
   finally { publish(); }
 })();
 let queue: Promise<void> = Promise.resolve();
 const transaction = (change: (doc: AppDirectoryDocument) => void, forgetKey?: string) => {
   const work = queue.then(async () => {
     await ensureReady(); options.assertActive(); if (blocked) throw blocked;
     const next = structuredClone(state); change(next); options.assertActive();
     for (const app of Object.values(next.apps)) normalizeSelection(app);
     const commit = async () => {
       options.assertActive();
       const stored = await repo.write(next, { ifRevision: revision, forgetKey });
       options.assertActive(); revision = stored; state = next; persistError = null; publish();
     };
     if (forgetKey) await options.forgetApp(forgetKey, commit); else await commit();
   });
   queue = work.catch(cause => { traceDev("connect.apps", "write.failed", () => ({ error: cause })); persistError = cause instanceof Error ? cause.message : String(cause); publish(); });
   return work;
 };
 const invalidate = (doc: AppDirectoryDocument, keys: readonly string[]) => {
   for (const key of keys) {
     assertAppPublicKeyHex(key);
     const app = doc.apps[key]; if (!app) continue;
     app.marketListed = false;
     for (const channel of [...app.urls, ...app.files]) delete channel.marketListed;
     // History unavailable is treated as retained by hasUsage; never infer absence from a read failure.
     if (!app.local && !app.favorite && !options.hasUsage(key)) delete doc.apps[key];
     traceDev("connect.apps", "source.invalidated", () => ({ applicationKey: key, retained: !!doc.apps[key] }));
   }
 };
 const canPrune = (app: AppDirectoryEntry) => !app.marketListed && !app.local && !app.favorite && !options.hasUsage(app.appPublicKeyHex);
 const reconcile = async () => {
   await ensureReady(); options.assertActive(); if (blocked) throw blocked;
   if (!Object.values(state.apps).some(canPrune)) return;
   await transaction(doc => { for (const [key, app] of Object.entries(doc.apps)) if (canPrune(app)) delete doc.apps[key]; });
 };
 let inflight: Promise<AppDirectorySnapshot> | undefined;
 const service: AppDirectoryService = {
   subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
   getSnapshot: () => snapshot,
   list() {
     if (inflight) return inflight;
     return inflight = (async () => {
       await ensureReady(); if (blocked) return snapshot;
       try { await reconcile(); } catch (cause) { persistError = cause instanceof Error ? cause.message : String(cause); publish(); return snapshot; }
       if (state.lastSuccessfulFetchAt !== null && now() - state.lastSuccessfulFetchAt < APP_DIRECTORY_TTL_MS) return snapshot;
       loading = true; publish();
       try {
         const source = options.getMarket(); if (!source) throw new Error("Market synchronizer unavailable");
         const entries = validateMarket(await source.sync()), completed = now();
         await transaction(doc => {
           invalidate(doc, Object.values(doc.apps).filter(app => app.marketListed && !entries.some(e => e.appPublicKeyHex === app.appPublicKeyHex)).map(e => e.appPublicKeyHex));
           for (const incoming of entries) {
             const key = incoming.appPublicKeyHex;
             if (doc.deletedKeys.includes(key)) continue;
             const previous = doc.apps[key];
             doc.apps[key] = mergeMarket(previous, incoming);
           }
           doc.lastSuccessfulFetchAt = completed;
         });
         error = null;
       } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); traceDev("connect.apps", "sync.failed", () => ({ error: cause })); }
       finally { loading = false; publish(); }
       return snapshot;
     })().finally(() => { inflight = undefined; });
   },
   observePublication(material) {
     const incoming=entry(material);
     return transaction(doc=>{const old=doc.apps[incoming.appPublicKeyHex];doc.apps[incoming.appPublicKeyHex]={...mergeMarket(old,incoming),marketListed:old?.marketListed??false,local:old?.local??false};});
   },
   toggleFavorite(key, material) {
     assertAppPublicKeyHex(key);
     return transaction(doc => {
       let app = doc.apps[key];
       if (!app && material) app = doc.apps[key] = { ...entry(material, true), favorite: false, local: false, marketListed: false };
       if (!app) throw new Error("App material unavailable");
       app.favorite = !app.favorite;
       if (!app.favorite && !app.local && !app.marketListed && !options.hasUsage(key)) delete doc.apps[key];
     });
   },
   async addLocal(input) {
     const pending = { ...input, ...channel(input), pendingId: crypto.randomUUID() };
     await transaction(doc => { if (doc.pending.some(p => p.url === pending.url && p.indexseedhashhex === pending.indexseedhashhex)) throw new Error("Pending entry already exists"); doc.pending.push(pending); });
     return pending;
   },
   reconcile,
   invalidateSource(keys) { return transaction(doc => invalidate(doc, keys)); },
   invalidateLocal(key) {
     assertAppPublicKeyHex(key);
     return transaction(doc => {
       const app = doc.apps[key]; if (!app) return;
       app.local = false;
       const keepHistory = !app.marketListed && (app.favorite || options.hasUsage(key));
       app.urls = app.urls.filter(u => !u.userAdded || u.marketListed || keepHistory).map(({ userAdded: _, ...u }) => u);
       app.files = app.files.filter(f => !f.userAdded || f.marketListed || keepHistory).map(({ userAdded: _, ...f }) => f);
       if (!app.marketListed && !app.favorite && !options.hasUsage(key)) delete doc.apps[key];
     });
   },
   removePending(id) { return transaction(doc => { doc.pending = doc.pending.filter(p => p.pendingId !== id); }); },
   select(key, input) {
     const target = channel(input);
     return transaction(doc => {
       const app = doc.apps[key];
       if (!app || !(target.url ? app.urls.some(u => u.url === target.url) : app.files.some(f => f.indexseedhashhex === target.indexseedhashhex))) throw new Error("Unknown App channel");
       app.selected = target;
     });
   },
   resolvePending(id, key, url, display) {
     assertAppPublicKeyHex(key); const full = fullURL(url);
     return transaction(doc => {
       if (doc.deletedKeys.includes(key)) return;
       const pending = doc.pending.find(p => p.pendingId === id); if (!pending || pending.url !== full) return;
       const material = doc.apps[key]; if(!material || !material.urls.some(u=>u.url===full))return;
       const previous = doc.apps[key];
       const urls = [...(previous?.urls ?? [])];
       const index = urls.findIndex(u => u.url === full);
       const resolved = { ...material.urls[0]!, userAdded: true as const, ...(index >= 0 && urls[index]?.marketListed ? { marketListed: true as const } : {}) };
       if (index < 0) urls.push(resolved); else urls[index] = resolved;
       doc.apps[key] = { ...(previous ?? material), urls, files: previous?.files ?? [], favorite: previous?.favorite ?? false, local: true, marketListed: previous?.marketListed ?? false };
       doc.deletedKeys = doc.deletedKeys.filter(value => value !== key);
       doc.pending = doc.pending.filter(p => p.pendingId !== id);
     });
   },
   restoreApp(key) {
     assertAppPublicKeyHex(key);
     return transaction(doc => { doc.deletedKeys = doc.deletedKeys.filter(value => value !== key); });
   },
   deleteApp(key) {
     assertAppPublicKeyHex(key);
     return transaction(doc => {
       delete doc.apps[key];
       if (!doc.deletedKeys.includes(key)) doc.deletedKeys.push(key);
     }, key);
   },
 };
 return service;
}
export function launchTarget(input: AppDirectoryEntry): AppLaunchTarget | null { const e = { ...input }; normalizeSelection(e); const url = e.selected?.url ?? (!e.selected ? e.urls[0]?.url : undefined); if (!url || !e.urls.some(u => u.url === url)) return null; const display = e.urls.find(u => u.url === url)!.display; return { url, name: display.name, description: display.description, expectedAppPublicKeyHex: e.appPublicKeyHex, marketListed: e.marketListed, local: e.local, favorite: e.favorite }; }
