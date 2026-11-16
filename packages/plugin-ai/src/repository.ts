import type { BorrowedModuleFileStore, VaultLocalSecretService, VaultSealedSecret } from "@keymaster/contracts";
import type { Conversation, Settings } from "./types.js";
import { recoverConversation, recoverSettings } from "./recovery.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompt.js";

export function defaultSettings(): Settings {
  return { version: 1, configured: false, enabled: false, providers: [], defaults: { providerId: "", model: "", reasoning: "" }, systemPrompt: DEFAULT_SYSTEM_PROMPT, disabledTools: [] };
}
/** 设置及会话各占一个加密 JSON 文件；文件名不包含内容、标题或密钥。 */
export function createAiRepository(store: BorrowedModuleFileStore, secrets: VaultLocalSecretService, assertActive: () => void) {
  const observed = new Map<string, string | null>();
  let writes = Promise.resolve();
  const pendingPlaintext = new Set<Uint8Array>();
  const conversationKey = (id: string) => {
    if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error("AI 会话标识无效");
    return `conversations/${id}`;
  };
  const pathFor = (key: string) => `${key}.json`;
  async function read<T>(key: string, recover: (value: unknown) => T): Promise<T | undefined> {
    assertActive();
    const record = await store.get(pathFor(key));
    assertActive();
    if (!record) { observed.set(key, null); return undefined; }
    const sealed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.bytes)) as VaultSealedSecret;
    const bytes = await secrets.open(`keymaster.ai/${key}`, sealed);
    try {
      assertActive();
      const value = recover(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      observed.set(key, record.revision);
      return value;
    } finally { bytes.fill(0); }
  }
  /** 每文件 CAS：无关会话互不争用；同记录的旧快照必须明确报冲突。 */
  async function commit(key: string, sealed: VaultSealedSecret | null) {
    assertActive();
    const path = pathFor(key);
    const revision = observed.get(key) ?? null;
    try {
      if (sealed) {
        const stored = await store.put(path, new TextEncoder().encode(JSON.stringify(sealed)), {
          ...(revision === null ? { ifNoneMatch: true as const } : { ifRevision: revision }),
          contentType: "application/json",
        });
        assertActive(); observed.set(key, stored.revision);
      } else {
        // 缺失文件也带“不存在”条件，避免未观察过的并发创建被删除。
        await store.batch({
          operations: [{ type: "delete", path }],
          conditions: [{ path, ...(revision === null ? { ifNoneMatch: true as const } : { ifRevision: revision }) }],
        });
        assertActive(); observed.set(key, null);
      }
    } catch (error) {
      if ((error as { code?: string }).code === "storage_conflict") {
        throw new Error("AI 会话或设置已被其它钱包窗口修改，请重新载入后继续；没有覆盖其它窗口的数据", { cause: error });
      }
      throw error;
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
    saveConversation: (conversation: Conversation) => write(conversationKey(conversation.id), conversation),
    async conversations() {
      const result: Conversation[] = [];
      let cursor: string | undefined;
      do {
        assertActive();
        const page = await store.list({ prefix: "conversations/", cursor, limit: 100 });
        for (const entry of page.files) {
          if (!/^conversations\/[^/]+\.json$/u.test(entry.path)) continue;
          const id = entry.path.slice("conversations/".length, -".json".length);
          const conversation = await read<Conversation>(conversationKey(id), value => recoverConversation(value, id));
          if (conversation) result.push(conversation);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return result.sort((a, b) => b.createdAt - a.createdAt);
    },
    deleteConversation: (id: string) => enqueue(() => commit(conversationKey(id), null)),
    dispose() { for (const bytes of pendingPlaintext) bytes.fill(0); pendingPlaintext.clear(); observed.clear(); },
  };
}
export type AiRepository = ReturnType<typeof createAiRepository>;
