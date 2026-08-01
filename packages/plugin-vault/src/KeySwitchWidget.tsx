// packages/plugin-vault/src/KeySwitchWidget.tsx
// 顶栏 key switch widget。
// 设计缘由：
//   - 顶栏在 order 90 注册，位于 background.tray (order 100) 左侧。
//   - 内部通过 keyspace.service 维护 active key；不直接持有 active key 状态。
//   - 显示 label + 短公钥（publicKeyHex 截断）；不再有"全部 key"入口。
//   - 切换 key 时调用 keyspace.setActive；菜单只列出 ready keys。
//   - 与 BackgroundTray 同高度，使用 lucide 图标。
//   - 切换时清空未提交 provider draft：本期由 keyspace 通过事件 activeKey.changed
//     通知，业务插件各自订阅处理。
//
// 硬切换 008：widget 订阅 key.created / key.deleted / key.identity.ready /
// key.identity.failed 事件，在 key 列表变化时主动重拉；不再依赖 mount 时的
// 一次性 load。
//
// 硬切换 003：所有展示文案走 i18n。
//
// 硬切换 003 收尾：
//   - 短公钥通过 `formatShortPublicKey(publicKeyHex)` 运行时现算。
//   - 不再读取 `KeyIdentity.fingerprint` 字段。
//   - class 命名从 `key-switch__fingerprint` 改为 `key-switch__pubkey`。
//
// 硬切换 005 收尾：删除"全部 key"入口。`active` state 不再有 `mode` 字段；
// widget 只在 ready key 列表内显示具体 key。无 activePublicKeyHex 时不暴露
// "未选择"作为正常态文案（壳层会把这种情况识别为"修复/管理态"，这里是
// 内部瞬时或异常兜底）。

