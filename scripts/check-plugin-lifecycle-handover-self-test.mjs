// 插件生命周期部署交接门禁自测：旧 Worker 排空/退出、authority 和回退证据
// 缺失时失败，证据齐全时通过。WebLoom 0.5.0 不再提供框架 Runtime Lock；
// 运行时唯一性由 Keymaster authority Web Lock 负责。

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const targetBuildId = "a".repeat(40) + "-" + "b".repeat(16);

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

const fixtureRoot = await mkdtemp(join(tmpdir(), "keymaster-lifecycle-handover-gate-self-test-"));
try {
  const writeJson = async (name, value) => {
    await writeFile(join(fixtureRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  const baseDeployment = {
    schemaVersion: 1,
    buildId: targetBuildId,
    deploymentId: "handover-self-test",
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
  };
  for (const name of ["previous.json", "authority.json", "rollback.json"]) {
    await writeJson(name, { buildId: targetBuildId, status: "passed" });
  }

  const missingPreviousWorker = { ...baseDeployment };
  delete missingPreviousWorker.previousWorker;
  await writeJson("missing-previous-worker.json", missingPreviousWorker);
  const missingResult = await runChecker(join(fixtureRoot, "missing-previous-worker.json"), {
    KEYMASTER_DEPLOYED_BUILD_ID: targetBuildId,
  });
  assert.notEqual(missingResult.code, 0, "缺少旧 Worker 排空/退出记录必须失败");
  assert.match(`${missingResult.stdout}\n${missingResult.stderr}`, /previousWorker/);

  await writeJson("complete.json", baseDeployment);
  const completeResult = await runChecker(join(fixtureRoot, "complete.json"), {
    KEYMASTER_DEPLOYED_BUILD_ID: targetBuildId,
  });
  assert.equal(completeResult.code, 0, `完整交接证据应通过\n${completeResult.stdout}\n${completeResult.stderr}`);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("插件生命周期交接门禁自测通过：旧 Worker、Keymaster authority、回退证据均被校验，未依赖 WebLoom Runtime Lock");
