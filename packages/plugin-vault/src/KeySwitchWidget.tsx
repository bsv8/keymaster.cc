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
          (k) => k.identityStatus === "ready" && k.publicKeyHex
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
            (k) => k.identityStatus === "ready" && k.publicKeyHex
          );
          setKeys(switchable);
        } catch {
          // 静默
        }
      })();
    };
    offs.push(messageBus.subscribe<{ keyId: string; publicKeyHex: string; label: string }>("key.created", trigger));
    offs.push(messageBus.subscribe<{ publicKeyHex: string; keyId?: string }>("key.deleted", trigger));
    offs.push(messageBus.subscribe<{ keyId: string; publicKeyHex: string }>("key.identity.ready", trigger));
    offs.push(messageBus.subscribe<{ keyId: string; label?: string; error: string }>("key.identity.failed", trigger));
    return () => {
      for (const off of offs) off();
    };
  }, [messageBus, keyspace]);

  const current = active.activePublicKeyHex
    ? keys.find((k) => k.publicKeyHex === active.activePublicKeyHex)
    : undefined;

  async function pick(hex: string) {
    if (busy) return;
    setBusy(true);
    try {
      await keyspace.setActive(hex);
      setOpen(false);
    } catch (err) {
      console.error("Failed to switch key", err);
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
              onClick={() => k.publicKeyHex && pick(k.publicKeyHex)}
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
              {active.activePublicKeyHex === k.publicKeyHex ? <Check size={14} /> : null}
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
