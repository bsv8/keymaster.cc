import { definePrivateCapability } from "webloom-framework/advanced";
import { MARKET_PRIVATE_COMMAND, MARKET_PRIVATE_EVENTS } from "@keymaster/plugin-market/assembly";

declare const __KEYMASTER_MARKET_PRIVATE_GRANT__: string;

/**
 * 只由 Window/Worker 可信装配调用。每次构建产生随机授权材料，两端使用同一份；
 * 不进入领域设置、UI 数据或公共 capability。实例/连接票据由框架签发和撤销。
 */
export function marketPrivateCapabilities() {
  // Node 单元测试不启动真实浏览器装配，也不签发生产授权。
  if (typeof __KEYMASTER_MARKET_PRIVATE_GRANT__ === "undefined") return [];
  return [MARKET_PRIVATE_COMMAND, MARKET_PRIVATE_EVENTS].map(capability => definePrivateCapability({
    capability,
    pluginId: "apps",
    unitId: "apps.window",
    grantId: __KEYMASTER_MARKET_PRIVATE_GRANT__,
  }));
}

/** 私有客户端也明确绑定来源槽位，不在多个 Worker 中扫描第一个同名服务。 */
export function marketPrivateSlotBindings(slotId: string) {
  return Object.fromEntries([MARKET_PRIVATE_COMMAND, MARKET_PRIVATE_EVENTS].map(capability =>
    [`apps\0apps.window\0${capability.kind}\0${capability.id}\0${capability.version}`, slotId]));
}
