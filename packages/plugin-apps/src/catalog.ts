import { useEffect, useSyncExternalStore } from "react";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { defineCapability } from "webloom-framework";
import { assertAppPublicKeyHex,validateAppDisplay,type AppDisplay, type BorrowedModuleFileStore } from "@keymaster/contracts";

export const APP_DIRECTORY_TTL_MS = 600000;
export interface UrlEntry { display:AppDisplay; url: string; origin: string; verifiedAt?: number }
export interface FilesEntry { display:AppDisplay; indexseedhashhex: string; verifiedAt?: number }
export interface AppMarketEntryInput { appPublicKeyHex: string; name?: string; description?: string; icon?: string; urls: UrlEntry[]; files: FilesEntry[] }
export interface AppDirectoryEntry extends AppMarketEntryInput { favorite: boolean; marketListed: boolean; local: boolean; selected?: { url?: string; indexseedhashhex?: string } }
export interface AppLocalInput { url?: string; indexseedhashhex?: string; name?: string; description?: string; icon?: string }
export interface AppPendingEntry extends AppLocalInput { pendingId: string; error?: string }
export interface AppLaunchTarget { url: string; name?: string; description?: string; expectedAppPublicKeyHex?: string; pendingId?: string; marketListed: boolean; local: boolean; favorite: boolean }
export interface AppDirectorySnapshot { entries: AppDirectoryEntry[]; pending: AppPendingEntry[]; loading: boolean; error: string | null; persistError: string | null; lastSuccessfulFetchAt: number | null }
interface DirectoryDocument { version: 2; market: AppMarketEntryInput[]; lastSuccessfulFetchAt: number | null; locals: Record<string, AppMarketEntryInput>; favorites: Record<string, boolean>; pending: AppPendingEntry[]; selection: Record<string, {url?:string;indexseedhashhex?:string}> }
export interface AppDirectoryService {
 subscribe(listener:()=>void):()=>void;
 getSnapshot():AppDirectorySnapshot;
 list():Promise<AppDirectorySnapshot>;
 toggleFavorite(key:string):Promise<void>;
 addLocal(input:AppLocalInput):Promise<AppPendingEntry>;
 removeLocal(key:string):Promise<void>;
 removePending(id:string):Promise<void>;
 select(key:string,selection:{url?:string;indexseedhashhex?:string}):Promise<void>;
 resolvePending(id:string,key:string,url:string,display:AppDisplay):Promise<void>;
}
export const APP_DIRECTORY_CAPABILITY=defineCapability<AppDirectoryService>({kind:"local",id:"app.directory",version:"1"});
export interface AppDirectoryServiceOptions { repository: BorrowedModuleFileStore; marketUrl?:string; fetchImpl?:typeof fetch; now?:()=>number }
export function canonicalAppOrigin(input:string):string|null {try{const u=new URL(input);if(!["http:","https:"].includes(u.protocol)||u.username||u.password||u.origin==="null")return null;return u.origin}catch{return null}}
function fullURL(input:unknown):string {if(typeof input!=="string"||!canonicalAppOrigin(input))throw new Error("Invalid App URL");return new URL(input).href}
function seed(input:unknown):string {if(typeof input!=="string"||!/^[0-9a-f]{64}$/.test(input))throw new Error("Invalid Files seed");return input}
function channel(input:{url?:string;indexseedhashhex?:string}) {if((input.url===undefined)===(input.indexseedhashhex===undefined))throw new Error("Exactly one URL or seed is required");return input.url!==undefined?{url:fullURL(input.url)}:{indexseedhashhex:seed(input.indexseedhashhex)}}
function entry(input:unknown):AppMarketEntryInput {
 if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Invalid market entry");const e=input as AppMarketEntryInput;
 const appPublicKeyHex=assertAppPublicKeyHex(e.appPublicKeyHex);secp256k1.Point.fromHex(appPublicKeyHex);if(!Array.isArray(e.urls)||!Array.isArray(e.files)||!e.urls.length&&!e.files.length)throw new Error("Invalid App channels");
 const urls=e.urls.map(u=>{if(!u||typeof u!=="object"||canonicalAppOrigin(u.url)!==u.origin)throw new Error("Invalid URL entry");return {url:fullURL(u.url),origin:u.origin,display:validateAppDisplay(u.display)}});
 const files=e.files.map(f=>({indexseedhashhex:seed(f?.indexseedhashhex),display:validateAppDisplay(f?.display)}));
 if(new Set(urls.map(u=>u.url)).size!==urls.length||new Set(files.map(f=>f.indexseedhashhex)).size!==files.length)throw new Error("Duplicate App channel");
 const display:Pick<AppMarketEntryInput,"name"|"description"|"icon">={};for(const k of ["name","description","icon"] as const){if(e[k]!==undefined){if(typeof e[k]!=="string")throw new Error("Invalid App display field");display[k]=e[k]}}
 return {appPublicKeyHex,...display,urls,files};
}
function market(input:unknown):AppMarketEntryInput[]{if(!Array.isArray(input))throw new Error("Invalid market snapshot");const result=input.map(entry);if(new Set(result.map(e=>e.appPublicKeyHex)).size!==result.length)throw new Error("Duplicate App public key");return result}
function merge(local:AppMarketEntryInput,remote:AppMarketEntryInput):AppMarketEntryInput {return {...remote,...local,urls:[...local.urls.map(u=>remote.urls.find(v=>v.url===u.url)??u),...remote.urls.filter(u=>!local.urls.some(v=>v.url===u.url))],files:[...local.files,...remote.files.filter(f=>!local.files.some(v=>v.indexseedhashhex===f.indexseedhashhex))]}}

