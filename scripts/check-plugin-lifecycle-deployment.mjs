// 插件生命周期部署交接门禁。
//
// 应用内 authority 只能保护理解同一协议的 Worker；它不能隔空停止一个
// 完全不认识 authority / final-I/O lease 的旧 Worker。因此发布编排必须
// 先提交一份来自实际部署系统的交接记录，再允许冷切换或回退。
//
// 用法：
//   KEYMASTER_LIFECYCLE_DEPLOYMENT_FILE=./release/deployment-handover.json \
//     pnpm verify:lifecycle-deployment
//
// 本脚本只验证交接记录是否完整，不把“操作者写了 true”当成现场事实；
// evidenceRef 必须指向部署平台的原始排空/退出/回退记录。

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isBuildId } from "./plugin-lifecycle-build-id.mjs";

const deploymentPath = process.argv[2] ?? process.env.KEYMASTER_LIFECYCLE_DEPLOYMENT_FILE;
const errors = [];

function fail(message) {
  console.error("插件生命周期部署交接失败：" + message);
  for (const error of errors) console.error("- " + error);
  process.exitCode = 1;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlaceholder(value) {
  return nonEmptyString(value) && /<[^>]+>/u.test(value);
}

function validDate(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isHttpReference(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function requireTrue(record, field, label) {
  if (record?.[field] !== true) errors.push(label + "." + field + " 必须为 true");
}

function requireEvidenceRef(record, label) {
  if (!nonEmptyString(record?.evidenceRef) || isPlaceholder(record.evidenceRef)) {
    errors.push(label + ".evidenceRef 必须引用部署平台原始记录");
  }
}

/** 本地原始交接记录必须在内容中携带目标 buildId，不能只填一个文件名。 */
async function validateEvidenceContent(record, label, expectedBuildId, baseDir) {
  const reference = record?.evidenceRef;
  if (!nonEmptyString(reference) || isPlaceholder(reference) || isHttpReference(reference)) return;
  const path = resolve(baseDir, reference);
  try {
    const text = (await readFile(path, "utf8")).trim();
    if (!text) throw new Error("empty");
    try {
      const value = JSON.parse(text);
      const referencedBuildId = value && typeof value === "object"
        ? value.buildId ?? value.targetBuildId ?? value.currentBuildId
        : undefined;
      if (referencedBuildId !== expectedBuildId) errors.push(`${label}.evidenceRef 内容未绑定 targetBuildId ${expectedBuildId}`);
    } catch {
      if (!text.includes(expectedBuildId)) errors.push(`${label}.evidenceRef 原始文本必须包含 targetBuildId ${expectedBuildId}`);
    }
  } catch {
    errors.push(`${label}.evidenceRef 引用的本地记录无法读取：${path}`);
  }
}

if (!deploymentPath) {
  fail("未提供部署交接文件；不能把普通构建直接切换到生产");
} else {
  try {
    const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
    if (!isRecord(deployment)) errors.push("根节点必须是对象");
    if (deployment.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
    for (const field of ["deploymentId", "targetBuildId", "previousBuildId", "protocolVersion", "buildId"]) {
      if (!nonEmptyString(deployment[field]) || isPlaceholder(deployment[field])) {
        errors.push(field + " 必须是非占位字符串");
      }
    }
    if (!isBuildId(deployment.targetBuildId)) errors.push("targetBuildId 必须是 commit(40位)-sourceDigest(16位) 的不可变构建标识");
    if (!isBuildId(deployment.previousBuildId)) errors.push("previousBuildId 必须是完整的不可变构建标识");
    if (deployment.buildId !== deployment.targetBuildId) errors.push("buildId 必须与 targetBuildId 完全一致");
    const externallyExpectedBuildId = process.env.KEYMASTER_DEPLOYED_BUILD_ID ?? process.env.KEYMASTER_EXPECTED_BUILD_ID;
    if (!nonEmptyString(externallyExpectedBuildId)) {
      errors.push("必须提供部署系统回报的 KEYMASTER_DEPLOYED_BUILD_ID，不能只凭交接文件自证目标产物");
    } else if (!isBuildId(externallyExpectedBuildId)) {
      errors.push("KEYMASTER_DEPLOYED_BUILD_ID 必须是 commit(40位)-sourceDigest(16位) 的不可变构建标识");
    } else if (externallyExpectedBuildId !== deployment.targetBuildId) {
      errors.push("交接文件 targetBuildId 与部署系统提供的 buildId 不一致");
    }
    if (deployment.targetBuildId === deployment.previousBuildId) {
      errors.push("targetBuildId 不能与 previousBuildId 相同");
    }
    if (deployment.strategy !== "cold-switch" && deployment.strategy !== "two-phase") {
      errors.push("strategy 必须是 cold-switch 或 two-phase");
    }
    if (deployment.phase !== "ready-to-activate") {
      errors.push("phase 必须为 ready-to-activate；只生成记录不能直接放行");
    }
    if (!validDate(deployment.observedAt)) errors.push("observedAt 必须是有效时间");

    const previousWorker = deployment.previousWorker;
    if (!isRecord(previousWorker)) {
      errors.push("previousWorker 必须记录旧 Worker 现场状态");
    } else {
      if (typeof previousWorker.protocolAware !== "boolean") errors.push("previousWorker.protocolAware 必须是布尔值");
      requireTrue(previousWorker, "trafficDrained", "previousWorker");
      requireTrue(previousWorker, "exitConfirmed", "previousWorker");
      if (!Number.isSafeInteger(previousWorker.activeFinalIoLeases) || previousWorker.activeFinalIoLeases !== 0) {
        errors.push("previousWorker.activeFinalIoLeases 必须为 0");
      }
      requireEvidenceRef(previousWorker, "previousWorker");
      if (previousWorker.protocolAware === false && previousWorker.exitConfirmed !== true) {
        errors.push("不认识接管协议的旧 Worker 必须先确认退出");
      }
    }

    const authority = deployment.authority;
    if (!isRecord(authority)) {
      errors.push("authority 必须记录当前接管世代和并行权威检查");
    } else {
      requireTrue(authority, "noParallelAuthority", "authority");
      if (!Number.isSafeInteger(authority.handoverGeneration) || authority.handoverGeneration < 1) {
        errors.push("authority.handoverGeneration 必须是大于 0 的安全整数");
      }
      if (authority.currentBuildId !== deployment.targetBuildId) {
        errors.push("authority.currentBuildId 必须等于 targetBuildId");
      }
      requireEvidenceRef(authority, "authority");
    }

    const rollback = deployment.rollback;
    if (!isRecord(rollback)) {
      errors.push("rollback 必须记录回退前置条件");
    } else {
      requireTrue(rollback, "formatCompatibilityVerified", "rollback");
      requireTrue(rollback, "reauthRequired", "rollback");
      if (!validDate(rollback.windowUntil) || Date.parse(rollback.windowUntil) <= Date.now()) {
        errors.push("rollback.windowUntil 必须是尚未过期的回退窗口");
      }
      requireEvidenceRef(rollback, "rollback");
    }

    if (deployment.strategy === "two-phase" && deployment.previousWorker?.protocolAware !== true) {
      errors.push("two-phase 只允许已理解接管协议的旧 Worker");
    }

    const evidenceBaseDir = dirname(resolve(deploymentPath));
    await validateEvidenceContent(previousWorker, "previousWorker", deployment.targetBuildId, evidenceBaseDir);
    await validateEvidenceContent(authority, "authority", deployment.targetBuildId, evidenceBaseDir);
    await validateEvidenceContent(rollback, "rollback", deployment.targetBuildId, evidenceBaseDir);

    if (errors.length > 0) {
      fail("文件 " + deploymentPath + " 不满足接管门禁");
    } else {
      console.log("插件生命周期部署交接通过：" + deploymentPath);
      console.log("- strategy: " + deployment.strategy);
      console.log("- targetBuildId: " + deployment.targetBuildId);
      console.log("- handoverGeneration: " + deployment.authority.handoverGeneration);
    }
  } catch (error) {
    fail("无法读取部署交接文件 " + deploymentPath, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}
