// 插件生命周期生产发布门禁。
//
// 代码测试只能证明本地实现行为，不能证明目标部署、外部供应商和旧版本
// 已退役。因此发布必须提交一份由目标环境验收产生的 JSON 证据；缺失、
// 过期或只写“通过”但没有引用的证据都会失败。

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isBuildId } from "./plugin-lifecycle-build-id.mjs";

const evidencePath = process.env.KEYMASTER_LIFECYCLE_EVIDENCE_FILE;
const PRODUCT_CATALOG_SOURCE = resolve("packages/contracts/src/pluginProducts.ts");

/** 从唯一产品契约读取 ID，避免发布门禁维护另一份易漂移的清单。 */
function readRequiredProducts(source) {
  const match = source.match(/export const BUILTIN_PLUGIN_PRODUCT_IDS = \[(?<body>[\s\S]*?)\] as const/u);
  if (!match?.groups?.body) throw new Error(`无法从 ${PRODUCT_CATALOG_SOURCE} 读取内置产品清单`);
  const ids = [...match.groups.body.matchAll(/"([^"\n]+)"/gu)].map((item) => item[1]);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(`内置产品清单 ${PRODUCT_CATALOG_SOURCE} 为空或包含重复 ID`);
  }
  return ids;
}

const productCatalogSource = await readFile(PRODUCT_CATALOG_SOURCE, "utf8");
const REQUIRED_PRODUCTS = readRequiredProducts(productCatalogSource);

/** 从同一份产品契约读取所有静态运行单元，防止证据只覆盖 Window。 */
function readRequiredRuntimeUnits(source) {
  const units = [...source.matchAll(/\{\s*productId:\s*"([^"\n]+)",\s*unitId:\s*"([^"\n]+)",\s*execution:\s*"([^"\n]+)",\s*lifetime:\s*"([^"\n]+)"\s*\}/gu)]
    .map((match) => ({ productId: match[1], unitId: match[2], execution: match[3], lifetime: match[4] }));
  if (units.length === 0 || new Set(units.map((unit) => `${unit.productId}\u0000${unit.unitId}`)).size !== units.length) {
    throw new Error(`无法从 ${PRODUCT_CATALOG_SOURCE} 读取唯一运行单元清单`);
  }
  return units;
}

const REQUIRED_RUNTIME_UNITS = readRequiredRuntimeUnits(productCatalogSource);
const REQUIRED_SECTIONS = [
  "domainUnits",
  "externalAppView",
  "recoveryDrill",
  "irreversibleIoSmoke",
  "oldWorkerRetirement",
  "rollbackDrill",
  "deploymentHandover",
];
const REQUIRED_IO_SCENARIOS = [
  "owner-storage",
  "platform-storage",
  "msfile-upload",
  "remote-subscription",
  "p2pkh-broadcast",
  "sat-payment-unknown-result",
  "unknown-result-no-replay",
];
const ALLOWED_EXECUTIONS = new Set(["coordinator-worker", "window", "connect-worker"]);
const ALLOWED_LIFETIMES = new Set(["root", "storage", "owner-session", "connect-session"]);

