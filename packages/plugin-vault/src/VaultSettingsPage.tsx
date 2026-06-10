// packages/plugin-vault/src/VaultSettingsPage.tsx
// 硬切换 002：Key 管理页（替代原"安全设置"占位页）。
// 设计缘由：
//   - 页面是唯一正式 Key 管理入口：查看 / 设为 active / 导出 / 删除 / 新建。
//   - "新建 Key" 调用 vault.generateKey，私钥生成完全在 Vault 内部完成；
//     本页面不接触私钥材料、不调用 crypto / noble。
//   - 删除仍走 keyspace.deleteKeyById(keyId)；不在页面直接调 vault.deleteKeyMaterial。
//   - 桌面端用 DataTable 紧凑展示；移动端改成纵向 Key 条目，状态 / 标签 /
//     指纹 / 能力 / 时间 / 操作折叠成单条记录，避免横向滚动。
//   - 失败 / uninitialized / 无 publicKeyHash 等边界沿用硬切换 008 防御。
//   - active 通知失败时不删除已安全落库的 Key；提示用户手动切 active。
//
// 硬切换 003：所有展示文案走 i18n。日期通过 Intl.DateTimeFormat(locale) 格式化。

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, type DataTableColumn } from "@keymaster/ui";
import { router, useCapability, useI18n, useLocale } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  KeyExportEnvelope,
  KeyIdentity,
  KeyRef,
  KeyspaceService,
  MessageBus,
  VaultService
} from "@keymaster/contracts";
import { VaultKeyCreateModal } from "./VaultKeyCreateModal.js";
import { VaultKeyDeleteModal } from "./VaultKeyDeleteModal.js";
import { VaultKeyExportModal } from "./VaultKeyExportModal.js";
import { KeyPersistedButActivationFailedError } from "./vaultService.js";

