// 全局 notice registry。
//
// 设计缘由：
//   - shell 只消费结构化 notice 列表，不理解业务语义；
//   - notice 真值保留在 runtime 内存中，插件卸载时按 sourcePluginId 清理；
//   - 同 id upsert 视为覆盖，不做叠加。

import type { NoticeRecord, NoticeRegistry as INoticeRegistry } from "@keymaster/contracts";

export function createNoticeRegistry(): INoticeRegistry {
  const records = new Map<string, NoticeRecord>();
  const subscribers = new Set<(records: NoticeRecord[]) => void>();

  function sorted(): NoticeRecord[] {
    return [...records.values()].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return b.createdAtMs - a.createdAtMs;
    });
  }

  function emit(): void {
    const snap = sorted();
    for (const handler of subscribers) {
      try {
        handler(snap);
      } catch {
        // ignore
      }
    }
  }

  return {
    upsert(record) {
      records.set(record.id, {
        ...record,
        actions: record.actions.slice()
      });
      emit();
    },
    dismiss(id) {
      if (!records.delete(id)) return;
      emit();
    },
    list() {
      return sorted();
    },
    subscribe(handler) {
      subscribers.add(handler);
      handler(sorted());
      return () => {
        subscribers.delete(handler);
      };
    },
    removeBySourcePluginId(sourcePluginId) {
      let changed = false;
      for (const [id, record] of records) {
        if (record.sourcePluginId === sourcePluginId) {
          records.delete(id);
          changed = true;
        }
      }
      if (changed) emit();
    }
  };
}

