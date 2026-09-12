import { expect, test } from "@playwright/test";
import { readResourceRunState } from "../support/resourceState.js";
import { REAL_SATSUBSCRIPTION_HEALTH_SCENARIO } from "../support/scenarioMetadata.js";

export const JOURNEY_ID = REAL_SATSUBSCRIPTION_HEALTH_SCENARIO.id;
export const JOURNEY_METADATA = REAL_SATSUBSCRIPTION_HEALTH_SCENARIO;

/**
 * 业务目标：真实资源运行开始前，维护者能确认 SatSubscription 连接到的是
 * testnet 上预期的服务，而不是只因为配置文件写了 testnet 就继续消费资金。
 *
 * 开始状态：resource-setup 已完成配置权限、S3 lease 和 WebSocket 健康握手，
 * 但尚未执行充值或收费业务。
 *
 * 成功标准：运行状态中的服务身份是合法压缩公钥，WebSocket 已验证；如果本轮
 * 明确要求 WebRTC Direct，则必须同时由资源层真实验证。这个 Journey 只证明
 * 连接身份边界，不把健康握手升级成“充值、消费和账本对账已完成”。
 *
 * 外部资源与收尾：只读取本轮 setup 写入的非敏感投影，不写服务端业务账本；
 * S3 lease 和其它真实资源由 resource-teardown 统一收尾。
 *
 * 覆盖需求：KM-SATSUB-001。
 */
test(JOURNEY_ID + "：确认真实 SatSubscription testnet 服务身份", async () => {
  const state = await readResourceRunState();
  expect(state, "SatSubscription 健康 Journey 必须依赖成功的 resource-setup").not.toBeNull();
  if (!state) throw new Error("真实资源运行状态不可用");

  expect(state.satSubscription.network).toBe("testnet");
  expect(state.satSubscription.websocketVerified).toBe(true);
  expect(state.satSubscription.servicePublicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/iu);

  const directRequired = process.env.KEYMASTER_E2E_REQUIRE_WEBRTC_DIRECT === "1";
  if (directRequired) {
    expect(state.satSubscription.webrtcDirectVerified, "显式要求 WebRTC Direct 时不能只通过 WebSocket 健康检查").toBe(true);
  }
});
