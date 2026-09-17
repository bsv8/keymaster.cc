import { useState, type FormEvent } from "react";
import type { StorageRuntimeController } from "@keymaster/contracts";
import { STORAGE_RUNTIME_CONTROLLER_CAPABILITY } from "@keymaster/contracts";
import { Button, PageHeader, TextInput } from "@keymaster/ui";
import { useI18n } from "@keymaster/runtime";
import { useOptionalCapability } from "webloom-framework/react";
import { createDeviceRecordRepository, defaultDeviceStorage, readSession } from "@keymaster/platform-storage/coordinator";
import { OnboardingShell } from "./OnboardingShell.js";

interface StorageAuthenticationTarget {
  /** 本机设备引导记录中的显示名称，不是远端秘密。 */
  readonly label: string;
  /** 本机设备引导记录中的 Provider 类型。 */
  readonly provider: "local" | "s3";
}

/** 读取已有选中桶的非敏感展示字段；读取失败时仍保持认证页。 */
function readAuthenticationTarget(): StorageAuthenticationTarget | undefined {
  try {
    const storage = defaultDeviceStorage();
    const session = readSession(storage);
    if (!session?.activeBucketId) return undefined;
    const record = createDeviceRecordRepository(storage).read(session.activeBucketId);
    if (!record) return undefined;
    return { label: record.displayName ?? session.activeBucketId, provider: record.location.providerId };
  } catch {
    // 认证页不能因展示摘要失败而退回首次初始化；密码认证仍由 Worker 判定。
    return undefined;
  }
}

function isUnlockFailure(value: unknown): value is { ok: false } {
  return Boolean(value && typeof value === "object" && "ok" in value && value.ok === false);
}

/**
 * 已有设备引导桶的冷启动认证页。
 *
 * 这条路径只接收本次输入的密码并调用 Coordinator 的 unlockBucket；页面
 * 不创建桶、不创建 Vault，也不直接安装 Storage Root。认证成功后的 Root、
 * Vault metadata 和 active Key 恢复由 Worker 与启动装配状态机继续完成。
 */
export function StorageAuthenticationPage() {
  const { t } = useI18n();
  const storage = useOptionalCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const target = readAuthenticationTarget();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!password || busy || submitted) return;
    const controller = storage as StorageRuntimeController | undefined;
    if (!controller?.unlockBucket) {
      setError(t("shell.storageAuthentication.unavailable", { defaultValue: "存储认证服务暂不可用，请稍后重试。" }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await controller.unlockBucket(password);
      if (isUnlockFailure(result)) {
        setError(t("shell.storageAuthentication.failed", { defaultValue: "密码错误或存储认证失败，请重试。" }));
        return;
      }
      // unlock-bucket 成功后由 storage.status=ready 触发后续 Vault 装配；
      // 页面不自行 router.push，避免在 Root 尚未恢复时越过安全门禁。
      setSubmitted(true);
    } catch {
      setError(t("shell.storageAuthentication.failed", { defaultValue: "密码错误或存储认证失败，请重试。" }));
    } finally {
      setBusy(false);
      // 密码只在本次 Worker 调用期间存在，响应后立即清除页面副本。
      setPassword("");
    }
  }

  return (
    <OnboardingShell width="narrow">
      <div className="storage-authentication" data-testid="storage-authentication">
        <PageHeader
          title={t("shell.storageAuthentication.title", { defaultValue: "存储需要认证" })}
          description={t("shell.storageAuthentication.description", { defaultValue: "此浏览器已有选中的存储桶。请输入桶密码以恢复钱包；不会重新初始化或覆盖已有数据。" })}
        />
        <dl className="storage-authentication__target">
          <dt>{t("shell.storageAuthentication.bucketName", { defaultValue: "桶名称" })}</dt>
          <dd>{target?.label ?? t("shell.storageAuthentication.unknownBucket", { defaultValue: "已保存的存储桶" })}</dd>
          <dt>{t("shell.storageAuthentication.provider", { defaultValue: "Provider" })}</dt>
          <dd>{target?.provider === "s3" ? "S3" : "Local"}</dd>
        </dl>
        <form className="storage-authentication__form" onSubmit={(event) => { void unlock(event); }}>
          <TextInput
            type="password"
            label={t("shell.storageAuthentication.password", { defaultValue: "密码" })}
            value={password}
            onChange={(event) => { setPassword(event.currentTarget.value); setError(null); setSubmitted(false); }}
            autoComplete="current-password"
            disabled={busy || submitted}
            autoFocus
          />
          <Button type="submit" loading={busy} disabled={!password || submitted}>
            {t("shell.storageAuthentication.unlock", { defaultValue: "解锁" })}
          </Button>
        </form>
        <p className="storage-authentication__hint">
          {t("shell.storageAuthentication.passwordHint", { defaultValue: "密码只用于本次认证，不会保存到浏览器目录。认证成功后将继续恢复原来的钱包。" })}
        </p>
        {submitted ? (
          <p className="storage-authentication__status" role="status" aria-live="polite">
            {t("shell.storageAuthentication.restoring", { defaultValue: "认证成功，正在恢复钱包…" })}
          </p>
        ) : null}
        {error ? <p className="storage-authentication__error" role="alert">{error}</p> : null}
      </div>
    </OnboardingShell>
  );
}
