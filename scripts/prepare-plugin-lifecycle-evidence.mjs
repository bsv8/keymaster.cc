// 生成插件生命周期生产证据的“待验收”骨架。
//
// 该脚本只填充当前代码版本和静态产品/运行单元清单；所有目标部署、
// 外部供应商、恢复和回退结果仍保持 pending，不能直接解除发布门禁。
// 默认不覆盖已有文件，避免误删现场证据；确需重建时显式传 --force。

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { computeBuildIdentity } from "./plugin-lifecycle-build-id.mjs";
const outputPath = resolve(process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length)
  ?? process.env.KEYMASTER_LIFECYCLE_EVIDENCE_FILE
  ?? "release/plugin-lifecycle-evidence.json");
const force = process.argv.includes("--force");
const productSourcePath = resolve("packages/contracts/src/pluginProducts.ts");
const source = await readFile(productSourcePath, "utf8");

function readProducts() {
  const match = source.match(/export const BUILTIN_PLUGIN_PRODUCT_IDS = \[(?<body>[\s\S]*?)\] as const/u);
  if (!match?.groups?.body) throw new Error("无法读取内置产品清单");
  return [...match.groups.body.matchAll(/"([^"\n]+)"/gu)].map((item) => item[1]);
}

function readUnits() {
  // 产品契约使用 runtime/scopeKind；证据文件保留 execution/lifetime 字段名，
  // 便于历史验收工具和中文审阅者理解，这里只做机械映射。
  return [...source.matchAll(/\{\s*productId:\s*"([^"\n]+)",\s*unitId:\s*"([^"\n]+)",\s*runtime:\s*"([^"\n]+)",\s*scopeKind:\s*"([^"\n]+)"\s*\}/gu)]
    .map((match) => ({
      productId: match[1],
      unitId: match[2],
      execution: match[3],
      lifetime: match[4],
      status: "pending",
    }));
}

try {
  await access(outputPath);
  if (!force) throw new Error("目标文件已存在；如需重建请显式传 --force");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

// 必须在写出证据前计算身份；--force 只能覆盖旧证据，不能绕过 clean 检查。
const buildIdentity = await computeBuildIdentity({ requireClean: true });
const generatedAt = new Date().toISOString();
const evidenceExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const scenarios = [
  "owner-storage",
  "platform-storage",
  "msfile-upload",
  "remote-subscription",
  "p2pkh-broadcast",
  "sat-payment-unknown-result",
  "unknown-result-no-replay",
].map((id) => ({
  id,
  buildId: buildIdentity.buildId,
  status: "pending",
  operationId: "",
  repositoryResolution: "unknown",
  replayPrevented: false,
  evidenceRef: "",
}));

const evidence = {
  schemaVersion: 1,
  generatedAt,
  evidenceExpiresAt,
  commit: buildIdentity.commit,
  buildId: buildIdentity.buildId,
  sourceDigest: buildIdentity.sourceDigest,
  domainUnits: {
    buildId: buildIdentity.buildId,
    status: "pending",
    verifiedAt: "",
    evidenceRef: "",
    productIds: readProducts(),
    units: readUnits(),
  },
  externalAppView: {
    buildId: buildIdentity.buildId,
    status: "pending",
    verifiedAt: "",
    evidenceRef: "",
    origin: "",
    successSelector: "",
  },
  recoveryDrill: {
    buildId: buildIdentity.buildId,
    status: "pending",
    verifiedAt: "",
    evidenceRef: "",
    oldLeaseObserved: false,
    authorityRejected: false,
    retrySucceeded: false,
    oldLeaseRejected: false,
    unknownResultNotReplayed: false,
  },
  irreversibleIoSmoke: {
    buildId: buildIdentity.buildId,
    status: "pending",
    verifiedAt: "",
    evidenceRef: "",
    scenarios,
  },
  oldWorkerRetirement: {
    buildId: buildIdentity.buildId,
    status: "pending",
    verifiedAt: "",
    evidenceRef: "",
    unknownWorkerExitConfirmed: false,
    trafficDrainConfirmed: false,
    versionRetirementConfirmed: false,
    rollbackWindowConfirmed: false,
  },
  rollbackDrill: {
    buildId: buildIdentity.buildId,
    status: "pending",
    verifiedAt: "",
    evidenceRef: "",
    formatCompatibilityVerified: false,
    noParallelAuthority: false,
    reauthRequired: false,
  },
  deploymentHandover: {
    buildId: buildIdentity.buildId,
    status: "pending",
    verifiedAt: "",
    evidenceRef: "",
    handoverFile: "",
    targetBuildId: buildIdentity.buildId,
    strategy: "cold-switch",
    oldWorkerExitConfirmed: false,
    trafficDrainConfirmed: false,
    noParallelAuthority: false,
    rollbackWindowConfirmed: false,
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
console.log("已生成待验收插件生命周期证据骨架：" + outputPath);
console.log("该文件仍为 pending；完成现场验收后再运行 pnpm verify:lifecycle-production-gates。");
