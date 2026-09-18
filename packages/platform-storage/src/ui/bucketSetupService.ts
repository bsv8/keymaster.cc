// packages/platform-storage/src/ui/bucketSetupService.ts
// 桶初始化 / 解锁的共享业务逻辑（无 UI）。
//
// 设计缘由：初始化的桶创建、已有桶解锁、桶内 Key 新建/导入本质上是一套
// 业务流程。这里把"校验草稿 → 只读探测 → 构造计划 → 提交"的业务代码
// 收口成一处，供以下 UI 复用，避免两套实现各自出错：
//   - apps/web 的 InitialSetupPage（onboarding 整页向导）
//   - platform-storage 的 BucketSetupWizard（桶管理页 Modal 向导）
//
// 这里只做纯逻辑与计划构造，不渲染任何界面，也不直接持久化。

import type {
  BucketProbeResult,
  ExistingRemoteStorageConnectPlan,
  InitialSetupPlan,
  InitialSetupResult,
  KeyImportMaterial,
  StorageBucketConnectionConfigV1,
  StorageUserFacingError
} from "@keymaster/contracts";
import { createDeviceRecordRepository, defaultDeviceStorage } from "../index.js";
import type { BucketDraft } from "./bucketConnectionDraft.js";
import { connectionFromBucketDraft, validateBucketDraft } from "./bucketConnectionDraft.js";

/** 桶初始化向导的步骤。 */
export type BucketSetupStep =
  | "type"
  | "parameters"
  | "unlock"
  | "startup-password"
  | "key-choice"
  | "new-key"
  | "import-key"
  | "key-password"
  | "confirm";

/** Key 草稿（与初始化提交计划中的 firstKey 对应）。 */
export type BucketSetupKeyDraft =
  | { kind: "generate"; label: string; capabilities: string[] }
  | {
      kind: "import";
      label: string;
      material: KeyImportMaterial;
      format: string;
      source?: string;
      capabilities: string[];
    };

/** 初始化向导的主步骤定义（进度条）。 */
export const BUCKET_SETUP_STEPS = [
  { id: "type", labelKey: "shell.setup.step.type", defaultLabel: "桶类型" },
  { id: "parameters", labelKey: "shell.setup.step.parameters", defaultLabel: "桶参数与探测" },
  { id: "branch", labelKey: "shell.setup.step.branch", defaultLabel: "解锁 / 创建" },
  { id: "key", labelKey: "shell.setup.step.key", defaultLabel: "第一把 Key" },
  { id: "confirm", labelKey: "shell.setup.step.confirm", defaultLabel: "确认" }
] as const;

