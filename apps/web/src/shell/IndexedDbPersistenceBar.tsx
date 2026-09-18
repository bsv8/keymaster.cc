// apps/web/src/shell/IndexedDbPersistenceBar.tsx
// IndexedDB 永久存储授权条。
//
// Local 桶的物理真值是 IndexedDB。在没有 persistent-storage 授权时，浏览器
// 仍可能在存储压力下清理这些数据，因此只要 navigator.storage.persisted()
// 为 false，就把授权条持续显示在 header 上方；用户点击授权后若浏览器仍
// 拒绝（persist() 返回 false），授权条保持显示，不提供“关闭”入口。
//
// 无 StorageManager（旧浏览器 / 非安全上下文）时没有任何可授权项，不渲染。

import { useCallback, useEffect, useState } from "react";
import { Button } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";

type PersistenceStatus = "checking" | "unavailable" | "persisted" | "prompt";

interface PersistenceManager {
  persisted(): Promise<boolean>;
  persist(): Promise<boolean>;
}

function readPersistenceManager(): PersistenceManager | undefined {
  const storage = (globalThis as typeof globalThis & { navigator?: { storage?: Partial<PersistenceManager> } }).navigator?.storage;
  if (!storage || typeof storage.persisted !== "function" || typeof storage.persist !== "function") return undefined;
  return storage as PersistenceManager;
}

export function IndexedDbPersistenceBar() {
  const { t } = useI18n();
  const [status, setStatus] = useState<PersistenceStatus>("checking");
  const [requesting, setRequesting] = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const manager = readPersistenceManager();
    if (!manager) {
      setStatus("unavailable");
      return;
    }
    void manager.persisted().then(
      (persisted) => { if (!cancelled) setStatus(persisted ? "persisted" : "prompt"); },
      () => { if (!cancelled) setStatus("unavailable"); },
    );
    return () => { cancelled = true; };
  }, []);

  const authorize = useCallback(async () => {
    const manager = readPersistenceManager();
    if (!manager) {
      setStatus("unavailable");
      return;
    }
    setRequesting(true);
    try {
      const granted = await manager.persist();
      if (granted) {
        setStatus("persisted");
        setDenied(false);
      } else {
        setDenied(true);
      }
    } catch {
      setDenied(true);
    } finally {
      setRequesting(false);
    }
  }, []);

  if (status !== "prompt") return null;

  return (
    <aside
      className="indexeddb-persistence-bar"
      role="region"
      aria-label={t("shell.persistence.label", { defaultValue: "IndexedDB 永久存储授权" })}
      data-testid="indexeddb-persistence-bar"
    >
      <span className="indexeddb-persistence-bar__text">
        {denied
          ? t("shell.persistence.denied", {
              defaultValue: "未获授权，浏览器仍可能在存储空间紧张时清理本地数据。请允许本站持久化存储后重试。"
            })
          : t("shell.persistence.message", {
              defaultValue: "浏览器尚未授予 IndexedDB 永久存储权限，存储空间紧张时本地数据可能被清理。"
            })}
      </span>
      <Button size="sm" onClick={() => { void authorize(); }} loading={requesting}>
        {t("shell.persistence.authorize", { defaultValue: "授权永久存储" })}
      </Button>
    </aside>
  );
}
