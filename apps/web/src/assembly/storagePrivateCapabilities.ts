import { definePrivateCapability } from "webloom-framework/advanced";
import { STORAGE_PRIVATE_BROWSE_CAPABILITY } from "@keymaster/platform-storage/assembly";

declare const __KEYMASTER_STORAGE_PRIVATE_GRANT__: string;

/**
 * 只由 Window/Worker 可信装配调用。每次构建产生随机授权材料，两端使用同一份；
 * 不进入领域设置、UI 数据或公共 capability。实例/连接票据由框架签发和撤销。
 */
export function storagePrivateCapabilities() {
  // Node 单元测试不启动真实浏览器装配，也不签发生产授权。
  if (typeof __KEYMASTER_STORAGE_PRIVATE_GRANT__ === "undefined") return [];
  return [definePrivateCapability({
    capability: STORAGE_PRIVATE_BROWSE_CAPABILITY,
    pluginId: "storage",
    unitId: "storage.window",
    grantId: __KEYMASTER_STORAGE_PRIVATE_GRANT__,
  })];
}

/** 私有客户端也明确绑定来源槽位，不在多个 Worker 中扫描第一个同名服务。 */
export function storagePrivateSlotBindings(slotId: string) {
  const capability = STORAGE_PRIVATE_BROWSE_CAPABILITY;
  return {
    [`storage\0storage.window\0${capability.kind}\0${capability.id}\0${capability.version}`]: slotId,
  };
}