/** 生成一次初始化/连接事务 ID；优先使用 crypto.randomUUID。 */
export function bucketSetupTransactionId(): string {
  try { return crypto.randomUUID(); }
  catch { return `setup-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

/**
 * 本机是否已有同名桶（按设备记录显示名称比对）。
 *
 * Local 桶 ID 由 Coordinator 随机生成，页面只需要保证用户输入的桶名称
 * 在本机唯一。
 */
export function localBucketNameConflict(label: string): boolean {
  const name = label.trim();
  if (!name) return false;
  try {
    const { entries } = createDeviceRecordRepository(defaultDeviceStorage()).list();
    return entries.some((entry) => (entry.record.displayName ?? "").trim() === name);
  } catch {
    // 设备存储不可用时由真正的探测/提交报错，名称检查不抢先失败。
    return false;
  }
}

/** 把任意异常转换成可展示错误（页面级兜底）。 */
export function bucketSetupErrorFromException(caught: unknown, setupId?: string): StorageUserFacingError {
  const incidentId = `initial-ui-${bucketSetupTransactionId().slice(0, 18)}`;
  const message = caught instanceof Error ? caught.message : "初始化请求失败";
  return {
    title: "无法完成初始化",
    summary: message,
    action: "请检查参数与存储权限后重试。",
    code: "initial_ui_failed",
    incidentId,
    ...(setupId === undefined ? {} : { transactionId: setupId }),
    diagnostic: `phase=validate code=initial_ui_failed incident=${incidentId} message=${message}`,
    phase: "validate",
    rollback: "not-started",
  };
}

/** 统一把任意抛出物转换成可展示错误（保留已构造的错误对象）。 */
export function asUserFacingError(caught: unknown): StorageUserFacingError {
  if (caught && typeof caught === "object" && "diagnostic" in caught && "incidentId" in caught && "phase" in caught) {
    return caught as StorageUserFacingError;
  }
  return bucketSetupErrorFromException(caught);
}

/** 参数校验 + 本机重名检查；通过后返回连接对象。 */
export function buildBucketConnection(draft: BucketDraft): StorageBucketConnectionConfigV1 {
  const invalid = validateBucketDraft(draft);
  if (invalid) throw bucketSetupErrorFromException(new Error(invalid.message));
  if (draft.backend === "local") {
    // Local 桶 ID 由 Coordinator 随机生成；页面只保证显示名称本机唯一。
    if (localBucketNameConflict(draft.label)) throw bucketSetupErrorFromException(new Error(`本机已有同名桶“${draft.label.trim()}”，请换一个名字。`));
    return { kind: "local" };
  }
  const connection = connectionFromBucketDraft(draft);
  if (connection.kind !== "s3") throw bucketSetupErrorFromException(new Error("S3 连接参数不完整。"));
  // 同一物理位置重复连接由 Worker 复用既有设备记录 ID,不会产生重复条目。
  return connection;
}

/** 由探测结果与当前草稿构造"新建桶 + 首 Key"的提交计划。 */
export function buildInitialSetupPlan(input: {
  transactionId: string;
  draft: BucketDraft;
  connection: StorageBucketConnectionConfigV1;
  startupPassword: string;
  keyDraft: BucketSetupKeyDraft;
  keyPassword: string;
}): InitialSetupPlan {
  const { transactionId, draft, connection, startupPassword, keyDraft, keyPassword } = input;
  return {
    transactionId,
    bucketLabel: draft.label.trim() || "钱包",
    backend: draft.backend,
    connection,
    ...(draft.backend === "s3" ? { startupPassword } : {}),
    firstKey: keyDraft.kind === "generate"
      ? { kind: "generate", label: keyDraft.label, capabilities: [...keyDraft.capabilities], password: keyPassword }
      : {
          kind: "import",
          label: keyDraft.label,
          material: { hex: keyDraft.material.hex, ...(keyDraft.material.wif === undefined ? {} : { wif: keyDraft.material.wif }) },
          format: keyDraft.format,
          ...(keyDraft.source === undefined ? {} : { source: keyDraft.source }),
          capabilities: [...keyDraft.capabilities],
          password: keyPassword,
        },
  };
}

/** 由探测结果与当前草稿构造"解锁已有桶"的提交计划。 */
export function buildConnectPlan(input: {
  operationId: string;
  draft: BucketDraft;
  connection: StorageBucketConnectionConfigV1;
  selectedKeyHex: string | undefined;
  keyPassword: string;
  startupPassword: string;
}): ExistingRemoteStorageConnectPlan {
  const { operationId, draft, connection, selectedKeyHex, keyPassword, startupPassword } = input;
  return {
    operationId,
    displayName: draft.label.trim() || "钱包",
    backend: draft.backend,
    connection,
    ...(selectedKeyHex === undefined ? {} : { publicKeyHex: selectedKeyHex }),
    keyPassword,
    ...(draft.backend === "s3" ? { startupPassword } : {}),
  };
}

/** 探测结果里可选择的 Key 列表。 */
export function probedKeys(probe: BucketProbeResult | undefined): Array<{ publicKeyHex: string; label: string }> {
  return probe?.ok && probe.state === "has-keys" ? probe.keys : [];
}

/**
 * 校验一把 Key 自己的密码；失败返回中文错误，通过返回 null。
 *
 * 初始化向导（首 Key）与桶内"新建/导入 Key"共用同一条规则，避免两处
 * 对"至少 8 位 / 两次必须一致"给出不同结论。
 */
export function validateKeyPassword(input: { password: string; confirm?: string }): string | null {
  if (input.password.length < 8) return "这把 Key 的密码至少 8 位。";
  if (input.confirm !== undefined && input.confirm !== input.password) return "两次输入的 Key 密码不一致。";
  return null;
}

/** 生成 "Key YYYY-MM-DD HH:mm" 形式的默认标签（本地时间）。 */
export function defaultKeyLabel(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `Key ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function maskedIdentifier(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length <= 4) return "••••";
  return `${normalized.slice(0, 2)}••••${normalized.slice(-2)}`;
}

function endpointHint(endpoint: string): string {
  try { return maskedIdentifier(new URL(endpoint).host || "未知主机"); }
  catch { return "地址格式待校验"; }
}

/** 连接目标摘要（不含凭据）。 */
export function connectionTargetHint(draft: BucketDraft, connection: StorageBucketConnectionConfigV1): string {
  if (connection.kind !== "s3") return "Local";
  if (draft.s3ConfigMode === "cloudflare-r2") return `R2 / ${maskedIdentifier(draft.accountId)} / ${connection.bucket}`;
  if (draft.s3ConfigMode === "aws-s3") return `AWS S3 / ${connection.region} / ${connection.bucket}`;
  return `S3 / ${endpointHint(connection.endpoint)} / ${connection.bucket}`;
}

/** S3 配置方式标签。 */
export function s3ConfigModeLabel(mode: BucketDraft["s3ConfigMode"]): string {
  if (mode === "aws-s3") return "AWS S3";
  if (mode === "cloudflare-r2") return "Cloudflare R2";
  return "普通 S3-compatible";
}
