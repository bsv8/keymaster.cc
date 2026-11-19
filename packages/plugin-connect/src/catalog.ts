import { validateAppVersion, compareAppVersions } from "./publicationShape.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  assertAppPublicKeyHex, validateAppDisplay, traceDev,
  type AppDisplay, type AppSourceEntry, type AppSourceChange, type AppSourceChangeResult,
} from "@keymaster/contracts";
export type { AppDirectoryEntry } from "./appDirectoryTypes.js";
import type { AppAcceptedSource, AppDirectoryEntry, AppDirectoryDocument, AppDirectoryRepository } from "./appDirectoryTypes.js";
export interface AppLaunchTarget { url: string; name?: string; description?: string; expectedAppPublicKeyHex?: string; favorite: boolean }
export interface AppDirectorySnapshot { entries: AppDirectoryEntry[]; favoriteKeys: string[]; deletedKeys: string[]; loading: boolean; error: string | null; persistError: string | null }
export interface AppDirectoryService {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AppDirectorySnapshot;
  /** 只读本地已归属数据；不发请求、不触发刷新。 */
  list(): Promise<AppDirectorySnapshot>;
  /** 受限批次写入的实现：提交已验证发布或标记来源失效，逐条返回结果。 */
  applyBatch(changes: readonly AppSourceChange[]): Promise<readonly AppSourceChangeResult[]>;
  toggleFavorite(key: string): Promise<void>;
  select(key: string, selection: { url?: string; indexseedhashhex?: string }): Promise<void>;
  restoreApp(key: string): Promise<void>;
  deleteApp(key: string): Promise<void>;
}
export type WindowAppDirectory = Pick<AppDirectoryService,
  "subscribe" | "getSnapshot" | "list" | "toggleFavorite" | "select" | "deleteApp">;
export interface AppDirectoryServiceOptions {
  repository: AppDirectoryRepository;
  hasUsage(key: string): boolean;
  forgetApp(key: string, commit: () => Promise<void>): Promise<void>;
  assertActive(): void;
  now?: () => number;
}
export function canonicalAppOrigin(input: string): string | null { try { const u = new URL(input); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.origin === "null") return null; return u.origin } catch { return null } }
function fullURL(input: unknown): string { if (typeof input !== "string" || !canonicalAppOrigin(input)) throw new Error("Invalid App URL"); return new URL(input).href }
function seed(input: unknown): string { if (typeof input !== "string" || !/^[0-9a-f]{64}$/.test(input)) throw new Error("Invalid Files seed"); return input }
function channel(input: { url?: string; indexseedhashhex?: string }) { if ((input.url === undefined) === (input.indexseedhashhex === undefined)) throw new Error("Exactly one URL or seed is required"); return input.url !== undefined ? { url: fullURL(input.url) } : { indexseedhashhex: seed(input.indexseedhashhex) } }
function entry(input: unknown): AppSourceEntry {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid market entry"); const e = input as AppSourceEntry;
  const appVersion = validateAppVersion(e.appVersion); const appPublicKeyHex = assertAppPublicKeyHex(e.appPublicKeyHex); secp256k1.Point.fromHex(appPublicKeyHex); if (!Array.isArray(e.urls) || !Array.isArray(e.files) || !e.urls.length && !e.files.length) throw new Error("Invalid App channels");
  const urls = e.urls.map(u => { if (!u || typeof u !== "object" || canonicalAppOrigin(u.url) !== u.origin) throw new Error("Invalid URL entry"); return { url: fullURL(u.url), origin: u.origin, display: validateAppDisplay(u.display) } });
  const files = e.files.map(f => ({ indexseedhashhex: seed(f?.indexseedhashhex), display: validateAppDisplay(f?.display) }));
  if (new Set(urls.map(u => u.url)).size !== urls.length || new Set(files.map(f => f.indexseedhashhex)).size !== files.length) throw new Error("Duplicate App channel");
  const display: Pick<AppSourceEntry, "name" | "description" | "icon"> = {}; for (const k of ["name", "description", "icon"] as const) { if (e[k] !== undefined) { if (typeof e[k] !== "string") throw new Error("Invalid App display field"); display[k] = e[k] } }
  if (urls.length > 1 || files.length > 1) throw new Error("Multiple current publication channels"); return { appVersion, appPublicKeyHex, ...display, urls, files };
}
/** 整份发布内容比较键（不含 verifiedAt 等元数据）。 */
function contentKey(value: AppSourceEntry): string {
  const norm = {
    appVersion: value.appVersion, appPublicKeyHex: value.appPublicKeyHex.toLowerCase(),
    ...(value.name !== undefined ? { name: value.name } : {}),
    ...(value.description !== undefined ? { description: value.description } : {}),
    ...(value.icon !== undefined ? { icon: value.icon } : {}),
    urls: [...value.urls].sort((a, b) => a.url < b.url ? -1 : 1).map(u => ({ url: u.url, origin: u.origin, display: u.display })),
    files: [...value.files].sort((a, b) => a.indexseedhashhex < b.indexseedhashhex ? -1 : 1).map(f => ({ indexseedhashhex: f.indexseedhashhex, display: f.display })),
  };
  return JSON.stringify(norm);
}
/** 来源 ID 由 Market 层分配并保证唯一；Connect 把它当作关联键，只拒绝空值。 */
function validSourceId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("empty source");
  return value;
}
/** Keep the user's choice only while that exact channel still exists. */
function normalizeSelection(app: AppDirectoryEntry): void {
  const selected = app.selected;
  if (selected && !(selected.url ? app.urls.some(u => u.url === selected.url) : app.files.some(f => f.indexseedhashhex === selected.indexseedhashhex))) delete app.selected;
}
/** 从剩余有效来源取回一份完整发布：最高版本，同版本取最近成功提交（提交序号）。不拼接字段。 */
function pickCurrent(sources: Record<string, AppAcceptedSource> | undefined): { publication: AppSourceEntry; sourceId: string } | undefined {
  const list = Object.values(sources ?? {});
  if (!list.length) return undefined;
  list.sort((a, b) => {
    const cmp = compareAppVersions(a.publication.appVersion, b.publication.appVersion);
    if (cmp !== 0) return cmp;
    return a.sequence - b.sequence;
  });
  const winner = list[list.length - 1]!;
  return { publication: winner.publication, sourceId: winner.sourceId };
}

