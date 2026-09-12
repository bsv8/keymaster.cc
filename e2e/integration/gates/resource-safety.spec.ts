import { expect, test } from "@playwright/test";
import { createAwsS3Api, S3CleanupResource } from "../resources/s3/s3CleanupResource.js";
import { loadE2ES3Config, publicS3ConfigFingerprint } from "../resources/config/loader.js";
import type { LoadedE2ES3Config } from "../resources/config/types.js";
import { attachRedactedText, redactedError } from "../support/redaction.js";
import { readS3ResourceRunState } from "../support/s3ResourceState.js";
import { RESOURCE_SAFETY_GATE } from "../support/scenarioMetadata.js";
import { scenarioObjectPrefix } from "../support/ids.js";

export const GATE_ID = RESOURCE_SAFETY_GATE.id;
export const GATE_METADATA = RESOURCE_SAFETY_GATE;

function clearSecrets(config: LoadedE2ES3Config | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
}

/**
 * 业务结果：真实资源测试不能因为本地替身通过，就把错误的删除范围带到维护者
 * 指定的 S3 物理桶。这个 Gate 只连接 setup 已经取得 lease 的真实 S3，不使用
 * 本地适配器、内存对象或页面注入；清理规则的纯函数/边界单测不属于 E2E。
 *
 * 开始状态：真实 S3 setup 已按 s3.json 完成非前缀开场清理，并把 lease 状态写入
 * 脱敏运行状态。成功标准：真实对象可以在本场景 prefix 下出现，prefix 清理不会
 * 删除另一个 prefix，且两处对象都能在测试结束前收口。非前缀的全桶收尾由
 * s3-resource-teardown 负责，并在释放 lease 前再次确认。
 */
test(`${GATE_ID}：真实 S3 prefix 清理不越界`, async ({}, testInfo) => {
  test.setTimeout(120_000);
  let config: LoadedE2ES3Config | undefined;
  let resource: S3CleanupResource | undefined;
  let runId: string | undefined;
  const prefixes: string[] = [];
  let gateError: unknown;
  let cleanupError: unknown;

  try {
    const state = await readS3ResourceRunState();
    expect(state, "资源安全 Gate 必须依赖成功的 S3 resource-setup").not.toBeNull();
    if (!state) throw new Error("真实 S3 运行状态不可用");

    config = await loadE2ES3Config();
    expect(publicS3ConfigFingerprint(config), "Gate 与 setup 使用的公开 S3 配置必须一致").toBe(state.configFingerprint);
    runId = state.runId;

    resource = new S3CleanupResource(config.s3);
    await resource.adoptLease(runId);
    const api = createAwsS3Api(config.s3);
    const primaryPrefix = scenarioObjectPrefix(runId, GATE_ID);
    const otherPrefix = scenarioObjectPrefix(runId, `${GATE_ID}-OTHER`);
    prefixes.push(primaryPrefix, otherPrefix);

    expect(await resource.countBusinessObjects(runId, primaryPrefix)).toBe(0);
    expect(await resource.countBusinessObjects(runId, otherPrefix)).toBe(0);
    await api.putObject(`${primaryPrefix}probe.json`, JSON.stringify({ version: 1, scope: "primary" }), { ifNoneMatch: "*" });
    await api.putObject(`${otherPrefix}probe.json`, JSON.stringify({ version: 1, scope: "other" }), { ifNoneMatch: "*" });

    await expect.poll(() => resource!.countBusinessObjects(runId!, primaryPrefix), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => resource!.countBusinessObjects(runId!, otherPrefix), { timeout: 30_000 }).toBe(1);
    await expect(resource.countBusinessObjects(runId, "../outside/")).rejects.toThrow(/prefix is invalid/iu);

    await resource.cleanup(runId, primaryPrefix);
    expect(await resource.countBusinessObjects(runId, primaryPrefix)).toBe(0);
    expect(await resource.countBusinessObjects(runId, otherPrefix)).toBe(1);

    await resource.cleanup(runId, otherPrefix);
    expect(await resource.countBusinessObjects(runId, otherPrefix)).toBe(0);
  } catch (error) {
    gateError = error;
  } finally {
    try {
      if (resource && runId) {
        for (const prefix of prefixes) await resource.cleanup(runId, prefix);
      }
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (gateError) {
        const knownSecrets = config === undefined
          ? []
          : [config.s3.secretAccessKey.read(), ...(config.s3.sessionToken === undefined ? [] : [config.s3.sessionToken.read()])];
        await attachRedactedText(testInfo, "resource-safety-error", JSON.stringify(redactedError(gateError)), { contentType: "application/json", knownSecrets });
      }
    } finally {
      clearSecrets(config);
    }
  }

  if (gateError) throw gateError;
  if (cleanupError) throw cleanupError;
});
