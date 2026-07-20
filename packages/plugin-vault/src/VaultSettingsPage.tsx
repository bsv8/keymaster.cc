// packages/plugin-vault/src/VaultSettingsPage.tsx
// 硬切换 002：Key 管理页（替代原"安全设置"占位页）。
// 设计缘由：
//   - 页面是唯一正式 Key 管理入口：查看 / 设为 active / 导出 / 删除 / 新建。
//   - "新建 Key" 调用 vault.generateKey，私钥生成完全在 Vault 内部完成；
//     本页面不接触私钥材料、不调用 crypto / noble。
//   - 删除仍走 keyspace.deleteKey({ publicKeyHex, password })；不在页面直接调 vault.deleteKeyMaterial。
//   - 桌面端用 DataTable 紧凑展示；移动端改成纵向 Key 条目，状态 / 标签 /
//     短公钥 / 能力 / 时间 / 操作折叠成单条记录，避免横向滚动。
//   - 失败 / uninitialized / 无 publicKeyHex 等边界沿用硬切换 008 防御。
//   - active 通知失败时不删除已安全落库的 Key；提示用户手动切 active。
//
// 硬切换 003：所有展示文案走 i18n。日期通过 Intl.DateTimeFormat(locale) 格式化。
//
// 硬切换 003 收尾：
//   - 删除了"指纹"列；只保留"公钥"列。
//   - 公钥列默认显示**短公钥**（由 `formatShortPublicKey(publicKeyHex)` 现算），
//     用户点"展开公钥"才看完整 hex。
//   - 提供"复制完整公钥"动作，复制永远是完整 `publicKeyHex`，不是截断串。
//   - 删除确认的目标复核改成 `label + 短公钥`（或"身份不可用"）。
//   - 不再读取、构造、回填 `KeyIdentity.fingerprint` 字段。