/** Connect owns one application directory. No per-source documents or source management service. */
export function createAppDirectoryService(options: AppDirectoryServiceOptions): AppDirectoryService {
  const repo = options.repository, now = options.now ?? (() => Date.now());
  let state: AppDirectoryDocument = { version: 1, apps: {}, sources: {}, favorites: [], deletedKeys: [], sequence: 0 };
  let revision: number | undefined, blocked: Error | undefined;
  const listeners = new Set<() => void>();
  let snapshot: AppDirectorySnapshot = { entries: [], favoriteKeys: [], deletedKeys: [], loading: false, error: null, persistError: null };
  const publish = () => {
    const entries = Object.values(state.apps).map(value => {
      const e = structuredClone(value);
      normalizeSelection(e);
      const display = (e.selected?.url ? e.urls.find(u => u.url === e.selected?.url) : e.selected?.indexseedhashhex ? e.files.find(f => f.indexseedhashhex === e.selected?.indexseedhashhex) : e.urls[0] ?? e.files[0])?.display;
      if (display) Object.assign(e, display);
      e.favorite = state.favorites.includes(e.appPublicKeyHex);
      return e;
    }).sort((a, b) => Number(b.favorite) - Number(a.favorite));
    snapshot = { entries, favoriteKeys: [...state.favorites].sort(), deletedKeys: [...state.deletedKeys].sort(), loading: false, error: null, persistError: snapshot.persistError };
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
      if (!doc || (doc as { version?: number }).version !== 1 || !doc.apps || !doc.sources || !Array.isArray((doc as AppDirectoryDocument).favorites) || !Array.isArray(doc.deletedKeys)) throw new Error("Invalid Connect application directory");
      for (const [key, value] of Object.entries(doc.apps)) {
        if (entry(value).appPublicKeyHex !== key) throw new Error("Invalid App state");
        if (typeof (value as AppDirectoryEntry).favorite !== "boolean") throw new Error("Invalid App state");
        if ((value as AppDirectoryEntry).selected) channel((value as AppDirectoryEntry).selected!);
      }
      for (const [key, perSource] of Object.entries(doc.sources)) {
        assertAppPublicKeyHex(key);
        if (!perSource || typeof perSource !== "object") throw new Error("Invalid App sources");
        for (const [sourceId, accepted] of Object.entries(perSource)) {
          validSourceId(sourceId);
          if (!accepted || typeof accepted !== "object" || accepted.sourceId !== sourceId) throw new Error("Invalid accepted source");
          if (!Number.isSafeInteger((accepted as AppAcceptedSource).sequence) || (accepted as AppAcceptedSource).sequence <= 0) throw new Error("Invalid accepted source");
          if (entry((accepted as AppAcceptedSource).publication).appPublicKeyHex !== key) throw new Error("Invalid accepted source");
        }
      }
      for (const key of doc.deletedKeys) assertAppPublicKeyHex(key);
      for (const key of doc.favorites) assertAppPublicKeyHex(key);
      state = structuredClone(doc); revision = record.revision;
    } catch (cause) { blocked = cause instanceof Error ? cause : new Error(String(cause)); snapshot = { ...snapshot, persistError: blocked.message }; }
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
        options.assertActive(); revision = stored; state = next; snapshot = { ...snapshot, persistError: null }; publish();
      };
      if (forgetKey) await options.forgetApp(forgetKey, commit); else await commit();
    });
    queue = work.catch(cause => { traceDev("connect.apps", "write.failed", () => ({ error: cause })); snapshot = { ...snapshot, persistError: cause instanceof Error ? cause.message : String(cause) }; listeners.forEach(listener => listener()); });
    return work;
  };
  const canPrune = (key: string, app: AppDirectoryEntry) => Object.keys(state.sources[key] ?? {}).length === 0 && !state.favorites.includes(key) && !options.hasUsage(key);
  const reconcile = async () => {
    await ensureReady(); options.assertActive(); if (blocked) throw blocked;
    if (!Object.entries(state.apps).some(([key, app]) => canPrune(key, app))) return;
    await transaction(doc => {
      for (const [key, app] of Object.entries(doc.apps)) {
        if (Object.keys(doc.sources[key] ?? {}).length === 0 && !doc.favorites.includes(key) && !options.hasUsage(key)) delete doc.apps[key];
      }
    });
  };
  const service: AppDirectoryService = {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    async list() {
      await ensureReady();
      if (blocked) return snapshot;
      try { await reconcile(); } catch (cause) { snapshot = { ...snapshot, persistError: cause instanceof Error ? cause.message : String(cause) }; publish(); }
      return snapshot;
    },
    async applyBatch(changes) {
      await ensureReady(); options.assertActive(); if (blocked) throw blocked;
      const results: AppSourceChangeResult[] = [];
      await transaction(doc => {
        for (const change of changes) {
          try {
            if (change.kind === "submit") {
              const sourceId = validSourceId(change.sourceId);
              const key = assertAppPublicKeyHex(change.appPublicKeyHex);
              const incoming = entry(change.publication);
              if (incoming.appPublicKeyHex !== key) throw new Error("Publication key mismatch");
              validateAppVersion(change.appVersion);
              if (incoming.appVersion !== change.appVersion) throw new Error("Version mismatch");
              if (doc.deletedKeys.includes(key)) { results.push({ sourceId, appPublicKeyHex: key, status: "failed", reason: "deleted by user" }); continue; }
              const perSource = doc.sources[key] ?? {};
              const stored = perSource[sourceId];
              if (stored && contentKey(stored.publication) === contentKey(incoming)) {
                results.push({ sourceId, appPublicKeyHex: key, status: "unchanged" });
                continue;
              }
              const current = doc.apps[key];
              if (current && compareAppVersions(incoming.appVersion, current.appVersion) < 0) {
                results.push({ sourceId, appPublicKeyHex: key, status: "lower-version-rejected", reason: `Lower appVersion rejected: ${incoming.appVersion} < ${current.appVersion}` });
                continue;
              }
              // 提交序号在成功提交时推进：同版本不同内容按实际提交顺序判定，
              // 相同来源重放同一份已保存内容不改变序号。
              doc.sequence = Math.max(doc.sequence ?? 0, 0) + 1;
              const nextSources = { ...perSource, [sourceId]: { sourceId, publication: structuredClone(incoming), sequence: doc.sequence } };
              doc.sources[key] = nextSources;
              const picked = pickCurrent(nextSources)!;
              const prev = doc.apps[key];
              const next: AppDirectoryEntry = { ...structuredClone(picked.publication), favorite: doc.favorites.includes(key), selected: prev?.selected, ...(picked.sourceId ? { sourceId: picked.sourceId } : {}) };
              normalizeSelection(next);
              const changed = !prev || contentKey({ ...prev, favorite: false, selected: undefined, sourceId: undefined } as AppSourceEntry) !== contentKey(picked.publication);
              doc.apps[key] = next;
              results.push({ sourceId, appPublicKeyHex: key, status: changed ? "applied" : "unchanged" });
            } else if (change.kind === "invalidate") {
              const sourceId = validSourceId(change.sourceId);
              const key = assertAppPublicKeyHex(change.appPublicKeyHex);
              const perSource = doc.sources[key];
              if (!perSource || !perSource[sourceId]) { results.push({ sourceId, appPublicKeyHex: key, status: "unchanged" }); continue; }
              const nextSources = { ...perSource };
              delete nextSources[sourceId];
              if (Object.keys(nextSources).length === 0) delete doc.sources[key]; else doc.sources[key] = nextSources;
              const picked = pickCurrent(nextSources);
              if (picked) {
                const prev = doc.apps[key];
                doc.apps[key] = { ...structuredClone(picked.publication), favorite: doc.favorites.includes(key), selected: prev?.selected, sourceId: picked.sourceId };
                normalizeSelection(doc.apps[key]!);
              } else {
                // 无有效来源：有收藏/历史/数据时保住条目（可能展示已失效资料），否则自动移除。
                const app = doc.apps[key];
                if (app && (doc.favorites.includes(key) || options.hasUsage(key))) {
                  delete (app as { sourceId?: string }).sourceId;
                } else if (app) {
                  delete doc.apps[key];
                }
              }
              traceDev("connect.apps", "source.invalidated", () => ({ applicationKey: key, sourceId, retained: !!doc.apps[key] }));
              results.push({ sourceId, appPublicKeyHex: key, status: "applied" });
            } else {
              results.push({ sourceId: String((change as { sourceId?: unknown }).sourceId ?? ""), appPublicKeyHex: String((change as { appPublicKeyHex?: unknown }).appPublicKeyHex ?? ""), status: "failed", reason: "Unknown change kind" });
            }
          } catch (error) {
            const sourceId = String((change as { sourceId?: unknown }).sourceId ?? "");
            const appPublicKeyHex = String((change as { appPublicKeyHex?: unknown }).appPublicKeyHex ?? "");
            results.push({ sourceId, appPublicKeyHex, status: "failed", reason: error instanceof Error ? error.message : String(error) });
          }
        }
      });
      return results;
    },
    toggleFavorite(key) {
      assertAppPublicKeyHex(key);
      return transaction(doc => {
        if (doc.favorites.includes(key)) {
          doc.favorites = doc.favorites.filter(value => value !== key);
          const app = doc.apps[key];
          if (app) app.favorite = false;
          if (app && Object.keys(doc.sources[key] ?? {}).length === 0 && !options.hasUsage(key)) delete doc.apps[key];
        } else {
          doc.favorites = [...doc.favorites, key];
          const app = doc.apps[key];
          if (app) app.favorite = true;
        }
      });
    },
    select(key, input) {
      const target = channel(input);
      return transaction(doc => {
        const app = doc.apps[key];
        if (!app || !(target.url ? app.urls.some(u => u.url === target.url) : app.files.some(f => f.indexseedhashhex === target.indexseedhashhex))) throw new Error("Unknown App channel");
        app.selected = target;
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
        delete doc.sources[key];
        doc.favorites = doc.favorites.filter(value => value !== key);
        if (!doc.deletedKeys.includes(key)) doc.deletedKeys.push(key);
      }, key);
    },
  };
  return service;
}
export function launchTarget(input: AppDirectoryEntry): AppLaunchTarget | null { const e = { ...input }; normalizeSelection(e); const url = e.selected?.url ?? (!e.selected ? e.urls[0]?.url : undefined); if (!url || !e.urls.some(u => u.url === url)) return null; const display = e.urls.find(u => u.url === url)!.display; return { url, name: display.name, description: display.description, expectedAppPublicKeyHex: e.appPublicKeyHex, favorite: e.favorite }; }
