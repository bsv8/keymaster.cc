// packages/plugin-vault/src/KeySwitchWidget.tsx
// 顶栏 key switch widget。
// 设计缘由：
//   - 顶栏在 order 90 注册，位于 background.tray (order 100) 左侧。
//   - 内部通过 keyspace.service 维护 active key；不直接持有 active key 状态。
//   - 单 key 模式显示 label + 短公钥（publicKeyHex 截断）；all 模式显示"全部 key"。
//   - 切换 key 时调用 keyspace.setActive；菜单顶部有"全部 key"切换项。
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

import { useEffect, useState } from "react";
import { ChevronDown, KeyRound, Check, AlertTriangle } from "lucide-react";
import { router, useCapability, useI18n } from "@keymaster/runtime";
import { formatShortPublicKey } from "@keymaster/contracts";
import type { ActiveKeyState, KeyIdentity, KeyspaceService, MessageBus } from "@keymaster/contracts";

export function KeySwitchWidget() {
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const messageBus = useCapability<MessageBus>("runtime.messageBus");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();
  const [keys, setKeys] = useState<KeyIdentity[]>([]);
  const [active, setActive] = useState<ActiveKeyState>(keyspace.active());
  const [open, setOpen] = useState(false);
  const [initializing, setInitializing] = useState(keyspace.isInitializing());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadSwitchableKeys() {
      try {
        const all = await keyspace.listKeys();
        const switchable = all.filter(
          (k) => k.identityStatus === "ready" && k.publicKeyHash && k.publicKeyHex
        );
        if (!cancelled) setKeys(switchable);
      } catch {
        if (!cancelled) setKeys([]);
      }
    }
    void loadSwitchableKeys();
    const offActive = keyspace.onActiveChange((s) => {
      if (!cancelled) {
        setActive(s);
        void loadSwitchableKeys();
      }
    });
    const offInit = keyspace.onInitializationChange((v) => {
      if (!cancelled) {
        setInitializing(v);
        if (!v) void loadSwitchableKeys();
      }
    });
    return () => {
      cancelled = true;
      offActive();
      offInit();
    };
  }, [keyspace]);

  useEffect(() => {
    if (!messageBus) return;
    const offs: Array<() => void> = [];
    const trigger = () => {
      void (async () => {
        try {
          const all = await keyspace.listKeys();
          const switchable = all.filter(
            (k) => k.identityStatus === "ready" && k.publicKeyHash && k.publicKeyHex
          );
          setKeys(switchable);
        } catch {
          // 静默
        }
      })();
    };
    offs.push(messageBus.subscribe<{ keyId: string; publicKeyHash: string; label: string }>("key.created", trigger));
    offs.push(messageBus.subscribe<{ publicKeyHash: string; keyId?: string }>("key.deleted", trigger));
    offs.push(messageBus.subscribe<{ keyId: string; publicKeyHash: string }>("key.identity.ready", trigger));
    offs.push(messageBus.subscribe<{ keyId: string; label?: string; error: string }>("key.identity.failed", trigger));
    return () => {
      for (const off of offs) off();
    };
  }, [messageBus, keyspace]);

  const current = active.mode === "single" && active.activePublicKeyHash
    ? keys.find((k) => k.publicKeyHash === active.activePublicKeyHash)
    : undefined;

  async function pick(hash: string) {
    if (busy) return;
    setBusy(true);
    try {
      await keyspace.setActive(hash);
      setOpen(false);
    } catch (err) {
      console.error("Failed to switch key", err);
    } finally {
      setBusy(false);
    }
  }

  async function pickAll() {
    if (busy) return;
    setBusy(true);
    try {
      await keyspace.setAll();
      setOpen(false);
    } catch (err) {
      console.error("Failed to enter all mode", err);
    } finally {
      setBusy(false);
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
        disabled={busy}
      >
        <KeyRound size={16} />
        {initializing ? (
          <span className="key-switch__label">{t("vault.keySwitch.initializing", { defaultValue: "初始化中" })}</span>
        ) : keys.length === 0 ? (
          <span className="key-switch__label">{t("vault.keySwitch.noKey", { defaultValue: "无 key" })}</span>
        ) : active.mode === "all" ? (
          <span className="key-switch__label">{t("vault.keySwitch.allKey", { defaultValue: "全部 key" })}</span>
        ) : current && current.publicKeyHex ? (
          <>
            <span className="key-switch__label">{current.label || unnamed}</span>
            <span className="key-switch__pubkey">{formatShortPublicKey(current.publicKeyHex)}</span>
          </>
        ) : (
          <span className="key-switch__label">{t("vault.keySwitch.unselected", { defaultValue: "未选择" })}</span>
        )}
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="key-switch__panel" role="menu">
          <button
            type="button"
            className={`key-switch__item ${active.mode === "all" ? "key-switch__active" : ""}`}
            onClick={pickAll}
            disabled={busy}
          >
            <span className="key-switch__item-label">{t("vault.keySwitch.allKeyDesc", { defaultValue: "全部 key（只读总览）" })}</span>
            {active.mode === "all" ? <Check size={14} /> : null}
          </button>
          <hr className="key-switch__divider" />
          {keys.map((k) => (
            <button
              type="button"
              key={k.publicKeyHash}
              className={`key-switch__item ${active.activePublicKeyHash === k.publicKeyHash ? "key-switch__active" : ""}`}
              onClick={() => k.publicKeyHash && pick(k.publicKeyHash)}
              disabled={busy || k.identityStatus !== "ready" || !k.publicKeyHex}
              title={k.identityStatus !== "ready" ? t("vault.keySwitch.notReady", { defaultValue: "身份尚未就绪" }) : undefined}
            >
              <span className="key-switch__item-label">
                <span>{k.label || unnamed}</span>
                {k.publicKeyHex ? (
                  <span className="key-switch__pubkey">{formatShortPublicKey(k.publicKeyHex)}</span>
                ) : null}
                <span className="key-switch__caps">{k.capabilities.join(", ")}</span>
              </span>
              {active.activePublicKeyHash === k.publicKeyHash ? <Check size={14} /> : null}
              {k.identityStatus !== "ready" ? <AlertTriangle size={14} /> : null}
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
    </div>
  );
}