import { useCallback, useMemo, useState } from "react";
import {
  Button,
  DataTable,
  EmptyState,
  Modal,
  PageHeader,
  TextInput,
  type DataTableColumn
} from "@keymaster/ui";
import { router, useCapability, useI18n, useLocale, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import type {
  ActiveKeyState,
  KeyIdentity,
  KeyRef,
  KeyspaceService,
  VaultService
} from "@keymaster/contracts";
import type { VaultKeyResourceState } from "./manifest.js";
import { VaultKeyCreateModal } from "./VaultKeyCreateModal.js";
import { VaultChangePasswordModal } from "./VaultChangePasswordModal.js";
import { VaultKeyBackupImportModal } from "./VaultKeyBackupImportModal.js";
import { VaultKeyDeleteModal } from "./VaultKeyDeleteModal.js";
import { VaultKeyExportModal } from "./VaultKeyExportModal.js";
import { KeyPersistedButActivationFailedError } from "./vaultService.js";

export function VaultSettingsPage() {
  const vault = useCapability<VaultService>("vault.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染 + 取当前 locale 用于日期格式化。
  const locale = useLocale();
  const keyState = useResourceSelector<VaultKeyResourceState, VaultKeyResourceState>(host.resourceStore, "vault.key-state", [], (s) => s.data ?? { keys: [], active: { activePublicKeyHex: undefined }, initializing: false, notice: null }, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const keys = keyState.keys;
  const active = keyState.active;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

  const [exporting, setExporting] = useState<KeyIdentity | null>(null);
  const [deleting, setDeleting] = useState<KeyIdentity | null>(null);
  const [creating, setCreating] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [importingBackup, setImportingBackup] = useState(false);
  const [activating, setActivating] = useState<KeyIdentity | null>(null);
  const [activatePassword, setActivatePassword] = useState("");
  const [activateError, setActivateError] = useState<string | null>(null);
  const [activateBusy, setActivateBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 日期格式化器随 locale 重建；避免每次渲染都构造 Intl 实例。
  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
    [locale]
  );

  const refresh = useCallback(() => {
    host.resourceStore.invalidate("vault.key-state", []);
  }, [host]);
  const resourceNotice = keyState.notice
    ? t("vault.settings.notice.persisted", { defaultValue: "Key 已保存，但未能自动设为 active。请在列表中手动切换。" }) + ` (${keyState.notice.label})`
    : null;
  const displayedNotice = notice ?? resourceNotice;

  async function lock() {
    const result = await vault.lock();
    if (result.status !== "accepted" && result.status !== "ok") {
      setError("message" in result ? result.message : `Lock failed: ${result.status}`);
    }
  }

  async function goImport() {
    router.push("/import");
  }

  function openChangePassword() {
    setError(null);
    setChangingPassword(true);
  }

  async function handleImportBackup(restored: KeyRef) {
    setError(null);
    setNotice(
      t("vault.keyImportBackup.notice", {
        defaultValue: "备份已恢复：{{label}}",
        label: restored.label || t("vault.settings.empty.label", { defaultValue: "未命名" })
      })
    );
    await refresh();
  }

  async function handleExport(): Promise<string> {
    if (!exporting) throw new Error("No key selected");
    // 单 Key Backup：直接导出本机加密记录，不再要求输入密码。
    return vault.exportKeyBackup(exporting.publicKeyHex);
  }

  async function handleDelete(password: string) {
    if (!deleting) return;
    try {
      // 硬切换 002 收尾：删除入口必须带锁屏密码 + publicKeyHex；
      // service 层负责校验真伪、决定是否触发"空 Vault 收尾"。
      // 页面只透传 modal 收集的密码，**不**在这里多调一次
      // vault.verifyPassword（会让授权语义出现两个真值来源），
      // 也**不**在这里判断"删完是否要跳欢迎页"——真正的状态源
      // 是 vault.status()，由 App 自然切回 LockedShell。
      await keyspace.deleteKey({ publicKeyHex: deleting.publicKeyHex, password });
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.settings.err.delete", { defaultValue: "删除失败" })
      );
      // 重新抛出让 modal 的 try/catch 捕获——modal 看到抛错才会保持
      // final step 打开、把错误展示给用户继续重试。
      throw err;
    }
  }

  function beginActivate(k: KeyIdentity) {
    if (!k.publicKeyHex) return;
    if (k.publicKeyHex === active.activePublicKeyHex) return;
    setError(null);
    setActivateError(null);
    setActivatePassword("");
    setActivating(k);
  }

  function closeActivate() {
    if (activateBusy) return;
    setActivating(null);
    setActivatePassword("");
    setActivateError(null);
  }

  async function confirmActivate() {
    if (!activating?.publicKeyHex || activateBusy) return;
    setActivateBusy(true);
    setActivateError(null);
    try {
      const result = await vault.activateKey({
        publicKeyHex: activating.publicKeyHex,
        password: activatePassword
      });
      if (result.status !== "accepted") {
        setActivateError("message" in result ? result.message : result.status === "blocked" ? (typeof result.reason === "string" ? result.reason : result.reason.fallback) : `Activate key failed: ${result.status}`);
        return;
      }
      // 硬切换 009 收尾：如果 vault 还有"首 Key 未自动 active"
      // notice，且这把 key 正好就是 notice 里的 key，清掉它。
      const notice =
        typeof vault.getInitialActivationNotice === "function"
          ? vault.getInitialActivationNotice()
          : null;
      if (notice && notice.publicKeyHex === activating.publicKeyHex) {
        vault.clearInitialActivationNotice();
      }
      setActivating(null);
      setActivatePassword("");
      setActivateError(null);
    } catch (err) {
      setActivateError(
        err instanceof Error
          ? err.message
          : t("vault.settings.activate.err.failed", { defaultValue: "Failed to switch key" })
      );
    } finally {
      setActivateBusy(false);
    }
  }

  // 复制完整公钥到剪贴板。硬切换 003 收尾：复制永远是完整 publicKeyHex，
  // 绝不能复制短公钥截断串。
  async function copyPublicKey(k: KeyIdentity) {
    if (!k.publicKeyHex) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(k.publicKeyHex);
      } else {
        // 退化路径：使用临时 textarea + execCommand。
        const ta = document.createElement("textarea");
        ta.value = k.publicKeyHex;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopyNotice(
        t("vault.settings.notice.copied", { defaultValue: "已复制完整公钥" })
      );
      setTimeout(() => setCopyNotice(null), 2000);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("vault.settings.err.copy", { defaultValue: "复制失败" })
      );
    }
  }

  async function handleCreate(label: string, password: string): Promise<KeyRef> {
    try {
      const ref = await vault.generateKey({ label, password });
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
      const maybeHex = (err as { publicKeyHex?: unknown }).publicKeyHex;
      if (typeof maybeHex === "string" && maybeHex) {
        const found = list.find((k) => k.publicKeyHex === maybeHex);
        if (found) return found;
      }
    }
    return list.find(
      // 硬切换 002 收尾：identityStatus 已删除，按 publicKeyHex 判 ready。
      (k) => k.label === label && Boolean(k.publicKeyHex)
    );
  }

  function keyIdentityToKeyRef(identity: KeyIdentity): KeyRef {
    // 硬切换 002 收尾：KeyRef 不再含 `id` 字段（vault 内部 uuid 已删）；
    // `publicKeyHex` 是平台身份根字段。
    return {
      label: identity.label,
      format: "generated",
      capabilities: identity.capabilities,
      createdAt: identity.createdAt,
      source: "vault-generated",
      publicKeyHex: identity.publicKeyHex
    };
  }

  function handleCreateExport(key: KeyRef) {
    // 硬切换 002 收尾：KeyRef 不再持有 `id`；`publicKeyHex` 唯一真值。
    const identity: KeyIdentity = {
      publicKeyHex: key.publicKeyHex ?? "",
      label: key.label,
      capabilities: key.capabilities,
      createdAt: key.createdAt
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
      key: "status",
      header: t("vault.settings.col.status", { defaultValue: "状态" }),
      render: (r) => {
        // 硬切换 002 收尾：identityStatus 已删除，KeyIdentity 必 ready。
        if (!r.publicKeyHex) {
          return (
            <span className="vault-key-status vault-key-status--init">
              {statusInitText}
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
      // 硬切换 003 收尾：默认显示短公钥；展开后显示完整 publicKeyHex；
      // 复制按钮复制完整公钥（不是截断串）。
      render: (r) => {
        if (!r.publicKeyHex) {
          return <span style={{ color: "var(--text-dim)" }}>{identityMissingText}</span>;
        }
        const publicKeyHex = r.publicKeyHex;
        return expanded[publicKeyHex] ? (
          <div className="vault-key-pubkey-expanded">
            <code className="vault-key-pubkey-full">{publicKeyHex}</code>
            <button
              type="button"
              className="vault-key-public-toggle"
              onClick={() => copyPublicKey(r)}
            >
              {t("vault.settings.action.copyPubkey", { defaultValue: "复制完整公钥" })}
            </button>
            <button
              type="button"
              className="vault-key-public-toggle"
              onClick={() => setExpanded((m) => ({ ...m, [publicKeyHex]: false }))}
            >
              {t("vault.settings.action.collapsePubkey", { defaultValue: "收起" })}
            </button>
          </div>
        ) : (
          <div className="vault-key-pubkey-collapsed">
            <code className="vault-key-pubkey-short">{formatShortPublicKey(publicKeyHex)}</code>
            <button
              type="button"
              className="vault-key-public-toggle"
              onClick={() => setExpanded((m) => ({ ...m, [publicKeyHex]: true }))}
            >
              {t("vault.settings.action.expandPubkey", { defaultValue: "展开公钥" })}
            </button>
          </div>
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
        const isActive = active.activePublicKeyHex === r.publicKeyHex;
        // 硬切换 002 收尾：identityStatus 已删除，KeyIdentity 必 ready。
        const canSetActive = Boolean(r.publicKeyHex);
        return (
          <div className="vault-key-actions">
            <Button
              variant={isActive ? "primary" : "secondary"}
              size="sm"
              onClick={() => beginActivate(r)}
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
        const isActive = active.activePublicKeyHex === r.publicKeyHex;
        // 硬切换 002 收尾：identityStatus 已删除，KeyIdentity 必 ready。
        const canSetActive = Boolean(r.publicKeyHex);
        const status = r.publicKeyHex ? "ready" : "uninitialized";
        const statusLabel = status === "uninitialized" ? statusInitText : statusReadyText;
        const statusClass =
          status === "uninitialized"
            ? "vault-key-status--init"
            : "vault-key-status--ready";
        return (
          <li key={r.publicKeyHex} className="vault-key-list__item">
            <div className="vault-key-list__head">
              <span className="vault-key-list__label">{r.label || unnamedText}</span>
              <span className={`vault-key-status ${statusClass}`}>{statusLabel}</span>
            </div>
            <div className="vault-key-list__meta">
              {r.publicKeyHex ? (
                <code className="vault-key-list__pubkey">{formatShortPublicKey(r.publicKeyHex)}</code>
              ) : (
                <code>{identityMissingText}</code>
              )}
            </div>
            <div className="vault-key-list__caps">
              {r.capabilities.join(", ")} · {dateFmt.format(new Date(r.createdAt))}
            </div>
            {r.publicKeyHex ? (
              expanded[r.publicKeyHex] ? (
                <div className="vault-key-list__pubkey-detail">
                  <code className="vault-key-list__pub">{r.publicKeyHex}</code>
                  <button
                    type="button"
                    className="vault-key-public-toggle"
                    onClick={() => copyPublicKey(r)}
                  >
                    {t("vault.settings.action.copyPubkey", { defaultValue: "复制完整公钥" })}
                  </button>
                  <button
                    type="button"
                    className="vault-key-public-toggle"
                    onClick={() => setExpanded((m) => ({ ...m, [r.publicKeyHex!]: false }))}
                  >
                    {t("vault.settings.action.collapsePubkey", { defaultValue: "收起" })}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="vault-key-public-toggle"
                  onClick={() => setExpanded((m) => ({ ...m, [r.publicKeyHex!]: true }))}
                >
                  {t("vault.settings.action.expandPubkey", { defaultValue: "展开公钥" })}
                </button>
              )
            ) : null}
            <div className="vault-key-list__actions">
              <Button
                variant={isActive ? "primary" : "secondary"}
                size="sm"
                onClick={() => beginActivate(r)}
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
      <Button variant="secondary" onClick={openChangePassword}>
        {t("vault.settings.action.changePassword", { defaultValue: "修改密码" })}
      </Button>
      <Button variant="secondary" onClick={() => setImportingBackup(true)}>
        {t("vault.settings.action.importBackup", { defaultValue: "导入备份" })}
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
      {displayedNotice ? <p className="vault-page__notice">{displayedNotice}</p> : null}
      {copyNotice ? <p className="vault-page__notice">{copyNotice}</p> : null}
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
              <Button variant="secondary" onClick={openChangePassword}>
                {t("vault.settings.action.changePassword", { defaultValue: "修改密码" })}
              </Button>
              <Button variant="secondary" onClick={() => setImportingBackup(true)}>
                {t("vault.settings.action.importBackup", { defaultValue: "导入备份" })}
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
            <DataTable columns={columns} rows={keys} rowKey={(r) => r.publicKeyHex} />
          </div>
          <div className="vault-page__mobile">{mobileList}</div>
        </>
      )}

      {exporting ? (
        <VaultKeyExportModal
          open={Boolean(exporting)}
          publicKeyHex={exporting.publicKeyHex}
          keyLabel={exporting.label}
          onExport={handleExport}
          onClose={() => setExporting(null)}
        />
      ) : null}

      {deleting ? (
        <VaultKeyDeleteModal
          open={Boolean(deleting)}
          keyLabel={deleting.label}
          // 硬切换 003 收尾：传完整公钥，modal 内部按需现算短公钥。
          publicKeyHex={deleting.publicKeyHex}
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

      {changingPassword ? (
        <VaultChangePasswordModal
          open={changingPassword}
          vault={vault}
          onClose={() => setChangingPassword(false)}
        />
      ) : null}

      {importingBackup ? (
        <VaultKeyBackupImportModal
          open={importingBackup}
          vault={vault}
          onImported={handleImportBackup}
          onClose={() => setImportingBackup(false)}
        />
      ) : null}

      <Modal
        open={activating !== null}
        title={t("vault.settings.activate.title", { defaultValue: "Confirm switch" })}
        onClose={closeActivate}
        footer={
          <>
            <Button variant="ghost" onClick={closeActivate} disabled={activateBusy}>
              {t("common.action.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button onClick={confirmActivate} loading={activateBusy} disabled={!activatePassword}>
              {t("vault.settings.activate.submit", { defaultValue: "Confirm" })}
            </Button>
          </>
        }
      >
        <p className="vault-settings-activate__hint">
          {t("vault.settings.activate.hint", {
            defaultValue: "Enter the Vault password to switch the active key."
          })}
        </p>
        {activating ? (
          <p className="vault-settings-activate__target">
            {activating.label || unnamedText} <code>{formatShortPublicKey(activating.publicKeyHex)}</code>
          </p>
        ) : null}
        <TextInput
          label={t("vault.settings.activate.password", { defaultValue: "Password" })}
          type="password"
          autoComplete="current-password"
          value={activatePassword}
          onChange={(e) => setActivatePassword(e.currentTarget.value)}
          error={activateError ?? undefined}
          autoFocus
        />
      </Modal>
    </div>
  );
}