export function VaultSettingsPage() {
  const vault = useCapability<VaultService>("vault.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const messageBus = useCapability<MessageBus>("runtime.messageBus");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染 + 取当前 locale 用于日期格式化。
  const locale = useLocale();
  const [keys, setKeys] = useState<KeyIdentity[]>([]);
  const [active, setActive] = useState<ActiveKeyState>(keyspace.active());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [exporting, setExporting] = useState<KeyIdentity | null>(null);
  const [deleting, setDeleting] = useState<KeyIdentity | null>(null);
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 日期格式化器随 locale 重建；避免每次渲染都构造 Intl 实例。
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );

  const refresh = useCallback(async () => {
    try {
      const list = await keyspace.listKeys();
      setKeys(list);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.settings.err.load", { defaultValue: "Failed to load keys" })
      );
    }
  }, [keyspace, t]);

  useEffect(() => {
    refresh();
    const off = keyspace.onActiveChange((s) => setActive(s));
    return () => off();
  }, [refresh, keyspace]);

  useEffect(() => {
    if (!messageBus) return;
    const trigger = () => {
      void refresh();
    };
    const offs: Array<() => void> = [];
    offs.push(messageBus.subscribe("key.created", trigger));
    offs.push(messageBus.subscribe("key.identity.ready", trigger));
    offs.push(messageBus.subscribe("key.identity.failed", trigger));
    return () => {
      for (const off of offs) off();
    };
  }, [messageBus, refresh]);

  async function lock() {
    await vault.lock();
  }

  async function goImport() {
    router.push("/import");
  }

  async function handleExport(password: string): Promise<KeyExportEnvelope> {
    if (!exporting) throw new Error("No key selected");
    return vault.exportPrivateKey({ keyId: exporting.keyId, password });
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await keyspace.deleteKeyById(deleting.keyId);
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.settings.err.delete", { defaultValue: "删除失败" })
      );
    }
  }

  async function setAsActive(k: KeyIdentity) {
    if (!k.publicKeyHash) return;
    if (k.identityStatus && k.identityStatus !== "ready") return;
    try {
      await keyspace.setActive(k.publicKeyHash);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.settings.err.setActive", { defaultValue: "Failed to switch key" })
      );
    }
  }

  async function handleCreate(label: string): Promise<KeyRef> {
    try {
      const ref = await vault.generateKey({ label });
      setError(null);
      setNotice(null);
      return ref;
    } catch (err) {
      if (err instanceof KeyPersistedButActivationFailedError) {
        setError(null);
        setNotice(
          t("vault.settings.notice.persisted", {
            defaultValue: "Key 已保存，但未能自动设为 active。请在列表中手动切换。"
          })
        );
        void refresh();
        return err.key;
      }
      let persisted: KeyIdentity | undefined;
      try {
        const fresh = await keyspace.listKeys();
        setKeys(fresh);
        persisted = findPersistedIdentity(err, label, fresh);
      } catch {
        // 静默
      }
      if (persisted) {
        setError(null);
        setNotice(
          t("vault.settings.notice.persisted", {
            defaultValue: "Key 已保存，但未能自动设为 active。请在列表中手动切换。"
          })
        );
        return keyIdentityToKeyRef(persisted);
      }
      const message =
        err instanceof Error
          ? err.message
          : t("vault.settings.err.create", { defaultValue: "创建失败" });
      setNotice(null);
      setError(message);
      throw err;
    }
  }

  function findPersistedIdentity(
    err: unknown,
    label: string,
    list: KeyIdentity[]
  ): KeyIdentity | undefined {
    if (err instanceof Error) {
      const maybeHash = (err as { publicKeyHash?: unknown }).publicKeyHash;
      if (typeof maybeHash === "string" && maybeHash) {
        const found = list.find((k) => k.publicKeyHash === maybeHash);
        if (found) return found;
      }
    }
    return list.find(
      (k) => k.label === label && (k.publicKeyHash || k.identityStatus === "failed")
    );
  }

  function keyIdentityToKeyRef(identity: KeyIdentity): KeyRef {
    return {
      id: identity.keyId,
      label: identity.label,
      format: "generated",
      capabilities: identity.capabilities,
      createdAt: identity.createdAt,
      source: "vault-generated",
      publicKeyHex: identity.publicKeyHex,
      publicKeyHash: identity.publicKeyHash,
      fingerprint: identity.fingerprint
    };
  }

  function handleCreateExport(key: KeyRef) {
    const identity: KeyIdentity = {
      keyId: key.id,
      publicKeyHex: key.publicKeyHex ?? "",
      publicKeyHash: key.publicKeyHash ?? "",
      fingerprint: key.fingerprint ?? "",
      label: key.label,
      capabilities: key.capabilities,
      createdAt: key.createdAt,
      identityStatus: "ready"
    };
    setExporting(identity);
  }

  const unnamedText = t("vault.settings.empty.label", { defaultValue: "未命名" });
  const identityMissingText = t("vault.settings.empty.fingerprint", { defaultValue: "身份不可用" });
  const statusFailedText = t("vault.settings.status.failed", { defaultValue: "身份失败" });
  const statusInitText = t("vault.settings.status.initializing", { defaultValue: "初始化中" });
  const statusReadyText = t("vault.settings.status.ready", { defaultValue: "可用" });

  const columns: DataTableColumn<KeyIdentity>[] = [
    {
      key: "label",
      header: t("vault.settings.col.label", { defaultValue: "标签" }),
      render: (r) => (r.label ? r.label : <span style={{ color: "var(--text-dim)" }}>{unnamedText}</span>)
    },
    {
      key: "fingerprint",
      header: t("vault.settings.col.fingerprint", { defaultValue: "指纹" }),
      render: (r) =>
        r.fingerprint ? <code>{r.fingerprint}</code> : <span style={{ color: "var(--text-dim)" }}>{identityMissingText}</span>
    },
    {
      key: "status",
      header: t("vault.settings.col.status", { defaultValue: "状态" }),
      render: (r) => {
        const status = r.identityStatus ?? (r.publicKeyHash ? "ready" : "uninitialized");
        if (status === "failed") {
          return (
            <span className="vault-key-status vault-key-status--failed" title={r.identityError}>
              {statusFailedText}
            </span>
          );
        }
        if (status === "uninitialized") {
          return <span className="vault-key-status vault-key-status--init">{statusInitText}</span>;
        }
        return <span className="vault-key-status vault-key-status--ready">{statusReadyText}</span>;
      }
    },
    {
      key: "pub",
      header: t("vault.settings.col.pubkey", { defaultValue: "公钥" }),
      render: (r) => {
        if (!r.publicKeyHash || !r.publicKeyHex) {
          return <span style={{ color: "var(--text-dim)" }}>{identityMissingText}</span>;
        }
        const publicKeyHash = r.publicKeyHash;
        return expanded[publicKeyHash] ? (
          <code style={{ wordBreak: "break-all" }}>{r.publicKeyHex}</code>
        ) : (
          <button
            type="button"
            className="vault-key-public-toggle"
            onClick={() => setExpanded((m) => ({ ...m, [publicKeyHash]: true }))}
          >
            {t("vault.settings.action.expand", { defaultValue: "展开" })}
          </button>
        );
      }
    },
    {
      key: "caps",
      header: t("vault.settings.col.caps", { defaultValue: "能力" }),
      render: (r) => r.capabilities.join(", ")
    },
    {
      key: "created",
      header: t("vault.settings.col.created", { defaultValue: "创建时间" }),
      render: (r) => dateFmt.format(new Date(r.createdAt))
    },
    {
      key: "actions",
      header: t("vault.settings.col.actions", { defaultValue: "操作" }),
      render: (r) => {
        const isActive =
          active.mode === "single" && active.activePublicKeyHash === r.publicKeyHash;
        const canSetActive = Boolean(r.publicKeyHash) && (!r.identityStatus || r.identityStatus === "ready");
        return (
          <div className="vault-key-actions">
            <Button
              variant={isActive ? "primary" : "secondary"}
              size="sm"
              onClick={() => setAsActive(r)}
              disabled={isActive || !canSetActive}
            >
              {isActive
                ? t("vault.settings.action.current", { defaultValue: "当前 key" })
                : t("vault.settings.action.setActive", { defaultValue: "设为 active" })}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setError(null);
                setExporting(r);
              }}
            >
              {t("vault.settings.action.export", { defaultValue: "导出" })}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setError(null);
                setDeleting(r);
              }}
            >
              {t("vault.settings.action.delete", { defaultValue: "删除" })}
            </Button>
          </div>
        );
      }
    }
  ];

  const mobileList = (
    <ul className="vault-key-list">
      {keys.map((r) => {
        const isActive =
          active.mode === "single" && active.activePublicKeyHash === r.publicKeyHash;
        const canSetActive =
          Boolean(r.publicKeyHash) && (!r.identityStatus || r.identityStatus === "ready");
        const status = r.identityStatus ?? (r.publicKeyHash ? "ready" : "uninitialized");
        const statusLabel =
          status === "failed" ? statusFailedText : status === "uninitialized" ? statusInitText : statusReadyText;
        const statusClass =
          status === "failed"
            ? "vault-key-status--failed"
            : status === "uninitialized"
            ? "vault-key-status--init"
            : "vault-key-status--ready";
        return (
          <li key={r.keyId} className="vault-key-list__item">
            <div className="vault-key-list__head">
              <span className="vault-key-list__label">{r.label || unnamedText}</span>
              <span className={`vault-key-status ${statusClass}`}>{statusLabel}</span>
            </div>
            <div className="vault-key-list__meta">
              <code>{r.fingerprint || identityMissingText}</code>
            </div>
            <div className="vault-key-list__caps">
              {r.capabilities.join(", ")} · {dateFmt.format(new Date(r.createdAt))}
            </div>
            {r.publicKeyHash && r.publicKeyHex ? (
              expanded[r.publicKeyHash] ? (
                <code className="vault-key-list__pub">{r.publicKeyHex}</code>
              ) : (
                <button
                  type="button"
                  className="vault-key-public-toggle"
                  onClick={() => setExpanded((m) => ({ ...m, [r.publicKeyHash!]: true }))}
                >
                  {t("vault.settings.action.expandPubkey", { defaultValue: "展开公钥" })}
                </button>
              )
            ) : null}
            <div className="vault-key-list__actions">
              <Button
                variant={isActive ? "primary" : "secondary"}
                size="sm"
                onClick={() => setAsActive(r)}
                disabled={isActive || !canSetActive}
              >
                {isActive
                  ? t("vault.settings.action.current", { defaultValue: "当前 key" })
                  : t("vault.settings.action.setActive", { defaultValue: "设为 active" })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setError(null);
                  setExporting(r);
                }}
              >
                {t("vault.settings.action.export", { defaultValue: "导出" })}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setError(null);
                  setDeleting(r);
                }}
              >
                {t("vault.settings.action.delete", { defaultValue: "删除" })}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );

  const headerActions = (
    <>
      <Button onClick={() => setCreating(true)}>
        {t("vault.settings.action.new", { defaultValue: "新建 Key" })}
      </Button>
      <Button variant="secondary" onClick={goImport}>
        {t("vault.settings.action.import", { defaultValue: "导入 Key" })}
      </Button>
      <Button variant="ghost" onClick={lock}>
        {t("vault.settings.action.lock", { defaultValue: "锁定钱包" })}
      </Button>
    </>
  );

  return (
    <div className="vault-page vault-page--settings">
      <PageHeader
        title={t("vault.settings.title", { defaultValue: "Key 管理" })}
        description={t("vault.settings.description", {
          defaultValue: "管理本地 Vault 中的 Key、active 身份和加密备份。"
        })}
        actions={headerActions}
      />
      {error ? <p className="vault-page__error">{error}</p> : null}
      {notice ? <p className="vault-page__notice">{notice}</p> : null}
      {keys.length === 0 ? (
        <EmptyState
          title={t("vault.settings.empty.title", { defaultValue: "还没有 Key" })}
          description={t("vault.settings.empty.desc", {
            defaultValue: "可以在本地安全生成一把新 Key，也可以导入已有私钥。"
          })}
          action={
            <>
              <Button onClick={() => setCreating(true)}>
                {t("vault.settings.action.new", { defaultValue: "新建 Key" })}
              </Button>
              <Button variant="secondary" onClick={goImport}>
                {t("vault.settings.action.import", { defaultValue: "导入 Key" })}
              </Button>
            </>
          }
        />
      ) : (
        <>
          <div className="vault-page__table">
            <DataTable columns={columns} rows={keys} rowKey={(r) => r.keyId} />
          </div>
          <div className="vault-page__mobile">{mobileList}</div>
        </>
      )}

      {exporting ? (
        <VaultKeyExportModal
          open={Boolean(exporting)}
          keyId={exporting.keyId}
          keyLabel={exporting.label}
          onExport={handleExport}
          onClose={() => setExporting(null)}
        />
      ) : null}

      {deleting ? (
        <VaultKeyDeleteModal
          open={Boolean(deleting)}
          keyLabel={deleting.label}
          keyFingerprint={deleting.fingerprint}
          confirmText={deleting.fingerprint || deleting.label || deleting.keyId}
          onExportBackup={
            () => {
              setExporting(deleting);
              setDeleting(null);
            }
          }
          onConfirmDelete={handleDelete}
          onClose={() => setDeleting(null)}
        />
      ) : null}

      {creating ? (
        <VaultKeyCreateModal
          open={creating}
          onCreate={handleCreate}
          onExport={handleCreateExport}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}
