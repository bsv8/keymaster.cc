// packages/plugin-settings/src/StorageSettingsPage.tsx
// 全局 storage provider 设置页（施工单 2026-06-29 001 硬切换）。
//
// 设计缘由：
//   - V1 只支持一套全局 S3-compatible 配置；不做多 profile。
//   - 配置写 IndexedDB `storageProviderConfig` store；密钥字段
//     `secretAccessKey` 同样写 IndexedDB（与 vault DB 同 lifecycle）。
//   - 写入字段校验：endpoint / region / bucket / accessKeyId / secretAccessKey
//     必须非空；非法配置在保存路径直接拒绝。
//   - 不暴露给 client app：本页是 Keymaster 系统设置，路径 `/settings/storage`。
//   - `forcePathStyle` 是可选；缺省 false。

import { useEffect, useState } from "react";
import { useI18n } from "@keymaster/runtime";
import { PROTOCOL_SERVICE_CAPABILITY, type ProtocolService, type StorageProviderConfig } from "@keymaster/contracts";
import { useCapability } from "@keymaster/runtime";

interface FormState {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const EMPTY_FORM: FormState = {
  endpoint: "",
  region: "",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  forcePathStyle: true
};

function validate(form: FormState): { ok: true } | { ok: false; reason: string } {
  if (!form.endpoint.trim()) return { ok: false, reason: "endpoint required" };
  if (!form.region.trim()) return { ok: false, reason: "region required" };
  if (!form.bucket.trim()) return { ok: false, reason: "bucket required" };
  if (!form.accessKeyId.trim()) return { ok: false, reason: "accessKeyId required" };
  if (!form.secretAccessKey.trim()) return { ok: false, reason: "secretAccessKey required" };
  return { ok: true };
}

export function StorageSettingsPage() {
  const service = useCapability<ProtocolService>(PROTOCOL_SERVICE_CAPABILITY);
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasConfig, setHasConfig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!service) return;
      try {
        const cfg = await service.getStorageProviderConfig();
        if (cancelled) return;
        if (cfg) {
          setForm({
            endpoint: cfg.endpoint,
            region: cfg.region,
            bucket: cfg.bucket,
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
            forcePathStyle: cfg.forcePathStyle ?? false
          });
          setHasConfig(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service]);

  if (!service) {
    return <div className="settings-page__error">protocol service not available</div>;
  }

  async function handleSave() {
    setError(null);
    const check = validate(form);
    if (!check.ok) {
      setError(check.reason);
      return;
    }
    setSaving(true);
    try {
      const record: StorageProviderConfig = {
        provider: "s3-compatible",
        endpoint: form.endpoint.trim(),
        region: form.region.trim(),
        bucket: form.bucket.trim(),
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey.trim(),
        forcePathStyle: form.forcePathStyle,
        updatedAt: Date.now()
      };
      await service.setStorageProviderConfig(record);
      setHasConfig(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setError(null);
    setSaving(true);
    try {
      await service.clearStorageProviderConfig();
      setForm(EMPTY_FORM);
      setHasConfig(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-page settings-page--storage" data-testid="storage-settings">
      <h2>{t("storageSettings.title", { defaultValue: "Storage" })}</h2>
      <p>
        {t("storageSettings.description", {
          defaultValue:
            "Configure an S3-compatible storage provider. Keymaster uses this to store app data (storage.*). The configuration is local-only and never shared with apps."
        })}
      </p>
      {loading ? (
        <p>{t("common.status.loading", { defaultValue: "Loading…" })}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
        >
          <label>
            <span>{t("storageSettings.field.endpoint", { defaultValue: "Endpoint" })}</span>
            <input
              type="text"
              data-testid="storage-endpoint"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              placeholder="https://s3.amazonaws.com"
            />
          </label>
          <label>
            <span>{t("storageSettings.field.region", { defaultValue: "Region" })}</span>
            <input
              type="text"
              data-testid="storage-region"
              value={form.region}
              onChange={(e) => setForm({ ...form, region: e.target.value })}
              placeholder="us-east-1"
            />
          </label>
          <label>
            <span>{t("storageSettings.field.bucket", { defaultValue: "Bucket" })}</span>
            <input
              type="text"
              data-testid="storage-bucket"
              value={form.bucket}
              onChange={(e) => setForm({ ...form, bucket: e.target.value })}
            />
          </label>
          <label>
            <span>{t("storageSettings.field.accessKeyId", { defaultValue: "Access key id" })}</span>
            <input
              type="text"
              data-testid="storage-access-key-id"
              value={form.accessKeyId}
              onChange={(e) => setForm({ ...form, accessKeyId: e.target.value })}
            />
          </label>
          <label>
            <span>{t("storageSettings.field.secretAccessKey", { defaultValue: "Secret access key" })}</span>
            <input
              type="password"
              data-testid="storage-secret-access-key"
              value={form.secretAccessKey}
              onChange={(e) => setForm({ ...form, secretAccessKey: e.target.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              data-testid="storage-force-path-style"
              checked={form.forcePathStyle}
              onChange={(e) => setForm({ ...form, forcePathStyle: e.target.checked })}
            />
            <span>
              {t("storageSettings.field.forcePathStyle", {
                defaultValue: "Force path-style addressing (recommended for self-hosted)"
              })}
            </span>
          </label>
          {error ? (
            <p className="settings-page__error" data-testid="storage-error">
              {error}
            </p>
          ) : null}
          <div className="settings-page__actions">
            <button type="submit" disabled={saving} data-testid="storage-save">
              {saving
                ? t("common.status.saving", { defaultValue: "Saving…" })
                : t("common.actions.save", { defaultValue: "Save" })}
            </button>
            {hasConfig ? (
              <button
                type="button"
                disabled={saving}
                onClick={() => void handleClear()}
                data-testid="storage-clear"
              >
                {t("storageSettings.action.clear", { defaultValue: "Clear" })}
              </button>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}