import { useState } from "react";
import { ChevronDown, KeyRound, Check } from "lucide-react";
import { router, useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import { Button, Modal, TextInput } from "@keymaster/ui";
import type { KeyIdentity, KeyspaceService, PasskeyProtection, VaultService } from "@keymaster/contracts";
import type { VaultKeyResourceState } from "./manifest.js";

export function KeySwitchWidget() {
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const vault = useCapability<VaultService>("vault.service");
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const keyState = useResourceSelector<VaultKeyResourceState, VaultKeyResourceState>(host.resourceStore, "vault.key-state", [], (s) => s.data ?? { keys: [], active: { activePublicKeyHex: undefined }, initializing: false, notice: null }, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const keys = keyState.keys;
  const active = keyState.active;
  const [open, setOpen] = useState(false);
  const initializing = keyState.initializing;
  const [busy, setBusy] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<KeyIdentity | null>(null);
  const [switchPassword, setSwitchPassword] = useState("");
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchPasskeys, setSwitchPasskeys] = useState<PasskeyProtection[]>([]);


  const current = active.activePublicKeyHex
    ? keys.find((k) => k.publicKeyHex === active.activePublicKeyHex)
    : undefined;

  function closeSwitchDialog() {
    if (switchBusy) return;
    setPendingSwitch(null);
    setSwitchPassword("");
    setSwitchError(null);
    setSwitchPasskeys([]);
  }

  async function pick(key: KeyIdentity) {
    if (busy || switchBusy) return;
    if (!key.publicKeyHex || key.publicKeyHex === active.activePublicKeyHex) {
      setOpen(false);
      return;
    }
    setPendingSwitch(key);
    setSwitchPassword("");
    setSwitchError(null);
    setSwitchPasskeys([]);
    if (typeof vault.listPasskeys === "function") {
      void vault.listPasskeys(key.publicKeyHex).then(setSwitchPasskeys).catch(() => undefined);
    }
  }

  async function submitSwitch() {
    if (!pendingSwitch?.publicKeyHex || switchBusy) return;
    setSwitchBusy(true);
    setSwitchError(null);
    try {
      const result = await vault.activateKey({
        publicKeyHex: pendingSwitch.publicKeyHex,
        password: switchPassword
      });
      if (result.status !== "accepted") {
        setSwitchError("message" in result ? result.message : result.status === "blocked" ? (typeof result.reason === "string" ? result.reason : result.reason.fallback) : `Failed to switch key: ${result.status}`);
        return;
      }
      setPendingSwitch(null);
      setSwitchPassword("");
      setSwitchError(null);
      setOpen(false);
    } catch (err) {
      setSwitchError(
        err instanceof Error
          ? err.message
          : t("vault.keySwitch.err.failed", { defaultValue: "Failed to switch key" })
      );
    } finally {
      setSwitchBusy(false);
    }
  }

  async function submitPasskeySwitch(passkeyId: string) {
    if (!pendingSwitch?.publicKeyHex || switchBusy) return;
    setSwitchBusy(true);
    setSwitchError(null);
    try {
      const result = await vault.activateKeyWithPasskey({
        publicKeyHex: pendingSwitch.publicKeyHex,
        passkeyId
      });
      if (result.status !== "accepted") {
        setSwitchError("message" in result ? result.message : `Failed to switch key: ${result.status}`);
        return;
      }
      setPendingSwitch(null);
      setSwitchPasskeys([]);
      setOpen(false);
    } catch (err) {
      setSwitchError(err instanceof Error ? err.message : "Passkey verification failed");
    } finally {
      setSwitchBusy(false);
    }
  }

  const unnamed = t("vault.keySwitch.unnamed", { defaultValue: "未命名" });

  return (
    <div className="key-switch">
      <button
        type="button"
        className="key-switch__button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("vault.keySwitch.label", { defaultValue: "切换 key" })}
        title={t("vault.keySwitch.label", { defaultValue: "切换 key" })}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
      >
        <KeyRound size={16} />
        {initializing ? (
          <span className="key-switch__label">{t("vault.keySwitch.initializing", { defaultValue: "初始化中" })}</span>
        ) : current && current.publicKeyHex ? (
          <>
            <span className="key-switch__label">{current.label || unnamed}</span>
            <span className="key-switch__pubkey">{formatShortPublicKey(current.publicKeyHex)}</span>
          </>
        ) : (
          <span className="key-switch__label">{t("vault.keySwitch.noReadyKey", { defaultValue: "无可切换 key" })}</span>
        )}
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="key-switch__panel" role="menu">
          {keys.map((k) => (
            <button
              type="button"
              key={k.publicKeyHex}
              className={`key-switch__item ${active.activePublicKeyHex === k.publicKeyHex ? "key-switch__active" : ""}`}
              onClick={() => pick(k)}
              disabled={busy || !k.publicKeyHex}
            >
              <span className="key-switch__item-label">
                <span>{k.label || unnamed}</span>
                {k.publicKeyHex ? (
                  <span className="key-switch__pubkey">{formatShortPublicKey(k.publicKeyHex)}</span>
                ) : null}
                <span className="key-switch__caps">{k.capabilities.join(", ")}</span>
              </span>
              {active.activePublicKeyHex === k.publicKeyHex ? <Check size={14} /> : null}
            </button>
          ))}
          {keys.length === 0 ? (
            <p className="key-switch__empty">{t("vault.keySwitch.empty", { defaultValue: "还没有 key，前往 导入 添加。" })}</p>
          ) : null}
          <hr className="key-switch__divider" />
          <button
            type="button"
            className="key-switch__item"
            onClick={() => {
              setOpen(false);
              router.push("/settings/vault");
            }}
          >
            {t("vault.keySwitch.manage", { defaultValue: "管理 key" })}
          </button>
        </div>
      ) : null}
      <Modal
        open={pendingSwitch !== null}
        title={t("vault.keySwitch.confirmTitle", { defaultValue: "Confirm switch" })}
        onClose={closeSwitchDialog}
        footer={
          <>
            <Button variant="ghost" onClick={closeSwitchDialog} disabled={switchBusy}>
              {t("common.action.cancel", { defaultValue: "Cancel" })}
            </Button>
            <Button onClick={submitSwitch} loading={switchBusy} disabled={!switchPassword}>
              {t("vault.keySwitch.confirm", { defaultValue: "Confirm" })}
            </Button>
          </>
        }
      >
        <p className="key-switch__confirm-hint">
          {t("vault.keySwitch.confirmHint", {
            defaultValue: "Enter the Vault password to unlock the selected key."
          })}
        </p>
        {pendingSwitch ? (
          <p className="key-switch__confirm-target">
            {pendingSwitch.label || unnamed}
            {" "}
            {pendingSwitch.publicKeyHex ? (
              <code>{formatShortPublicKey(pendingSwitch.publicKeyHex)}</code>
            ) : null}
          </p>
        ) : null}
        <TextInput
          label={t("vault.keySwitch.password", { defaultValue: "Password" })}
          type="password"
          autoComplete="current-password"
          value={switchPassword}
          onChange={(e) => setSwitchPassword(e.currentTarget.value)}
          error={switchError ?? undefined}
          autoFocus
        />
        {switchPasskeys.length ? (
          <div className="vault-activate-passkeys">
            <span>{t("vault.keySwitch.orPasskey", { defaultValue: "Or use a passkey" })}</span>
            {switchPasskeys.map((item) => (
              <Button
                key={item.id}
                variant="secondary"
                onClick={() => void submitPasskeySwitch(item.id)}
                disabled={switchBusy}
              >
                {item.label}
              </Button>
            ))}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
