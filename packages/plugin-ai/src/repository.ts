import type { BorrowedKeyValueStore, VaultLocalSecretService, VaultSealedSecret } from "@keymaster/contracts";
import type { Conversation, Settings } from "./types.js";
import { recoverConversation, recoverSettings } from "./recovery.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt.js";

export function defaultSettings(): Settings {
  return { version: 1, configured: false, providers: [], defaults: { providerId: "", model: "", reasoning: "" }, systemPrompt: DEFAULT_SYSTEM_PROMPT, disabledTools: [] };
}
/** Both record content and settings are sealed; keys contain only random identifiers. */
export function createAiRepository(store: BorrowedKeyValueStore, secrets: VaultLocalSecretService, assertActive: () => void) {
  const partition = "ai";
  const observed = new Map<string, string | null>();
  let writes = Promise.resolve();
  const pendingPlaintext = new Set<Uint8Array>();
  const fingerprint = (sealed: VaultSealedSecret | undefined) => sealed ? JSON.stringify([sealed.version, sealed.keySource, sealed.saltHex, sealed.nonceHex, sealed.ciphertextHex]) : null;
  async function read<T>(key: string, recover: (value: unknown) => T): Promise<T | undefined> {
    assertActive();
    const record = await store.get<VaultSealedSecret>(key, { partition });
    assertActive();
    observed.set(key, fingerprint(record?.value));
    if (!record) return undefined;
    const bytes = await secrets.open(`keymaster.ai/${key}`, record.value);
    try {
      assertActive();
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return recover(value);
    } finally { bytes.fill(0); }
  }
  /** CAS prevents two wallet windows silently overwriting a stale conversation/settings snapshot. */
  async function commit(key: string, sealed: VaultSealedSecret | null) {
    const expected = observed.get(key) ?? null;
    for (let attempt = 0; attempt < 8; attempt++) {
      assertActive();
      // Capture partition revision before reading this record. Unrelated-key
      // writes can be retried, but a changed record must never be overwritten.
      const { revision } = await store.list({ partition, limit: 1 });
      const current = await store.get<VaultSealedSecret>(key, { partition });
      assertActive();
      if (fingerprint(current?.value) !== expected) throw new Error("AI 会话或设置已被其它钱包窗口修改，请重新载入后继续；没有覆盖其它窗口的数据");
      try {
        await store.commit({ partition, ifRevision: revision, operations: sealed ? [{ type: "put", key, value: sealed }] : [{ type: "delete", key }] });
        assertActive(); observed.set(key, fingerprint(sealed ?? undefined));
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "storage_conflict" || attempt === 7) throw error;
      }
    }
  }
  function enqueue(operation: () => Promise<void>) {
    const result = writes.then(operation);
    writes = result.catch(() => undefined);
    return result;
  }
  function write(key: string, value: Settings | Conversation) {
    // Snapshot before enqueue: later caller mutations cannot change this write.
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    pendingPlaintext.add(bytes);
    return enqueue(async () => {
      try {
        assertActive();
        const sealed = await secrets.seal(`keymaster.ai/${key}`, bytes);
        assertActive(); await commit(key, sealed);
      } finally { bytes.fill(0); pendingPlaintext.delete(bytes); }
    });
  }
  return {
    settings: async () => await read<Settings>("settings", recoverSettings) ?? defaultSettings(),
    saveSettings: (settings: Settings) => write("settings", settings),
    saveConversation: (conversation: Conversation) => write(`conversations/${conversation.id}`, conversation),
    async conversations() {
      const result: Conversation[] = [];
      let cursor: string | undefined;
      do {
        assertActive();
        const page = await store.list({ partition, prefix: "conversations/", cursor, limit: 100 });
        for (const entry of page.entries) {
          const conversation = await read<Conversation>(entry.key, value => recoverConversation(value, entry.key.slice("conversations/".length)));
          if (conversation) result.push(conversation);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return result.sort((a, b) => b.createdAt - a.createdAt);
    },
    deleteConversation: (id: string) => enqueue(() => commit(`conversations/${id}`, null)),
    dispose() { for (const bytes of pendingPlaintext) bytes.fill(0); pendingPlaintext.clear(); observed.clear(); },
  };
}
export type AiRepository = ReturnType<typeof createAiRepository>;
