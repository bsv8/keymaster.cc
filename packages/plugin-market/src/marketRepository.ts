import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import type { MarketRepository, MarketStateDocument } from "./marketTypes.js";
function empty(): MarketStateDocument {
  return {
    version: 1,
    markets: [{ id: "market-default", name: "内置市场", directoryUrl: "https://market.bsv8.com/v1/apps", builtIn: true }],
    applied: {}, pending: {}, sync: {}, journal: null,
  };
}
function isDocument(value: unknown): value is MarketStateDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as MarketStateDocument;
  return doc.version === 1
    && Array.isArray(doc.markets) && doc.markets.some(m => m?.builtIn) && doc.markets.filter(m => m?.builtIn).length === 1
    && !!doc.applied && typeof doc.applied === "object"
    && !!doc.pending && typeof doc.pending === "object"
    && !!doc.sync && typeof doc.sync === "object"
    && (doc.journal === null || !!doc.journal && typeof doc.journal === "object");
}
function conflict(): Error { return Object.assign(new Error("Market document revision conflict"), { code: "storage_conflict" }); }
/** Market 自有存储：market-state.json 整文件 CAS，与 Connect 目录隔离。 */
export function openMarketRepository(store: BorrowedModuleFileStore): MarketRepository {
  const path = "market-state.json";
  let writeTail: Promise<void> = Promise.resolve();
  async function read() {
    const file = await store.get(path);
    if (!file) return null;
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
    if (!data || data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1 || !isDocument(data.data)) {
      throw new Error("Invalid Market document");
    }
    return { document: structuredClone(data.data) as MarketStateDocument, revision: data.revision as number, fileRevision: file.revision as string | undefined };
  }
  function update(change: (doc: MarketStateDocument) => void, options: { ifRevision?: number } = {}): Promise<number> {
    const operation = writeTail.then(async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await read();
        const base = current ? current.document : empty();
        if (options.ifRevision !== undefined && (!current || current.revision !== options.ifRevision)) throw conflict();
        change(base);
        const revision = (current?.revision ?? 0) + 1;
        const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, revision, data: base }));
        try {
          await store.put(path, bytes, { contentType: "application/json", ...(current?.fileRevision === undefined ? { ifNoneMatch: true as const } : { ifRevision: current.fileRevision }) });
          return revision;
        } catch (error) {
          if (options.ifRevision !== undefined || attempt === 7 || (error as { code?: string }).code !== "storage_conflict") throw error;
        }
      }
      throw conflict();
    });
    writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  return {
    async read() {
      const record = await read();
      if (!record) return null;
      return { document: record.document, revision: record.revision };
    },
    async write(doc, options) {
      return update(next => { Object.keys(next).forEach(key => delete (next as unknown as Record<string, unknown>)[key]); Object.assign(next, structuredClone(doc)); }, options);
    },
  };
}
