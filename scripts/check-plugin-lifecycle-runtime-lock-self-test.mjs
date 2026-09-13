// 运行锁迁移门禁自测：证明缺少首次冷切换证据会失败，证据齐全会通过。

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRuntimeLockCapabilityData,
  validateRuntimeLockEvidenceData,
  validateRuntimeLockMigrationRecord,
} from "./plugin-lifecycle-runtime-lock-gate.mjs";

const targetBuildId = "a".repeat(40) + "-" + "b".repeat(16);

const missingColdSwitchEvidence = {
  mode: "initial-cold-switch",
  previousWebLoomVersion: "0.4.2",
  targetWebLoomVersion: "0.4.3",
  previousRuntimeLockAware: false,
  targetRuntimeLockAware: true,
  targetBuildId,
  legacyPagesExited: false,
  legacyWorkersExited: false,
  legacyExitEvidenceRef: "",
  targetCapabilityEvidenceRef: "target-runtime-lock.json",
};
const missingErrors = validateRuntimeLockMigrationRecord(missingColdSwitchEvidence, { expectedTargetBuildId: targetBuildId });
assert.ok(missingErrors.some((error) => error.includes("legacyPagesExited")), "缺少旧页面退出证据必须失败");
assert.ok(missingErrors.some((error) => error.includes("legacyWorkersExited")), "缺少旧 Worker 退出证据必须失败");
assert.ok(missingErrors.some((error) => error.includes("legacyExitEvidenceRef")), "缺少旧版本原始记录必须失败");

const completeColdSwitch = {
  ...missingColdSwitchEvidence,
  legacyPagesExited: true,
  legacyWorkersExited: true,
  legacyExitEvidenceRef: "legacy-exit.json",
};
assert.deepEqual(
  validateRuntimeLockMigrationRecord(completeColdSwitch, { expectedTargetBuildId: targetBuildId }),
  [],
  "首次冷切换的结构化证据齐全时应通过",
);
assert.deepEqual(
  validateRuntimeLockEvidenceData({
    buildId: targetBuildId,
    legacyPagesExited: true,
    legacyWorkersExited: true,
    legacyRuntimeLockAware: false,
  }, {
    mode: "initial-cold-switch",
    expectedTargetBuildId: targetBuildId,
  }),
  [],
  "首次冷切换原始退出记录应通过",
);
assert.deepEqual(
  validateRuntimeLockCapabilityData({
    buildId: targetBuildId,
    webloomVersion: "0.4.3",
    runtimeLockAware: true,
  }, {
    expectedTargetWebLoomVersion: "0.4.3",
    expectedTargetBuildId: targetBuildId,
  }),
  [],
  "目标 WebLoom 能力记录应通过",
);

const lockAwareUpgrade = {
  mode: "lock-aware-upgrade",
  previousWebLoomVersion: "0.4.3",
  targetWebLoomVersion: "0.4.4",
  previousRuntimeLockAware: true,
  targetRuntimeLockAware: true,
  targetBuildId,
  conflictErrorVerified: true,
  conflictEvidenceRef: "runtime-lock-conflict.json",
  targetCapabilityEvidenceRef: "target-runtime-lock.json",
};
assert.deepEqual(
  validateRuntimeLockMigrationRecord(lockAwareUpgrade, { expectedTargetBuildId: targetBuildId }),
  [],
  "双方支持运行锁的后续升级应通过",
);

function runChecker(path, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [fileURLToPath(new URL("./check-plugin-lifecycle-deployment.mjs", import.meta.url)), path], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({
      code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
      stdout,
      stderr,
    }));
  });
}

const fixtureRoot = await mkdtemp(join(tmpdir(), "keymaster-runtime-lock-gate-self-test-"));
try {
  const writeJson = async (name, value) => {
    await writeFile(join(fixtureRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  const baseDeployment = {
    schemaVersion: 1,
    buildId: targetBuildId,
    deploymentId: "runtime-lock-self-test",
    targetBuildId,
    previousBuildId: "c".repeat(40) + "-" + "d".repeat(16),
    protocolVersion: "test",
    strategy: "cold-switch",
    phase: "ready-to-activate",
    observedAt: "2026-09-13T00:00:00.000Z",
    previousWorker: {
      protocolAware: false,
      trafficDrained: true,
      exitConfirmed: true,
      activeFinalIoLeases: 0,
      evidenceRef: "previous.json",
    },
    authority: {
      currentBuildId: targetBuildId,
      handoverGeneration: 1,
      noParallelAuthority: true,
      evidenceRef: "authority.json",
    },
    rollback: {
      formatCompatibilityVerified: true,
      reauthRequired: true,
      windowUntil: "2099-01-01T00:00:00.000Z",
      evidenceRef: "rollback.json",
    },
    runtimeLockMigration: completeColdSwitch,
  };
  for (const name of ["previous.json", "authority.json", "rollback.json"]) {
    await writeJson(name, { buildId: targetBuildId, status: "passed" });
  }
  await writeJson("legacy-exit.json", {
    buildId: targetBuildId,
    legacyPagesExited: true,
    legacyWorkersExited: true,
    legacyRuntimeLockAware: false,
  });
  await writeJson("target-runtime-lock.json", {
    buildId: targetBuildId,
    webloomVersion: "0.4.3",
    runtimeLockAware: true,
  });

  const missingDeployment = { ...baseDeployment };
  delete missingDeployment.runtimeLockMigration;
  await writeJson("missing.json", missingDeployment);
  const missingResult = await runChecker(join(fixtureRoot, "missing.json"), {
    KEYMASTER_DEPLOYED_BUILD_ID: targetBuildId,
  });
  assert.notEqual(missingResult.code, 0, "实际部署门禁必须拒绝缺少首次冷切换声明的记录");
  assert.match(`${missingResult.stdout}\n${missingResult.stderr}`, /runtimeLockMigration/);

  await writeJson("complete.json", baseDeployment);
  const completeResult = await runChecker(join(fixtureRoot, "complete.json"), {
    KEYMASTER_DEPLOYED_BUILD_ID: targetBuildId,
  });
  assert.equal(completeResult.code, 0, `实际部署门禁应接受完整冷切换证据\n${completeResult.stdout}\n${completeResult.stderr}`);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("运行锁迁移门禁自测通过：缺少首次冷切换证据会失败，证据齐全以及 lock-aware 后续升级会通过");
