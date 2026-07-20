// packages/plugin-apps/src/AppLaunchModal.tsx
// appView 启动授权 modal：选择目标 key + 输入 Vault 密码。
//
// 设计缘由：
//   - appView 启动不再隐式借用当前 active key；
//   - 由 launcher 显式选择要绑定的 key，并重新输入密码；
//   - modal 只收集输入，不直接调用 protocol service。

import { useEffect, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
import { Button, Modal, Select, TextInput } from "@keymaster/ui";
import { formatShortPublicKey, type KeyIdentity, type KeyspaceService } from "@keymaster/contracts";
import type { AppCatalogEntry } from "./catalog.js";

export interface AppLaunchModalProps {
  open: boolean;
  entry: AppCatalogEntry | null;
  busy?: boolean;
  error?: string | null;
  onClose(): void;
  onConfirm(input: { publicKeyHex: string; password: string }): Promise<void>;
}

export function AppLaunchModal({
  open,
  entry,
  busy = false,
  error = null,
  onClose,
  onConfirm
}: AppLaunchModalProps) {
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const { t } = useI18n();
  const [keys, setKeys] = useState<KeyIdentity[]>([]);
  const [selectedPublicKeyHex, setSelectedPublicKeyHex] = useState("");
  const [password, setPassword] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPassword("");
    setLoadError(null);
    void (async () => {
      try {
        const all = await keyspace.listKeys();
        if (cancelled) return;
        setKeys(all);
        const active = keyspace.active().activePublicKeyHex;
        const preferred = active && all.some((k) => k.publicKeyHex === active) ? active : all[0]?.publicKeyHex ?? "";
        setSelectedPublicKeyHex(preferred);
      } catch {
        if (!cancelled) {
          setKeys([]);
          setSelectedPublicKeyHex("");
          setLoadError(t("apps.launch.error.noKeys", { defaultValue: "No Vault key is available." }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keyspace, open, t]);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setLoadError(null);
    }
  }, [open]);

  async function submit() {
    if (!selectedPublicKeyHex || !password || !entry) return;
    await onConfirm({ publicKeyHex: selectedPublicKeyHex, password });
  }

  const options = keys.map((key) => ({
    value: key.publicKeyHex,
    label: `${key.label} (${formatShortPublicKey(key.publicKeyHex)})`
  }));

  return (
    <Modal
      open={open}
      title={
        entry
          ? t("apps.launch.title", {
              defaultValue: `Open ${entry.name}`
            })
          : t("apps.launch.titleFallback", { defaultValue: "Open App" })
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy} data-testid="app-launch-cancel">
            {t("common.action.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            onClick={() => void submit()}
            loading={busy}
            disabled={busy || !password || !selectedPublicKeyHex || keys.length === 0}
            data-testid="app-launch-confirm"
          >
            {t("apps.open.cta", { defaultValue: "Open App" })}
          </Button>
        </>
      }
      data-testid="app-launch-modal"
    >
      {entry ? (
        <div className="apps-launch-modal__meta">
          <div className="apps-launch-modal__name">{entry.name}</div>
          <div className="apps-launch-modal__origin">{entry.appOrigin}</div>
          {entry.summary ? <div className="apps-launch-modal__summary">{entry.summary}</div> : null}
        </div>
      ) : null}
      <Select
        label={t("apps.launch.key", { defaultValue: "Key" })}
        value={selectedPublicKeyHex}
        onChange={(e) => setSelectedPublicKeyHex(e.currentTarget.value)}
        options={options}
        hint={t("apps.launch.keyHint", {
          defaultValue: "Choose which Vault key this app session should bind to."
        })}
        error={loadError ?? undefined}
        disabled={busy || options.length === 0}
      />
      <TextInput
        label={t("apps.launch.password", { defaultValue: "Vault password" })}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.currentTarget.value)}
        error={error ?? undefined}
      />
      {loadError ? (
        <div className="apps-launch-modal__error">{loadError}</div>
      ) : null}
    </Modal>
  );
}
