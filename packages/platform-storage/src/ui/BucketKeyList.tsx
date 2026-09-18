// packages/platform-storage/src/ui/BucketKeyList.tsx
// 桶管理页行内的 Key 列表。
//
// 可见性（用户可见即列出）：
//   - 当前桶（已解锁）：VaultService.listKeys()；
//   - 非当前 Local 桶：数据就在本机 localStorage，浏览器权限本身是开放的，
//     用只读探测直接列出，不需要桶密码；
//   - 非当前 S3 桶：读取需要桶密码，本列表不承担该入口（由顶栏切换器负责）。
//
// 删除：
//   - 当前桶：keyspace.deleteKey（先取消任务、关闭 owner 句柄、再删 KeyHold
//     与 owner 数据，并修复 active 选择）；s3 桶沿用桶密码确认，local 桶不
//     需要密码（权限本来就在本机 localStorage）。
//   - 非当前 Local 桶：storage.deleteLocalBucketKey（KeyHold + owner 数据）。
//   两者都要求用户输入标签确认，避免误删。

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@keymaster/ui";
import { useOptionalCapability } from "webloom-framework/react";
import { useI18n } from "@keymaster/runtime";
import {
  KEYSPACE_SERVICE_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  formatShortPublicKey
} from "@keymaster/contracts";
import { VaultKeyDeleteModal } from "@keymaster/plugin-vault";
import { toBinding, type BucketRow } from "./bucketCatalog.js";

interface KeyEntry {
  publicKeyHex: string;
  label: string;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; keys: KeyEntry[] }
  | { status: "error"; error: string }
  | { status: "hidden" };

function probeOperationId(): string {
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface BucketKeyListProps {
  row: BucketRow;
  /** vault 是否已解锁；当前桶列 Key 需要。 */
  unlocked: boolean;
  /** 删除成功后通知父页面刷新桶状态。 */
  onChanged(): void;
}

export function BucketKeyList({ row, unlocked, onChanged }: BucketKeyListProps) {
  const { t } = useI18n();
  const storage = useOptionalCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const vault = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const keyspace = useOptionalCapability(KEYSPACE_SERVICE_CAPABILITY);
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [deleting, setDeleting] = useState<KeyEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!row.current && row.backend === "s3") {
      // 非当前 S3 桶需要桶密码；列表入口在顶栏切换器，这里不显示。
      setState({ status: "hidden" });
      return;
    }
    setState({ status: "loading" });
    try {
      if (row.current) {
        if (!vault || vault.status() !== "unlocked") {
          setState({ status: "hidden" });
          return;
        }
        const keys = await vault.listKeys();
        setState({ status: "ready", keys: keys.map((key) => ({ publicKeyHex: key.publicKeyHex, label: key.label })) });
        return;
      }
      if (!storage?.probeBucket) {
        setState({ status: "error", error: "存储探测不可用" });
        return;
      }
      const result = await storage.probeBucket({ operationId: probeOperationId(), backend: "local", binding: toBinding(row) });
      if (!result.ok) {
        setState({ status: "error", error: result.error.summary });
        return;
      }
      setState({ status: "ready", keys: result.state === "has-keys" ? result.keys : [] });
    } catch (caught) {
      setState({ status: "error", error: caught instanceof Error ? caught.message : String(caught) });
    }
    // 不依赖 i18n 函数身份：只按桶/能力变化重载，避免宿主语言对象每次
    // 渲染换引用时陷入 load → setState → 重渲染的循环。
  }, [row, storage, vault]);

  useEffect(() => { void load(); }, [load]);

  async function confirmDelete(confirmationLabel: string, bucketPassword?: string) {
    if (!deleting || busy) return;
    const targetLabel = deleting.label;
    setBusy(true);
    setError(null);
    try {
      if (row.current) {
        if (!keyspace) throw new Error("删除 Key 失败：keyspace 服务不可用");
        await keyspace.deleteKey({
          publicKeyHex: deleting.publicKeyHex,
          confirmationLabel: targetLabel,
          ...(row.backend === "s3" && bucketPassword ? { bucketPassword } : {}),
        });
        onChanged();
      } else {
        if (!storage?.deleteLocalBucketKey) throw new Error("删除 Key 失败：Storage 控制面不支持本地删除");
        await storage.deleteLocalBucketKey(toBinding(row), deleting.publicKeyHex);
        onChanged();
      }
      setDeleting(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      // 让删除确认弹窗保持打开并显示同一错误；用户可以直接重试或取消，
      // 不能因为失败而关闭弹窗、让人误以为已经删除。
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "hidden") return null;
  const unnamed = t("storage.bucketKeys.unnamed", { defaultValue: "未命名 Key" });

  return (
    <div className="storage-bucket-manager__key-list" data-testid={`bucket-key-list-${row.bucketId}`}>
      {state.status === "loading" ? (
        <p className="storage-bucket-manager__key-empty">{t("common.status.loading", { defaultValue: "加载中…" })}</p>
      ) : null}
      {state.status === "error" ? <p className="storage-bucket-manager__key-empty is-error" role="alert">{state.error}</p> : null}
      {state.status === "ready" && state.keys.length === 0 ? (
        <p className="storage-bucket-manager__key-empty">{t("storage.bucketKeys.empty", { defaultValue: "这个桶还没有 Key。" })}</p>
      ) : null}
      {state.status === "ready" ? state.keys.map((key) => (
        <div key={key.publicKeyHex} className="storage-bucket-manager__key-row">
          <span className="storage-bucket-manager__key-label">{key.label || unnamed}</span>
          <code>{formatShortPublicKey(key.publicKeyHex)}</code>
          {row.current || row.backend === "local" ? (
            <Button
              variant="ghost"
              size="sm"
              iconLeft={<Trash2 size={14} />}
              onClick={() => { setError(null); setDeleting(key); }}
              disabled={busy}
              data-testid={`bucket-key-delete-${key.publicKeyHex}`}
            >
              {t("storage.bucketKeys.delete", { defaultValue: "删除" })}
            </Button>
          ) : null}
        </div>
      )) : null}
      {error ? <p className="storage-bucket-manager__key-empty is-error" role="alert">{error}</p> : null}

      <VaultKeyDeleteModal
        open={deleting !== null}
        keyLabel={deleting?.label || unnamed}
        publicKeyHex={deleting?.publicKeyHex}
        requiresBucketPassword={row.current && row.backend === "s3" && unlocked}
        onConfirmDelete={confirmDelete}
        onClose={() => { if (!busy) { setDeleting(null); setError(null); } }}
      />
    </div>
  );
}
