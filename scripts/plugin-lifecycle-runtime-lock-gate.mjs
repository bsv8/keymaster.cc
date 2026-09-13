// WebLoom 运行锁迁移门禁的纯校验逻辑。
//
// 0.4.2 以及更早的旧 Worker 不会申请 Web Lock，因此新 Worker 不可能
// 通过 LockManager 发现它。首次启用运行锁必须是一次受控冷切换；只有
// 双方都已支持运行锁，才允许用 runtime_lock_conflict 处理后续升级。

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;

export const RUNTIME_LOCK_MIGRATION_MODES = Object.freeze([
  "initial-cold-switch",
  "lock-aware-upgrade",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlaceholder(value) {
  return nonEmptyString(value) && /<[^>]+>/u.test(value);
}

function requireTrue(record, field, label, errors) {
  if (record?.[field] !== true) errors.push(`${label}.${field} 必须为 true`);
}

function requireEvidenceRef(record, field, label, errors) {
  if (!nonEmptyString(record?.[field]) || isPlaceholder(record[field])) {
    errors.push(`${label}.${field} 必须引用部署平台原始记录`);
  }
}

/**
 * 校验部署记录中的运行锁迁移声明。
 *
 * 返回中文错误数组，不直接退出进程，便于部署门禁和自测共用同一规则。
 */
export function validateRuntimeLockMigrationRecord(migration, {
  expectedTargetBuildId = undefined,
  label = "runtimeLockMigration",
} = {}) {
  const errors = [];
  if (!isRecord(migration)) {
    errors.push(`${label} 必须明确声明首次冷切换或双方已支持运行锁的后续升级`);
    return errors;
  }

  if (!RUNTIME_LOCK_MIGRATION_MODES.includes(migration.mode)) {
    errors.push(`${label}.mode 必须是 initial-cold-switch 或 lock-aware-upgrade`);
  }
  if (!nonEmptyString(migration.previousWebLoomVersion) || !EXACT_SEMVER.test(migration.previousWebLoomVersion)) {
    errors.push(`${label}.previousWebLoomVersion 必须是旧 WebLoom 的精确版本`);
  }
  if (!nonEmptyString(migration.targetWebLoomVersion) || !EXACT_SEMVER.test(migration.targetWebLoomVersion)) {
    errors.push(`${label}.targetWebLoomVersion 必须是目标 WebLoom 的精确版本`);
  }
  requireTrue(migration, "targetRuntimeLockAware", label, errors);
  if (expectedTargetBuildId !== undefined && migration.targetBuildId !== expectedTargetBuildId) {
    errors.push(`${label}.targetBuildId 必须与 targetBuildId ${expectedTargetBuildId} 完全一致`);
  }
  if (expectedTargetBuildId !== undefined && (!nonEmptyString(migration.targetBuildId) || isPlaceholder(migration.targetBuildId))) {
    errors.push(`${label}.targetBuildId 必须绑定不可变目标构建`);
  }

  if (migration.mode === "initial-cold-switch") {
    // 这里故意要求 false：它说明旧版本不认识 Web Lock，不能声称会被
    // runtime_lock_conflict 发现；两项退出证据是首次启用的安全前提。
    if (migration.previousRuntimeLockAware !== false) {
      errors.push(`${label}.previousRuntimeLockAware 必须为 false，首次迁移不能假定旧 Worker 会申请 Web Lock`);
    }
    requireTrue(migration, "legacyPagesExited", label, errors);
    requireTrue(migration, "legacyWorkersExited", label, errors);
    requireEvidenceRef(migration, "legacyExitEvidenceRef", label, errors);
  }

  if (migration.mode === "lock-aware-upgrade") {
    // 后续升级只允许在旧版本也实际申请同一稳定锁时使用冲突错误语义。
    if (migration.previousRuntimeLockAware !== true) {
      errors.push(`${label}.previousRuntimeLockAware 必须为 true，只有双方支持 Web Lock 才能使用冲突报错`);
    }
    requireTrue(migration, "conflictErrorVerified", label, errors);
    requireEvidenceRef(migration, "conflictEvidenceRef", label, errors);
  }

  requireEvidenceRef(migration, "targetCapabilityEvidenceRef", label, errors);
  return errors;
}

/**
 * 校验首次冷切换引用的本地 JSON 内容。
 *
 * HTTP(S) 平台记录由发布系统保存，脚本只能要求引用非占位地址；本函数
 * 只对可读的本地原始记录增加结构化字段检查。
 */
export function validateRuntimeLockEvidenceData(data, {
  mode,
  expectedTargetBuildId = undefined,
  label = "runtimeLockMigration.evidence",
} = {}) {
  const errors = [];
  if (!isRecord(data)) {
    errors.push(`${label} 必须是 JSON 对象`);
    return errors;
  }
  if (expectedTargetBuildId !== undefined) {
    const referencedBuildId = data.buildId ?? data.targetBuildId ?? data.currentBuildId;
    if (referencedBuildId !== expectedTargetBuildId) {
      errors.push(`${label} 必须包含目标 buildId ${expectedTargetBuildId}`);
    }
  }
  if (mode === "initial-cold-switch") {
    if (data.legacyPagesExited !== true) errors.push(`${label}.legacyPagesExited 必须为 true`);
    if (data.legacyWorkersExited !== true) errors.push(`${label}.legacyWorkersExited 必须为 true`);
    if (data.legacyRuntimeLockAware !== false) {
      errors.push(`${label}.legacyRuntimeLockAware 必须为 false，不能伪造旧 Worker 已支持 Web Lock`);
    }
  }
  if (mode === "lock-aware-upgrade" && data.conflictErrorVerified !== true) {
    errors.push(`${label}.conflictErrorVerified 必须为 true`);
  }
  return errors;
}

/** 校验目标包的能力证据，避免只靠交接记录中的 true 自证。 */
export function validateRuntimeLockCapabilityData(data, {
  expectedTargetWebLoomVersion = undefined,
  expectedTargetBuildId = undefined,
  label = "runtimeLockMigration.targetCapabilityEvidence",
} = {}) {
  const errors = [];
  if (!isRecord(data)) {
    errors.push(`${label} 必须是 JSON 对象`);
    return errors;
  }
  if (expectedTargetBuildId !== undefined) {
    const referencedBuildId = data.buildId ?? data.targetBuildId ?? data.currentBuildId;
    if (referencedBuildId !== expectedTargetBuildId) {
      errors.push(`${label} 必须包含目标 buildId ${expectedTargetBuildId}`);
    }
  }
  if (expectedTargetWebLoomVersion !== undefined && data.webloomVersion !== expectedTargetWebLoomVersion) {
    errors.push(`${label}.webloomVersion 必须为 ${expectedTargetWebLoomVersion}`);
  }
  if (data.runtimeLockAware !== true) errors.push(`${label}.runtimeLockAware 必须为 true`);
  return errors;
}
