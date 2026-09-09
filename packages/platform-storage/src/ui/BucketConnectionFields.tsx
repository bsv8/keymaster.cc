import { useI18n } from "@keymaster/runtime";
import { awsS3EndpointForRegion, r2EndpointForAccount, R2_ENDPOINT_VARIANTS } from "../bucket-providers/s3/s3ClientFactory.js";
import {
  bucketDraftFingerprint,
  connectionFromBucketDraft,
  createBucketProvider,
  EMPTY_BUCKET_DRAFT,
  S3_CONFIG_MODES,
  updateBucketDraft,
  validateBucketDraft,
  type BucketBackend,
  type BucketDraft,
  type BucketDraftValidationCode,
  type S3ConfigMode
} from "./bucketConnectionDraft.js";

export {
  bucketDraftFingerprint,
  connectionFromBucketDraft,
  createBucketProvider,
  EMPTY_BUCKET_DRAFT,
  S3_CONFIG_MODES,
  updateBucketDraft,
  validateBucketDraft
};
export type { BucketBackend, BucketDraft, BucketDraftValidationCode, S3ConfigMode };

export interface BucketConnectionFieldsProps {
  draft: BucketDraft;
  onChange<K extends keyof BucketDraft>(key: K, value: BucketDraft[K]): void;
  /** 初始设置按步骤拆字段；管理弹窗使用 all。 */
  section?: "type" | "parameters" | "password" | "all";
  lockBackend?: boolean;
}

function generatedEndpoint(draft: BucketDraft): string | undefined {
  if (draft.backend !== "s3") return undefined;
  try {
    if (draft.s3ConfigMode === "aws-s3") return awsS3EndpointForRegion(draft.region);
    if (draft.s3ConfigMode === "cloudflare-r2") return r2EndpointForAccount(draft.accountId, draft.endpointVariant);
  } catch {
    // 输入未完整时不显示误导性的地址；提交校验会给出中文错误。
  }
  return undefined;
}

function r2EndpointVariantTranslation(variant: BucketDraft["endpointVariant"]): { key: string; defaultValue: string } {
  if (variant === "default") return { key: "storage.bucketFields.r2Default", defaultValue: "Default（默认）" };
  if (variant === "eu") return { key: "storage.bucketFields.r2Eu", defaultValue: "EU（欧洲）" };
  if (variant === "us") return { key: "storage.bucketFields.r2Us", defaultValue: "US（美国）" };
  return { key: "storage.bucketFields.r2Fedramp", defaultValue: "FedRAMP（合规端点）" };
}

