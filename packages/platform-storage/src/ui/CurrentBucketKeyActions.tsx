// packages/platform-storage/src/ui/CurrentBucketKeyActions.tsx
// 当前桶的 Key 操作：新建 Key / 导入 Key。
//
// 复用约束（与初始化同源，避免两套实现各自出错）：
//   - 导入解析复用 @keymaster/plugin-key-import 的 KeyImportWizard；
//   - Key 密码规则复用 bucketSetupService.validateKeyPassword；
//   - 持久化由 VaultService.generateKey / importPrivateKey 完成，落盘仍是
//     keys/<公钥>.keyhold 单一真值路径（与初始化首 Key 相同）。
//
// 只对"当前桶"提供操作：非当前桶必须先切换并解锁后才能管理 Key。
//
// 成功后统一进入首页：新 Key 会成为 active 身份，shell 会在身份切换时
// 重建路由内容（弹窗无法保留成功提示）；与顶栏切换一致回到 home，让用户
// 直接看到新身份。

import { useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useOptionalCapability } from "webloom-framework/react";
import { router, useI18n } from "@keymaster/runtime";
import { VAULT_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { KeyImportWizard, type InitialSetupImportedKeyDraft } from "@keymaster/plugin-key-import/KeyImportWizard";
import { defaultKeyLabel, validateKeyPassword } from "./bucketSetupService.js";

export interface CurrentBucketKeyActionsProps {
  /** 当前桶显示名称（仅用于提示）。 */
  bucketLabel: string;
  /** vault 是否已解锁；未解锁时禁用操作并提示。 */
  unlocked: boolean;
  /** 新 Key 已落库并激活后的回调（父页面刷新列表 / 提示）。 */
  onChanged?(): void;
}

type ActionMode = "create" | "import" | null;
type ImportPhase = "wizard" | "password";

const IDLE_IMPORT = {
  phase: "wizard" as ImportPhase,
  draft: null as InitialSetupImportedKeyDraft | null,
  password: "",
  passwordConfirm: "",
  error: null as string | null,
  busy: false,
};

export function CurrentBucketKeyActions({ bucketLabel, unlocked, onChanged }: CurrentBucketKeyActionsProps) {
  const { t } = useI18n();
  const vault = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const [mode, setMode] = useState<ActionMode>(null);

  // 新建 Key 状态。
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  // 导入 Key 状态。
  const [importState, setImportState] = useState(IDLE_IMPORT);

  function openMode(next: Exclude<ActionMode, null>) {
    setMode(next);
    setCreateError(null);
    setCreateBusy(false);
    setLabel(defaultKeyLabel());
    setPassword("");
    setPasswordConfirm("");
    setImportState(IDLE_IMPORT);
  }

  function close() {
    setMode(null);
    // 关闭即丢弃本次输入的所有密码与导入材料草稿。
    setPassword("");
    setPasswordConfirm("");
    setCreateError(null);
    setImportState(IDLE_IMPORT);
  }

  async function submitCreate() {
    if (!vault || createBusy) return;
    const trimmed = label.trim();
    if (!trimmed) { setCreateError(t("storage.bucketKeys.err.label", { defaultValue: "请输入 Key 标签。" })); return; }
    const invalid = validateKeyPassword({ password, confirm: passwordConfirm });
    if (invalid) { setCreateError(invalid); return; }
    setCreateBusy(true);
    setCreateError(null);
    try {
      await vault.generateKey({ password, label: trimmed, capabilities: ["p2pkh"] });
      setPassword("");
      setPasswordConfirm("");
      onChanged?.();
      router.push("/");
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t("storage.bucketKeys.err.create", { defaultValue: "新建 Key 失败" }));
    } finally {
      setCreateBusy(false);
    }
  }

  function acceptImportedKey(draft: InitialSetupImportedKeyDraft) {
    setImportState((current) => ({ ...current, phase: "password", draft, error: null }));
  }

  async function submitImport() {
    if (!vault || importState.busy || !importState.draft) return;
    const invalid = validateKeyPassword({ password: importState.password, confirm: importState.passwordConfirm });
    if (invalid) { setImportState((current) => ({ ...current, error: invalid })); return; }
    setImportState((current) => ({ ...current, busy: true, error: null }));
    try {
      await vault.importPrivateKey({
        password: importState.password,
        label: importState.draft.label,
        material: importState.draft.material,
        format: importState.draft.format,
        capabilities: importState.draft.capabilities,
        ...(importState.draft.source === undefined ? {} : { source: importState.draft.source }),
      });
      setImportState(IDLE_IMPORT);
      onChanged?.();
      router.push("/");
    } catch (error) {
      setImportState((current) => ({
        ...current,
        busy: false,
        error: error instanceof Error ? error.message : t("storage.bucketKeys.err.import", { defaultValue: "导入 Key 失败" }),
      }));
    }
  }

  const disabled = !unlocked || !vault;
  const disabledTitle = t("storage.bucketKeys.lockedHint", { defaultValue: "请先解锁当前桶后再管理 Key。" });

  return (
    <>
      <div className="storage-bucket-manager__key-actions">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => openMode("create")}
          disabled={disabled}
          title={disabled ? disabledTitle : undefined}
        >
          {t("storage.bucketKeys.create", { defaultValue: "新建 Key" })}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => openMode("import")}
          disabled={disabled}
          title={disabled ? disabledTitle : undefined}
        >
          {t("storage.bucketKeys.import", { defaultValue: "导入 Key" })}
        </Button>
      </div>

      <Modal
        open={mode === "create"}
        title={t("storage.bucketKeys.createTitle", { defaultValue: "在当前桶新建 Key" })}
        onClose={() => { if (!createBusy) close(); }}
        footer={(
          <>
            <Button variant="ghost" onClick={close} disabled={createBusy}>{t("common.action.cancel", { defaultValue: "取消" })}</Button>
            <Button onClick={() => void submitCreate()} loading={createBusy} disabled={!label.trim() || !password}>
              {t("storage.bucketKeys.createSubmit", { defaultValue: "创建 Key" })}
            </Button>
          </>
        )}
        data-testid="bucket-create-key"
      >
        <p className="storage-bucket-manager__key-hint">
          {t("storage.bucketKeys.createHint", { defaultValue: "私钥在 Vault 内部安全生成，用这把 Key 自己的密码加密保存；创建后自动设为 active。" })}
          {" "}
          <code>{bucketLabel}</code>
        </p>
        <TextInput
          label={t("storage.bucketKeys.label", { defaultValue: "Key 标签" })}
          value={label}
          onChange={(event) => setLabel(event.currentTarget.value)}
          placeholder={t("storage.bucketKeys.labelPlaceholder", { defaultValue: "例如：Key 2026-09-18 10:30" })}
          error={createError ?? undefined}
          autoFocus
        />
        <TextInput
          label={t("storage.bucketKeys.password", { defaultValue: "Key 密码（至少 8 位）" })}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
        <TextInput
          label={t("storage.bucketKeys.passwordConfirm", { defaultValue: "再输入一次 Key 密码" })}
          type="password"
          autoComplete="new-password"
          value={passwordConfirm}
          onChange={(event) => setPasswordConfirm(event.currentTarget.value)}
        />
      </Modal>

      <Modal
        open={mode === "import"}
        title={t("storage.bucketKeys.importTitle", { defaultValue: "在当前桶导入 Key" })}
        onClose={() => { if (!importState.busy) close(); }}
        footer={
          importState.phase === "password" ? (
            <>
              <Button variant="ghost" onClick={() => setImportState((current) => ({ ...current, phase: "wizard", error: null }))} disabled={importState.busy}>
                {t("common.action.back", { defaultValue: "返回" })}
              </Button>
              <Button onClick={() => void submitImport()} loading={importState.busy} disabled={!importState.password}>
                {t("storage.bucketKeys.importSubmit", { defaultValue: "保存到当前桶" })}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={close}>{t("common.action.cancel", { defaultValue: "取消" })}</Button>
          )
        }
        data-testid="bucket-import-key"
      >
        {importState.phase === "wizard" ? (
          <KeyImportWizard
            draftMode
            onCancel={close}
            onComplete={acceptImportedKey}
          />
        ) : importState.draft ? (
          <>
            <p className="storage-bucket-manager__key-hint">
              {t("storage.bucketKeys.importHint", { defaultValue: "导入材料已在本地解析；设置这把 Key 自己的密码后写入当前桶。" })}
              {" "}
              <strong>{importState.draft.label}</strong>（{importState.draft.format}）
            </p>
            <TextInput
              label={t("storage.bucketKeys.password", { defaultValue: "Key 密码（至少 8 位）" })}
              type="password"
              autoComplete="new-password"
              value={importState.password}
              onChange={(event) => setImportState((current) => ({ ...current, password: event.currentTarget.value }))}
              error={importState.error ?? undefined}
              autoFocus
            />
            <TextInput
              label={t("storage.bucketKeys.passwordConfirm", { defaultValue: "再输入一次 Key 密码" })}
              type="password"
              autoComplete="new-password"
              value={importState.passwordConfirm}
              onChange={(event) => setImportState((current) => ({ ...current, passwordConfirm: event.currentTarget.value }))}
            />
          </>
        ) : null}
      </Modal>
    </>
  );
}
