const STORE = "appearance";

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("keymaster-ui-preferences", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => {
    database = undefined;
    throw error;
  });
}

export async function readAppearance(): Promise<{ mode: unknown; accent: unknown }> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE);
    const fields = transaction.objectStore(STORE);
    const mode = fields.get("mode");
    const accent = fields.get("accent");
    transaction.oncomplete = () => resolve({ mode: mode.result, accent: accent.result });
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function saveAppearance(field: "mode" | "accent", value: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(value, field);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
