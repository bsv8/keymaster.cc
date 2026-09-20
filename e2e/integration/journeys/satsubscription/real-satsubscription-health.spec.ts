import { expect, test } from "@playwright/test";
import { readResourceRunState } from "../../support/resourceState.js";
import { REAL_SATSUBSCRIPTION_HEALTH_SCENARIO } from "../../support/scenarioMetadata.js";

export const JOURNEY_ID = REAL_SATSUBSCRIPTION_HEALTH_SCENARIO.id;
export const JOURNEY_METADATA = REAL_SATSUBSCRIPTION_HEALTH_SCENARIO;

/**
 * 业务目标：真实资源运行开始前，维护者能确认 resource-state 只携带了
 * SatSubscription 的公开配置投影，并且不会把它误读成实时连接成功。
 *
 * 开始状态：resource-setup 已完成配置权限、S3 lease 和 testnet 资金门禁，
 * 但没有由 Node 直接探测 Sat WebSocket/WebRTC，也尚未执行充值或收费业务。
 *
 * 成功标准：运行状态包含 setup 写入的 testnet 配置投影，两个探针标志明确为未验证。
 * 这里不检查远端服务身份，也不宣称连接成功；真实连接成功或失败必须由真实页面
 * Journey 的可见文本给出。本检查只证明状态文件没有把配置投影升级成“充值、消费
 * 和账本对账已完成”。
 *
 * 外部资源与收尾：只读取本轮 setup 写入的非敏感投影，不写服务端业务账本；
 * S3 lease 和其它真实资源由 resource-teardown 统一收尾。
 *
 * 覆盖需求：KM-SATSUB-001。
 */
test(JOURNEY_ID + "：读取 SatSubscription resource-state 配置投影（不代表实时连接）", async () => {
  const state = await readResourceRunState();
  expect(state, "SatSubscription 配置投影检查必须依赖成功的 resource-setup").not.toBeNull();
  if (!state) throw new Error("真实资源运行状态不可用");

  expect(state.satSubscription.network).toBe("testnet");
  expect(state.satSubscription.websocketVerified, "资源层禁止用 Node WebSocket 探针冒充页面结果").toBe(false);
  expect(state.satSubscription.webrtcDirectVerified, "资源层不以缺少 WebRTC 探针判定资源失败").toBe(false);
  expect(state.satSubscription.configuredSupplierPublicKeyHex, "配置投影必须保留供应商公钥字段").toBeTruthy();
});