/** 完整目录文档经受限文件句柄条件写入 directory.json；提交成功才更新内存，不读取旧路径。 */
export function createAppDirectoryService(options:AppDirectoryServiceOptions):AppDirectoryService {
 const repo=options.repository;const now=options.now??Date.now;const fetchImpl=options.fetchImpl??globalThis.fetch;
 let state:DirectoryDocument={version:2,market:[],lastSuccessfulFetchAt:null,locals:{},favorites:{},pending:[],selection:{}};let revision:string|undefined;let blocked:Error|undefined;let loading=false;let error:string|null=null;let persistError:string|null=null;
 const listeners=new Set<()=>void>();let snapshot:AppDirectorySnapshot={entries:[],pending:[],loading:false,error:null,persistError:null,lastSuccessfulFetchAt:null};let inflight:Promise<AppDirectorySnapshot>|undefined;let queue:Promise<void>=Promise.resolve();
 const publish=()=>{const seen=new Set<string>();const entries:AppDirectoryEntry[]=[];for(const e of [...state.market,...Object.values(state.locals)]){const key=e.appPublicKeyHex;if(seen.has(key))continue;seen.add(key);const remote=state.market.find(v=>v.appPublicKeyHex===key);const local=state.locals[key];entries.push({...local&&remote?merge(local,remote):local??e,favorite:state.favorites[key]===true,marketListed:!!remote,local:!!local,...state.selection[key]?{selected:state.selection[key]}:{}})}for(const e of entries){const d=(e.selected?.url?e.urls.find(u=>u.url===e.selected?.url):e.selected?.indexseedhashhex?e.files.find(f=>f.indexseedhashhex===e.selected?.indexseedhashhex):e.urls[0]??e.files[0])?.display;if(d)Object.assign(e,d)}entries.sort((a,b)=>Number(b.favorite)-Number(a.favorite));snapshot={entries,pending:state.pending,loading,error,persistError,lastSuccessfulFetchAt:state.lastSuccessfulFetchAt};for(const listener of listeners)listener()};
 let ready:Promise<void>|undefined;
 const ensureReady=()=>ready??=(Promise.resolve().then(()=>{return repo.get("directory.json")}).then(record=>{if(!record)return;const doc=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(record.bytes)) as DirectoryDocument;if(!doc||doc.version!==2||!doc.locals||!doc.favorites||!Array.isArray(doc.pending)||!doc.selection)throw new Error("Incompatible directory format");if(doc.lastSuccessfulFetchAt!==null&&(typeof doc.lastSuccessfulFetchAt!=="number"||!Number.isFinite(doc.lastSuccessfulFetchAt)||doc.lastSuccessfulFetchAt<0))throw new Error("Invalid directory timestamp");market(doc.market);for(const [key,e]of Object.entries(doc.locals)){if(entry(e).appPublicKeyHex!==key)throw new Error("Invalid local App identity")};for(const key of Object.keys(doc.favorites)){assertAppPublicKeyHex(key);if(typeof doc.favorites[key]!=="boolean")throw new Error("Invalid favorite state")};for(const [key,selection]of Object.entries(doc.selection)){assertAppPublicKeyHex(key);channel(selection)};if(new Set(doc.pending.map(p=>p.pendingId)).size!==doc.pending.length)throw new Error("Duplicate pending identity");for(const p of doc.pending){if(!p.pendingId||"appPublicKeyHex" in p)throw new Error("Invalid pending identity");channel(p)};state=doc;revision=record.revision}).catch(cause=>{blocked=cause instanceof Error?cause:new Error(String(cause));persistError=blocked.message}).finally(publish));
 const transaction=(change:(next:DirectoryDocument)=>void):Promise<void>=>{const work=queue.then(async()=>{await ensureReady();if(blocked)throw blocked;const next=structuredClone(state);change(next);const stored=await repo.put("directory.json",new TextEncoder().encode(JSON.stringify(next)),{...revision===undefined?{ifNoneMatch:true as const}:{ifRevision:revision},contentType:"application/json"});revision=stored.revision;state=next;persistError=null;publish()});queue=work.catch(cause=>{persistError=cause instanceof Error?cause.message:String(cause);publish()});return work};
 const service:AppDirectoryService={
 subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener)}},getSnapshot:()=>snapshot,
 list(){if(inflight)return inflight;inflight=(async()=>{await ensureReady();if(blocked)return snapshot;if(state.lastSuccessfulFetchAt!==null&&now()-state.lastSuccessfulFetchAt<APP_DIRECTORY_TTL_MS)return snapshot;loading=true;publish();try{const env=(import.meta as unknown as {env?:Record<string,string>}).env;const response=await fetchImpl(new URL("v1/market", (options.marketUrl??env?.VITE_KEYMASTER_MARKET_URL??"https://market.bsv8.com").replace(/\/?$/, "/")).href,{headers:{accept:"application/json"}});if(!response.ok)throw new Error(`Market status ${response.status}`);const body=await response.json() as {entries?:unknown};const next=market(body.entries);const completed=now();await transaction(doc=>{doc.market=next;doc.lastSuccessfulFetchAt=completed});error=null}catch(cause){error=cause instanceof Error?cause.message:String(cause)}finally{loading=false;publish()}return snapshot})().finally(()=>{inflight=undefined});return inflight},
 toggleFavorite(key){assertAppPublicKeyHex(key);return transaction(doc=>{const e=snapshot.entries.find(e=>e.appPublicKeyHex===key);if(!e)throw new Error("Unknown App");if(doc.favorites[key])delete doc.favorites[key];else{doc.favorites[key]=true;doc.locals[key]=entry(e)}})},
 async addLocal(input){const target=channel(input);const pending:AppPendingEntry={...input,...target,pendingId:crypto.randomUUID()};await transaction(doc=>{if(doc.pending.some(p=>p.url===pending.url&&p.indexseedhashhex===pending.indexseedhashhex))throw new Error("Pending entry already exists");doc.pending.push(pending)});return pending},
 removeLocal(key){assertAppPublicKeyHex(key);return transaction(doc=>{if(doc.favorites[key])throw new Error("Unfavorite before removing");delete doc.locals[key];delete doc.selection[key]})},
 removePending(id){return transaction(doc=>{doc.pending=doc.pending.filter(p=>p.pendingId!==id)})},
 select(key,input){const target=channel(input);return transaction(doc=>{const e=snapshot.entries.find(e=>e.appPublicKeyHex===key);if(!e||!(target.url?e.urls.some(u=>u.url===target.url):e.files.some(f=>f.indexseedhashhex===target.indexseedhashhex)))throw new Error("Unknown App channel");doc.locals[key]=entry(e);doc.selection[key]=target})},
 resolvePending(id,key,url,display){assertAppPublicKeyHex(key);const full=fullURL(url);return transaction(doc=>{const p=doc.pending.find(p=>p.pendingId===id);if(!p||p.url!==full)return;const resolved:AppMarketEntryInput={appPublicKeyHex:key,urls:[{url:full,origin:new URL(full).origin,display:validateAppDisplay(display)}],files:[],...p.name?{name:p.name}:{},...p.description?{description:p.description}:{},...p.icon?{icon:p.icon}:{}};doc.locals[key]=doc.locals[key]?merge(doc.locals[key],resolved):resolved;doc.pending=doc.pending.filter(p=>p.pendingId!==id)})},
 };return service;
}
export function useAppDirectory(service:AppDirectoryService):AppDirectorySnapshot {const snapshot=useSyncExternalStore(service.subscribe,service.getSnapshot,service.getSnapshot);useEffect(()=>{void service.list()},[service]);return snapshot}
export function launchTarget(e:AppDirectoryEntry):AppLaunchTarget|null {const url=e.selected?.url??(!e.selected?e.urls[0]?.url:undefined);if(!url||!e.urls.some(u=>u.url===url))return null;const display=e.urls.find(u=>u.url===url)!.display;return {url,name:display.name,description:display.description,expectedAppPublicKeyHex:e.appPublicKeyHex,marketListed:e.marketListed,local:e.local,favorite:e.favorite}}
