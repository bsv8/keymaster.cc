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

import { useEffect, useState } from "react";
import { ChevronDown, KeyRound, Check } from "lucide-react";
import { useCapability, useResourceSelector } from "webloom-framework/react";
import { router, useI18n, usePluginHost } from "@keymaster/runtime";
import { KEYSPACE_SERVICE_CAPABILITY, VAULT_SERVICE_CAPABILITY, formatShortPublicKey, STORAGE_CATALOG_CHANGED_EVENT, type KeyIdentity } from "@keymaster/contracts";
import type { VaultKeyResourceState } from "./manifest.js";
import { VaultKeySwitchModal } from "./VaultKeySwitchModal.js";

export function KeySwitchWidget() {
  const keyspace = useCapability(KEYSPACE_SERVICE_CAPABILITY);
  const vault = useCapability(VAULT_SERVICE_CAPABILITY);
  const host = usePluginHost();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  const keyState = useResourceSelector<VaultKeyResourceState, VaultKeyResourceState>(host.resourceStore, "vault.key-state", [], (s) => s.data ?? { keys: [], active: { activePublicKeyHex: undefined }, initializing: false, notice: null }, (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const keys = keyState.keys;
  const active = keyState.active;
  const [open, setOpen] = useState(false);
  const initializing = keyState.initializing;
  const [pendingSwitch, setPendingSwitch] = useState<KeyIdentity | null>(null);
  const catalogMode = useResourceSelector<{ hasCatalogBuckets?: boolean }, boolean>(
    host.resourceStore,
    "storage.status",
    [],
    (snapshot) => snapshot.data?.hasCatalogBuckets === true
  );

  useEffect(() => {
    const refreshStorageStatus = () => host.resourceStore.invalidate("storage.status", []);
    window.addEventListener("storage", refreshStorageStatus);
    window.addEventListener(STORAGE_CATALOG_CHANGED_EVENT, refreshStorageStatus);
    return () => {
      window.removeEventListener("storage", refreshStorageStatus);
      window.removeEventListener(STORAGE_CATALOG_CHANGED_EVENT, refreshStorageStatus);
    };
  }, [host.resourceStore]);

  // 新版桶树拥有桶和 Key 的统一切换入口。没有新版目录时（例如旧 OPFS
  // 单桶模式）保留这个旧 Vault Key 菜单，避免破坏历史数据入口。
  if (catalogMode) return null;


  const current = active.activePublicKeyHex
    ? keys.find((k) => k.publicKeyHex === active.activePublicKeyHex)
    : undefined;

  function closeSwitchDialog() {
    setPendingSwitch(null);
  }

  function pick(key: KeyIdentity) {
    if (!key.publicKeyHex || key.publicKeyHex === active.activePublicKeyHex) {
      setOpen(false);
      return;
    }
    setPendingSwitch(key);
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
              disabled={!k.publicKeyHex}
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
      <VaultKeySwitchModal
        target={pendingSwitch}
        vault={vault}
        onClose={closeSwitchDialog}
        onActivated={() => {
          setPendingSwitch(null);
          setOpen(false);
        }}
      />
    </div>
  );
}