/** 桶管理和初始设置共享的无状态字段；流程判断仍由各自页面负责。 */
export function BucketConnectionFields({ draft, onChange, section = "all", lockBackend = false }: BucketConnectionFieldsProps) {
  const { t } = useI18n();
  const showType = section === "type" || section === "all";
  const showParameters = section === "parameters" || section === "all";
  const showPassword = section === "password" || section === "all";
  const endpoint = generatedEndpoint(draft);
  const update = <K extends keyof BucketDraft>(key: K, value: BucketDraft[K]) => onChange(key, value);
  const mode = draft.s3ConfigMode;

  return (
    <div className="bucket-connection-fields">
      {showType ? (
        <label>
          <span>{t("storage.bucketFields.type", { defaultValue: "桶类型（存储后端）" })}</span>
          <select value={draft.backend} disabled={lockBackend} onChange={(event) => update("backend", event.currentTarget.value as BucketBackend)}>
            <option value="local">{t("storage.bucketFields.local", { defaultValue: "Local（浏览器本地存储）" })}</option>
            <option value="s3">{t("storage.bucketFields.s3", { defaultValue: "S3（兼容 S3 的对象存储）" })}</option>
          </select>
        </label>
      ) : null}
      {showParameters ? <>
        <label className="is-wide">
          <span>{t("storage.bucketFields.label", { defaultValue: "桶名称（本机显示名称）" })}</span>
          <input value={draft.label} onChange={(event) => update("label", event.currentTarget.value)} placeholder={t("storage.bucketFields.labelPlaceholder", { defaultValue: "例如：工作空间" })} />
        </label>
        {draft.backend === "s3" ? <>
          <label className="is-wide">
            <span>{t("storage.bucketFields.s3Mode", { defaultValue: "配置方式（S3 连接模板）" })}</span>
            <select value={mode} onChange={(event) => update("s3ConfigMode", event.currentTarget.value as S3ConfigMode)}>
              <option value="aws-s3">{t("storage.bucketFields.awsS3", { defaultValue: "AWS S3（亚马逊对象存储）" })}</option>
              <option value="cloudflare-r2">{t("storage.bucketFields.cloudflareR2", { defaultValue: "Cloudflare R2（Cloudflare 对象存储）" })}</option>
              <option value="s3-compatible">{t("storage.bucketFields.s3Compatible", { defaultValue: "普通 S3-compatible（其他兼容服务）" })}</option>
            </select>
          </label>

          {mode === "aws-s3" ? <>
            <label>
              <span>{t("storage.bucketFields.region", { defaultValue: "Region（AWS 区域）" })}</span>
              <input value={draft.region} onChange={(event) => update("region", event.currentTarget.value)} placeholder="us-east-1" />
            </label>
            <p className="bucket-connection-fields__note is-wide">
              {t("storage.bucketFields.awsEndpointNote", { defaultValue: "Endpoint（自动生成）" })}：<code>{endpoint ?? "填写受支持的 AWS Region 后生成"}</code>；{t("storage.bucketFields.virtualHostNote", { defaultValue: "请求风格固定为虚拟主机，Force Path Style=false。" })}
            </p>
          </> : null}

          {mode === "cloudflare-r2" ? <>
            <label className="is-wide">
              <span>{t("storage.bucketFields.accountId", { defaultValue: "Account ID（Cloudflare 账户 ID）" })}</span>
              <input value={draft.accountId} onChange={(event) => update("accountId", event.currentTarget.value)} placeholder="32 位十六进制字符串" autoComplete="off" />
            </label>
            <label>
              <span>{t("storage.bucketFields.endpointVariant", { defaultValue: "Endpoint Variant（R2 端点类型）" })}</span>
              <select value={draft.endpointVariant} onChange={(event) => update("endpointVariant", event.currentTarget.value as BucketDraft["endpointVariant"])}>
                {R2_ENDPOINT_VARIANTS.map((variant) => {
                  const translation = r2EndpointVariantTranslation(variant);
                  return <option key={variant} value={variant}>{t(translation.key, { defaultValue: translation.defaultValue })}</option>;
                })}
              </select>
            </label>
            <p className="bucket-connection-fields__note is-wide">
              {t("storage.bucketFields.r2EndpointNote", { defaultValue: "Endpoint（自动生成）" })}：<code>{endpoint ?? "填写合法 Account ID 后生成"}</code>；Region 固定为 <code>auto</code>，{t("storage.bucketFields.virtualHostNote", { defaultValue: "请求风格固定为虚拟主机，Force Path Style=false。" })}
            </p>
          </> : null}

          {mode === "s3-compatible" ? <>
            <label className="is-wide">
              <span>{t("storage.bucketFields.endpoint", { defaultValue: "Endpoint（HTTPS 服务地址）" })}</span>
              <input type="url" value={draft.endpoint} onChange={(event) => update("endpoint", event.currentTarget.value)} placeholder="https://s3.example.com" autoComplete="url" />
            </label>
            <label>
              <span>{t("storage.bucketFields.region", { defaultValue: "Region（S3 签名区域）" })}</span>
              <input value={draft.region} onChange={(event) => update("region", event.currentTarget.value)} placeholder="us-east-1 或 auto" />
            </label>
          </> : null}

          <label>
            <span>{t("storage.bucketFields.bucket", { defaultValue: "Bucket（物理桶名称）" })}</span>
            <input value={draft.bucket} onChange={(event) => update("bucket", event.currentTarget.value)} autoComplete="off" />
          </label>
          <label>
            <span>{t("storage.bucketFields.accessKey", { defaultValue: "Access Key ID（访问身份）" })}</span>
            <input value={draft.accessKeyId} onChange={(event) => update("accessKeyId", event.currentTarget.value)} autoComplete="off" />
          </label>
          <label>
            <span>{t("storage.bucketFields.secretKey", { defaultValue: "Secret Access Key（访问密钥）" })}</span>
            <input type="password" autoComplete="off" value={draft.secretAccessKey} onChange={(event) => update("secretAccessKey", event.currentTarget.value)} />
          </label>
          <label>
            <span>{t("storage.bucketFields.sessionToken", { defaultValue: "Session Token（临时会话令牌，可选）" })}</span>
            <input type="password" autoComplete="off" value={draft.sessionToken} onChange={(event) => update("sessionToken", event.currentTarget.value)} />
          </label>
          <label>
            <span>{t("storage.bucketFields.prefix", { defaultValue: "Prefix（对象路径前缀，可选）" })}</span>
            <input value={draft.prefix} onChange={(event) => update("prefix", event.currentTarget.value)} placeholder={t("storage.bucketFields.prefixPlaceholder", { defaultValue: "例如：team-a/" })} autoComplete="off" />
          </label>
          {mode === "s3-compatible" ? <label className="bucket-connection-fields__checkbox">
            <input type="checkbox" checked={draft.forcePathStyle} onChange={(event) => update("forcePathStyle", event.currentTarget.checked)} />
            <span>{t("storage.bucketFields.forcePathStyle", { defaultValue: "Force Path Style（强制路径风格请求）" })}</span>
          </label> : null}
        </> : <p className="bucket-connection-fields__note is-wide">{t("storage.bucketFields.localNote", { defaultValue: "Local 桶保存在当前浏览器中，适合单设备使用；不会同步到其他设备。" })}</p>}
      </> : null}
      {showPassword ? <>
        <label>
          <span>{draft.editingBucketId ? t("storage.bucketFields.currentPassword", { defaultValue: "当前桶密码（已验证）" }) : t("storage.bucketFields.password", { defaultValue: "密码（至少 8 位）" })}</span>
          <input type="password" autoComplete={draft.editingBucketId ? "current-password" : "new-password"} value={draft.password} readOnly={Boolean(draft.editingBucketId)} onChange={(event) => update("password", event.currentTarget.value)} />
        </label>
        <label>
          <span>{t("storage.bucketFields.passwordConfirm", { defaultValue: "确认密码" })}</span>
          <input type="password" autoComplete="new-password" value={draft.passwordConfirm} readOnly={Boolean(draft.editingBucketId)} onChange={(event) => update("passwordConfirm", event.currentTarget.value)} />
        </label>
      </> : null}
    </div>
  );
}
