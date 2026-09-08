import type { StorageBucketConnectionConfigV1, StorageBucketProvider } from "@keymaster/contracts";
import { useI18n } from "@keymaster/runtime";
import { createLocalStorageBucketProvider } from "../bucket-providers/local/localStorageBucketProvider.js";
import { createS3BucketProvider } from "../bucket-providers/s3/s3BucketProvider.js";

/** 用户可选择的桶后端。 */
export type BucketBackend = "local" | "s3";

/** 桶编辑草稿。密码仅允许存在于当前 React 页面内存。 */
export interface BucketDraft {
  editingBucketId?: string;
  label: string;
  backend: BucketBackend;
  password: string;
  passwordConfirm: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  prefix: string;
  forcePathStyle: boolean;
}

export const EMPTY_BUCKET_DRAFT: BucketDraft = {
  label: "",
  backend: "local",
  password: "",
  passwordConfirm: "",
  endpoint: "",
  region: "",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  prefix: "",
  forcePathStyle: false
};

export function bucketDraftFingerprint(draft: BucketDraft): string {
  return JSON.stringify(draft);
}

export function connectionFromBucketDraft(draft: BucketDraft): StorageBucketConnectionConfigV1 {
  if (draft.backend === "local") return { kind: "local" };
  return {
    kind: "s3",
    endpoint: draft.endpoint.trim(),
    region: draft.region.trim(),
    bucket: draft.bucket.trim(),
    accessKeyId: draft.accessKeyId,
    secretAccessKey: draft.secretAccessKey,
    ...(draft.sessionToken ? { sessionToken: draft.sessionToken } : {}),
    ...(draft.prefix.trim() ? { prefix: draft.prefix.trim() } : {}),
    ...(draft.forcePathStyle ? { forcePathStyle: true } : {})
  };
}

export function createBucketProvider(config: StorageBucketConnectionConfigV1, bucketId: string): StorageBucketProvider {
  if (config.kind === "local") return createLocalStorageBucketProvider({ bucketId });
  return createS3BucketProvider({
    version: 1,
    providerId: "s3-compatible",
    connection: {
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      forcePathStyle: config.forcePathStyle === true,
      ...(config.sessionToken === undefined ? {} : { sessionToken: config.sessionToken }),
      ...(config.prefix === undefined ? {} : { prefix: config.prefix })
    },
    credentials: {
      kind: "access-key",
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  }, { bucketId });
}

export interface BucketConnectionFieldsProps {
  draft: BucketDraft;
  onChange<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]): void;
  /** 初始设置按步骤拆字段；管理弹窗使用 all。 */
  section?: "type" | "parameters" | "password" | "all";
  lockBackend?: boolean;
}

/** 桶管理和初始设置共享的无状态字段；两张页面不共享流程判断。 */
export function BucketConnectionFields({ draft, onChange, section = "all", lockBackend = false }: BucketConnectionFieldsProps) {
  const { t } = useI18n();
  const showType = section === "type" || section === "all";
  const showParameters = section === "parameters" || section === "all";
  const showPassword = section === "password" || section === "all";
  return (
    <div className="bucket-connection-fields">
      {showType ? (
        <label><span>{t("storage.bucketFields.type", { defaultValue: "桶类型" })}</span><select value={draft.backend} disabled={lockBackend} onChange={(event) => onChange("backend", event.currentTarget.value as BucketBackend)}><option value="local">{t("storage.bucketFields.local", { defaultValue: "Local（浏览器本地存储）" })}</option><option value="s3">{t("storage.bucketFields.s3", { defaultValue: "S3-compatible（兼容 S3 的对象存储）" })}</option></select></label>
      ) : null}
      {showParameters ? <>
        <label><span>{t("storage.bucketFields.label", { defaultValue: "桶名称（本机显示名称）" })}</span><input value={draft.label} onChange={(event) => onChange("label", event.currentTarget.value)} placeholder={t("storage.bucketFields.labelPlaceholder", { defaultValue: "例如：工作空间" })} /></label>
        {draft.backend === "s3" ? <>
          <label className="is-wide"><span>{t("storage.bucketFields.endpoint", { defaultValue: "Endpoint（HTTPS 服务地址）" })}</span><input value={draft.endpoint} onChange={(event) => onChange("endpoint", event.currentTarget.value)} placeholder="https://s3.example.com" /></label>
          <label><span>{t("storage.bucketFields.region", { defaultValue: "Region（存储区域）" })}</span><input value={draft.region} onChange={(event) => onChange("region", event.currentTarget.value)} placeholder="auto" /></label>
          <label><span>{t("storage.bucketFields.bucket", { defaultValue: "Bucket（物理桶名称）" })}</span><input value={draft.bucket} onChange={(event) => onChange("bucket", event.currentTarget.value)} /></label>
          <label><span>{t("storage.bucketFields.accessKey", { defaultValue: "Access Key ID（访问身份）" })}</span><input value={draft.accessKeyId} onChange={(event) => onChange("accessKeyId", event.currentTarget.value)} /></label>
          <label><span>{t("storage.bucketFields.secretKey", { defaultValue: "Secret Access Key（访问密钥）" })}</span><input type="password" autoComplete="off" value={draft.secretAccessKey} onChange={(event) => onChange("secretAccessKey", event.currentTarget.value)} /></label>
          <label><span>{t("storage.bucketFields.sessionToken", { defaultValue: "Session Token（临时会话令牌，可选）" })}</span><input type="password" autoComplete="off" value={draft.sessionToken} onChange={(event) => onChange("sessionToken", event.currentTarget.value)} /></label>
          <label><span>{t("storage.bucketFields.prefix", { defaultValue: "Prefix（对象路径前缀，可选）" })}</span><input value={draft.prefix} onChange={(event) => onChange("prefix", event.currentTarget.value)} placeholder={t("storage.bucketFields.prefixPlaceholder", { defaultValue: "例如：team-a/" })} /></label>
          <label className="bucket-connection-fields__checkbox"><input type="checkbox" checked={draft.forcePathStyle} onChange={(event) => onChange("forcePathStyle", event.currentTarget.checked)} /><span>{t("storage.bucketFields.forcePathStyle", { defaultValue: "Force Path Style（强制路径风格请求）" })}</span></label>
        </> : <p className="bucket-connection-fields__note is-wide">{t("storage.bucketFields.localNote", { defaultValue: "Local 桶保存在当前浏览器中，适合单设备使用；不会同步到其他设备。" })}</p>}
      </> : null}
      {showPassword ? <>
        <label><span>{draft.editingBucketId ? t("storage.bucketFields.currentPassword", { defaultValue: "当前桶密码（已验证）" }) : t("storage.bucketFields.password", { defaultValue: "密码（至少 8 位）" })}</span><input type="password" autoComplete={draft.editingBucketId ? "current-password" : "new-password"} value={draft.password} readOnly={Boolean(draft.editingBucketId)} onChange={(event) => onChange("password", event.currentTarget.value)} /></label>
        <label><span>{t("storage.bucketFields.passwordConfirm", { defaultValue: "确认密码" })}</span><input type="password" autoComplete="new-password" value={draft.passwordConfirm} readOnly={Boolean(draft.editingBucketId)} onChange={(event) => onChange("passwordConfirm", event.currentTarget.value)} /></label>
      </> : null}
    </div>
  );
}