function fail(message, details = []) {
  console.error(`插件生命周期生产门禁失败：${message}`);
  for (const detail of details) console.error(`- ${detail}`);
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

function passedSection(section, name, expectedBuildId, errors) {
  if (!isRecord(section)) {
    errors.push(`${name} 必须是对象`);
    return;
  }
  if (section.status !== "passed") errors.push(`${name}.status 必须为 passed`);
  if (section.buildId !== expectedBuildId) errors.push(`${name}.buildId 必须与根 buildId 完全一致`);
  if (!nonEmptyString(section.evidenceRef) || isPlaceholder(section.evidenceRef)) errors.push(`${name}.evidenceRef 必须引用真实原始验收记录`);
  if (!nonEmptyString(section.verifiedAt) || Number.isNaN(Date.parse(section.verifiedAt))) {
    errors.push(`${name}.verifiedAt 必须是有效时间`);
  }
}

function isHttpReference(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 校验本地原始报告内容，而不是只看 evidenceRef 文件名非空。 */
async function validateReferenceContent(reference, label, expectedBuildId, baseDir, errors) {
  if (!nonEmptyString(reference) || isPlaceholder(reference) || isHttpReference(reference)) return;
  const referencePath = resolve(baseDir, reference);
  let content;
  try {
    content = await readFile(referencePath, "utf8");
  } catch (error) {
    errors.push(`${label} 引用的本地记录无法读取：${referencePath}`);
    return;
  }
  const text = content.trim();
  if (!text) {
    errors.push(`${label} 引用的原始记录为空：${referencePath}`);
    return;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error("not-object");
    const referencedBuildId = parsed.buildId ?? parsed.targetBuildId ?? parsed.currentBuildId;
    if (referencedBuildId !== expectedBuildId) {
      errors.push(`${label} 原始记录中的 buildId/targetBuildId 必须与 ${expectedBuildId} 一致`);
    }
  } catch {
    if (!text.includes(expectedBuildId)) {
      errors.push(`${label} 原始文本必须包含 ${expectedBuildId}`);
    }
  }
}

async function readLocalJsonReference(reference, label, baseDir, errors) {
  if (!nonEmptyString(reference) || isPlaceholder(reference) || isHttpReference(reference)) {
    errors.push(`${label} 必须是本地 JSON 交接文件，不能使用 URL 或占位符`);
    return undefined;
  }
  const referencePath = resolve(baseDir, reference);
  try {
    const value = JSON.parse(await readFile(referencePath, "utf8"));
    if (!isRecord(value)) errors.push(`${label} 必须包含 JSON 对象`);
    return value;
  } catch (error) {
    errors.push(`${label} 无法读取或解析：${referencePath}`);
    return undefined;
  }
}

if (!evidencePath) {
  fail("未提供 KEYMASTER_LIFECYCLE_EVIDENCE_FILE", [
    "证据文件必须来自目标部署验收，不能用环境变量直接声明 passed。",
    "示例：KEYMASTER_LIFECYCLE_EVIDENCE_FILE=./release/plugin-lifecycle-evidence.json pnpm verify:lifecycle-production-gates",
  ]);
} else {
  try {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const errors = [];
    if (!isRecord(evidence)) errors.push("证据根节点必须是对象");
    if (evidence.schemaVersion !== 1) errors.push("schemaVersion 必须为 1");
    if (!nonEmptyString(evidence.generatedAt) || Number.isNaN(Date.parse(evidence.generatedAt))) errors.push("generatedAt 必须是有效时间");
    if (!nonEmptyString(evidence.evidenceExpiresAt) || Number.isNaN(Date.parse(evidence.evidenceExpiresAt))) errors.push("evidenceExpiresAt 必须是有效时间");
    if (!/^[0-9a-f]{40}$/iu.test(evidence.commit ?? "")) errors.push("commit 必须是完整 40 位 Git commit hash");
    if (!isBuildId(evidence.buildId)) errors.push("buildId 必须是 commit(40位)-sourceDigest(16位) 的不可变构建标识");
    if (isBuildId(evidence.buildId) && nonEmptyString(evidence.commit) && !evidence.buildId.startsWith(`${evidence.commit}-`)) {
      errors.push("buildId 必须以 evidence.commit 开头，不能与其它代码版本绑定");
    }
    if (evidence.sourceDigest !== undefined && !/^[0-9a-f]{64}$/iu.test(evidence.sourceDigest ?? "")) {
      errors.push("sourceDigest 必须是 64 位 SHA-256 源码摘要");
    }
    if (isBuildId(evidence.buildId) && /^[0-9a-f]{64}$/iu.test(evidence.sourceDigest ?? "")) {
      const digestPrefix = evidence.sourceDigest.slice(0, 16).toLowerCase();
      if (!evidence.buildId.endsWith(`-${digestPrefix}`)) {
        errors.push("buildId 的摘要后缀必须与 sourceDigest 前 16 位一致");
      }
    }
    const generatedAtMs = Date.parse(evidence.generatedAt);
    const expiresAtMs = Date.parse(evidence.evidenceExpiresAt);
    if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now()) errors.push("evidenceExpiresAt 已过期");
    if (!Number.isNaN(generatedAtMs) && !Number.isNaN(expiresAtMs) && expiresAtMs <= generatedAtMs) errors.push("evidenceExpiresAt 必须晚于 generatedAt");
    const expectedBuildId = typeof evidence.buildId === "string" ? evidence.buildId : "";
    const externallyExpectedBuildId = process.env.KEYMASTER_DEPLOYED_BUILD_ID ?? process.env.KEYMASTER_EXPECTED_BUILD_ID;
    if (!nonEmptyString(externallyExpectedBuildId)) {
      errors.push("必须提供部署系统回报的 KEYMASTER_DEPLOYED_BUILD_ID，不能只凭证据文件自证产物版本");
    } else if (!isBuildId(externallyExpectedBuildId)) {
      errors.push("KEYMASTER_DEPLOYED_BUILD_ID 必须是 commit(40位)-sourceDigest(16位) 的不可变构建标识");
    } else if (externallyExpectedBuildId !== expectedBuildId) {
      errors.push("证据 buildId 与部署系统提供的 KEYMASTER_DEPLOYED_BUILD_ID 不一致");
    }

    for (const name of REQUIRED_SECTIONS) passedSection(evidence[name], name, expectedBuildId, errors);

    const external = evidence.externalAppView;
    if (isRecord(external)) {
      let origin;
      try { origin = new URL(external.origin); } catch { origin = undefined; }
      if (isPlaceholder(external.origin) || !origin || !["http:", "https:"].includes(origin.protocol) || ["localhost", "127.0.0.1", "::1"].includes(origin.hostname)) {
        errors.push("externalAppView.origin 必须是非本机 http(s) 部署 origin");
      }
      if (!nonEmptyString(external.successSelector) || isPlaceholder(external.successSelector)) errors.push("externalAppView.successSelector 必须是实际成功状态选择器");
    }

    const domain = evidence.domainUnits;
    if (isRecord(domain)) {
      const productIds = Array.isArray(domain.productIds) ? domain.productIds : [];
      const duplicateProductIds = productIds.filter((productId, index) => productIds.indexOf(productId) !== index);
      if (duplicateProductIds.length > 0) errors.push(`domainUnits.productIds 不能重复：${[...new Set(duplicateProductIds)].join(", ")}`);
      const unknownProducts = productIds.filter((productId) => typeof productId !== "string" || !REQUIRED_PRODUCTS.includes(productId));
      if (unknownProducts.length > 0) errors.push(`domainUnits.productIds 包含未知产品：${[...new Set(unknownProducts)].join(", ")}`);
      const missing = REQUIRED_PRODUCTS.filter((productId) => !productIds.includes(productId));
      if (missing.length > 0) errors.push(`domainUnits.productIds 缺少产品：${missing.join(", ")}`);
      const unexpectedProducts = productIds.filter((productId) => !REQUIRED_PRODUCTS.includes(productId));
      if (unexpectedProducts.length > 0) errors.push(`domainUnits.productIds 包含非发行版产品：${[...new Set(unexpectedProducts)].join(", ")}`);
      if (!Array.isArray(domain.units)) {
        errors.push("domainUnits.units 必须记录每个产品实际装配的运行单元");
      } else {
        const unitProducts = new Set();
        const unitIds = new Set();
        for (const [index, unit] of domain.units.entries()) {
          if (!isRecord(unit)) {
            errors.push(`domainUnits.units[${index}] 必须是对象`);
            continue;
          }
          for (const field of ["productId", "unitId", "execution", "lifetime"]) {
            if (!nonEmptyString(unit[field])) errors.push(`domainUnits.units[${index}].${field} 不能为空`);
          }
          if (nonEmptyString(unit.productId)) {
            unitProducts.add(unit.productId);
            if (!REQUIRED_PRODUCTS.includes(unit.productId)) errors.push(`domainUnits.units[${index}].productId 不是内置产品：${unit.productId}`);
          }
          if (nonEmptyString(unit.unitId)) {
            if (unitIds.has(unit.unitId)) errors.push(`domainUnits.units[${index}].unitId 重复：${unit.unitId}`);
            unitIds.add(unit.unitId);
          }
          if (nonEmptyString(unit.execution) && !ALLOWED_EXECUTIONS.has(unit.execution)) {
            errors.push(`domainUnits.units[${index}].execution 不属于 PluginExecution 契约：${unit.execution}`);
          }
          if (nonEmptyString(unit.lifetime) && !ALLOWED_LIFETIMES.has(unit.lifetime)) {
            errors.push(`domainUnits.units[${index}].lifetime 不属于 PluginLifetime 契约：${unit.lifetime}`);
          }
          if (unit.status !== "verified") errors.push(`domainUnits.units[${index}].status 必须为 verified`);
        }
        const missingUnits = REQUIRED_PRODUCTS.filter((productId) => !unitProducts.has(productId));
        if (missingUnits.length > 0) errors.push(`domainUnits.units 缺少产品运行单元：${missingUnits.join(", ")}`);
        const expectedUnitKeys = new Set(REQUIRED_RUNTIME_UNITS.map((unit) => `${unit.productId}\u0000${unit.unitId}`));
        const actualUnitKeys = new Set(domain.units
          .filter((unit) => isRecord(unit) && nonEmptyString(unit.productId) && nonEmptyString(unit.unitId))
          .map((unit) => `${unit.productId}\u0000${unit.unitId}`));
        for (const expected of REQUIRED_RUNTIME_UNITS) {
          const key = `${expected.productId}\u0000${expected.unitId}`;
          if (!actualUnitKeys.has(key)) errors.push(`domainUnits.units 缺少静态运行单元：${expected.productId}/${expected.unitId}`);
          const actual = domain.units.find((unit) => isRecord(unit) && unit.productId === expected.productId && unit.unitId === expected.unitId);
          if (actual && (actual.execution !== expected.execution || actual.lifetime !== expected.lifetime)) {
            errors.push(`domainUnits.units 运行环境或寿命不匹配：${expected.productId}/${expected.unitId}`);
          }
        }
        for (const actual of actualUnitKeys) {
          if (!expectedUnitKeys.has(actual)) errors.push(`domainUnits.units 包含未登记运行单元：${actual.replace("\u0000", "/")}`);
        }
      }
    }

    const io = evidence.irreversibleIoSmoke;
    if (isRecord(io)) {
      const entries = Array.isArray(io.scenarios) ? io.scenarios : [];
      const scenarios = entries
        .map((entry) => isRecord(entry) ? entry.id : entry)
        .filter((scenario) => typeof scenario === "string");
      const missing = REQUIRED_IO_SCENARIOS.filter((scenario) => !scenarios.includes(scenario));
      if (missing.length > 0) errors.push(`irreversibleIoSmoke.scenarios 缺少场景：${missing.join(", ")}`);
      const duplicateScenarios = scenarios.filter((scenario, index) => scenarios.indexOf(scenario) !== index);
      if (duplicateScenarios.length > 0) errors.push(`irreversibleIoSmoke.scenarios 不能重复：${[...new Set(duplicateScenarios)].join(", ")}`);
      for (const [index, entry] of entries.entries()) {
        if (!isRecord(entry)) {
          errors.push(`irreversibleIoSmoke.scenarios[${index}] 必须是包含现场结果的对象`);
          continue;
        }
        if (!["completed", "failed", "unknown"].includes(entry.status)) errors.push(`irreversibleIoSmoke.scenarios[${index}].status 无效`);
        if (!nonEmptyString(entry.operationId) || isPlaceholder(entry.operationId)) errors.push(`irreversibleIoSmoke.scenarios[${index}].operationId 必须是真实幂等编号`);
        if (!["confirmed", "not-submitted", "unknown", "manual"].includes(entry.repositoryResolution)) errors.push(`irreversibleIoSmoke.scenarios[${index}].repositoryResolution 无效`);
        if (entry.buildId !== expectedBuildId) errors.push(`irreversibleIoSmoke.scenarios[${index}].buildId 必须与根 buildId 完全一致`);
        if (entry.replayPrevented !== true) errors.push(`irreversibleIoSmoke.scenarios[${index}].replayPrevented 必须为 true`);
        if (!nonEmptyString(entry.evidenceRef) || isPlaceholder(entry.evidenceRef)) errors.push(`irreversibleIoSmoke.scenarios[${index}].evidenceRef 必须引用原始 smoke 记录`);
      }
    }

    const retirement = evidence.oldWorkerRetirement;
    if (isRecord(retirement)) {
      for (const field of ["unknownWorkerExitConfirmed", "trafficDrainConfirmed", "versionRetirementConfirmed", "rollbackWindowConfirmed"]) {
        if (retirement[field] !== true) errors.push(`oldWorkerRetirement.${field} 必须为 true`);
      }
    }

    const rollback = evidence.rollbackDrill;
    if (isRecord(rollback)) {
      for (const field of ["formatCompatibilityVerified", "noParallelAuthority", "reauthRequired"]) {
        if (rollback[field] !== true) errors.push(`rollbackDrill.${field} 必须为 true`);
      }
    }

    const recovery = evidence.recoveryDrill;
    if (isRecord(recovery)) {
      for (const field of ["oldLeaseObserved", "authorityRejected", "retrySucceeded", "oldLeaseRejected", "unknownResultNotReplayed"]) {
        if (recovery[field] !== true) errors.push(`recoveryDrill.${field} 必须为 true`);
      }
    }

    const handover = evidence.deploymentHandover;
    let deploymentObservedAtMs = Number.NaN;
    if (isRecord(handover)) {
      if (handover.buildId !== expectedBuildId) errors.push("deploymentHandover.buildId 必须与根 buildId 完全一致");
      if (handover.targetBuildId !== expectedBuildId) errors.push("deploymentHandover.targetBuildId 必须与根 buildId 完全一致");
      if (!["cold-switch", "two-phase"].includes(handover.strategy)) errors.push("deploymentHandover.strategy 必须是 cold-switch 或 two-phase");
      if (!nonEmptyString(handover.handoverFile) || isPlaceholder(handover.handoverFile)) errors.push("deploymentHandover.handoverFile 必须引用已校验的交接文件");
      for (const field of ["oldWorkerExitConfirmed", "trafficDrainConfirmed", "noParallelAuthority", "rollbackWindowConfirmed"]) {
        if (handover[field] !== true) errors.push(`deploymentHandover.${field} 必须为 true`);
      }
    }

    // 本地引用必须被读取并且在内容中绑定同一构建；HTTP(S) 引用保留给
    // 部署平台记录，但仍要求 section.buildId 先完成结构化绑定。
    const evidenceBaseDir = dirname(resolve(evidencePath));
    for (const name of REQUIRED_SECTIONS) {
      const section = evidence[name];
      if (isRecord(section)) {
        await validateReferenceContent(section.evidenceRef, `${name}.evidenceRef`, expectedBuildId, evidenceBaseDir, errors);
      }
    }
    if (isRecord(io) && Array.isArray(io.scenarios)) {
      for (const [index, entry] of io.scenarios.entries()) {
        if (isRecord(entry)) {
          await validateReferenceContent(entry.evidenceRef, `irreversibleIoSmoke.scenarios[${index}].evidenceRef`, expectedBuildId, evidenceBaseDir, errors);
        }
      }
    }
    if (isRecord(handover)) {
      const deployment = await readLocalJsonReference(handover.handoverFile, "deploymentHandover.handoverFile", evidenceBaseDir, errors);
      if (isRecord(deployment)) {
        if (validDate(deployment.observedAt)) deploymentObservedAtMs = Date.parse(deployment.observedAt);
        if (deployment.targetBuildId !== expectedBuildId) errors.push("交接文件 targetBuildId 必须与证据 buildId 完全一致");
        if (isRecord(deployment.authority) && deployment.authority.currentBuildId !== expectedBuildId) {
          errors.push("交接文件 authority.currentBuildId 必须与证据 buildId 完全一致");
        }
        if (validDate(deployment.observedAt) && validDate(handover.verifiedAt)
          && Date.parse(handover.verifiedAt) < Date.parse(deployment.observedAt)) {
          errors.push("deploymentHandover.verifiedAt 必须晚于部署交接 observedAt");
        }
      }
    }

    for (const name of REQUIRED_SECTIONS) {
      const section = evidence[name];
      if (!isRecord(section) || !validDate(section.verifiedAt) || Number.isNaN(expiresAtMs)) continue;
      if (Date.parse(section.verifiedAt) > expiresAtMs) errors.push(`${name}.verifiedAt 不能晚于 evidenceExpiresAt`);
      if (Date.parse(section.verifiedAt) > Date.now() + 5 * 60 * 1000) errors.push(`${name}.verifiedAt 不能是未来时间`);
      if (!Number.isNaN(deploymentObservedAtMs) && Date.parse(section.verifiedAt) < deploymentObservedAtMs) {
        errors.push(`${name}.verifiedAt 必须不早于部署交接 observedAt`);
      }
    }

    if (errors.length > 0) {
      fail(`证据文件 ${evidencePath} 不满足发布要求`, errors);
    } else {
      console.log(`插件生命周期生产门禁通过：${evidencePath}`);
    }
  } catch (error) {
    fail(`无法读取证据文件 ${evidencePath}`, [error instanceof Error ? error.message : String(error)]);
  }
}
