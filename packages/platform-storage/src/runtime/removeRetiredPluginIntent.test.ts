import { describe, expect, it } from "vitest";
import { createIndexedDbWalletStore } from "../local/indexedDbWalletStore.js";
import { removeRetiredPluginIntent } from "./removeRetiredPluginIntent.js";

describe("0.6 retired intent cleanup", () => {
  it("only removes the dedicated intent object and preserves existing business/wallet/recovery bytes", async () => {
    const store = createIndexedDbWalletStore({ databaseName: `retired-intent-${crypto.randomUUID()}` });
    const preserved = ["key.json", ".keymaster/meta.json", ".keymaster/system/coordinator/settings/current",
      ".keymaster/system/coordinator/plugin-intent/other", ".keymaster/system/protocol/sessions/value",
      "contacts/address-book/existing.json", "apps/existing-app/document", "msfile/bitfs-journal/recovery.json"];
    const bytes = new TextEncoder().encode('{"existing":"preserve exactly"}');
    try {
      for (const path of preserved) await store.put(path, bytes);
      await store.put(".keymaster/system/coordinator/plugin-intent/current", new TextEncoder().encode('{"desiredEnabled":false}'));
      await removeRetiredPluginIntent(store);
      await removeRetiredPluginIntent(store);
      expect(await store.get(".keymaster/system/coordinator/plugin-intent/current")).toBeUndefined();
      for (const path of preserved) expect((await store.get(path))?.bytes).toEqual(bytes);
    } finally { store.close(); }
  });
});
