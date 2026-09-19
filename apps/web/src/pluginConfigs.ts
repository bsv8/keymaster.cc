// apps/web/src/pluginConfigs.ts
// 装配层对各 plugin 的强类型配置注入（施工单 2026-07-08 001）。
//
// 设计缘由：
//   - 各 plugin 接收 Window runtime unit.config 的强类型字段；
//   - 装配层必须从一处集中导出（避免配置散落在 bootstrap）；
//   - 注入来源**唯一**是编译期常量 / 运行时 secret 注入；
//     plugin 自己**不**走隐式读取路径。

/**
 * PriceCast publisher 公钥 hex 来源：
 *
 * 优先级：
 *   1) `globalThis.__PRICECAST_PUBLISHER_PUBKEY__`（启动脚本注入 seed）；
 *   2) 缺省返回空串 → plugin 使用内置生产 PriceCast 发布器默认值；
 *      设置里可以登记更多发布服务器，运行时真值由 owner/App K-V 承担。
 *
 * 注：本文件里的 `__PRICECAST_PUBLISHER_PUBKEY__` 是**装配层**读
 * （用于桥接到 Window unit.config seed），不是 plugin 自己的入口。
 */
function readPublisherPublicKeyHex(): string {
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { __PRICECAST_PUBLISHER_PUBKEY__?: unknown })
      .__PRICECAST_PUBLISHER_PUBKEY__ === "string"
  ) {
    return (globalThis as { __PRICECAST_PUBLISHER_PUBKEY__?: string })
      .__PRICECAST_PUBLISHER_PUBKEY__ as string;
  }
  return "";
}

/**
 * 对 `bsv-price` plugin Window unit 的强类型配置注入；这里只是首次 seed，
 * 运行时真值由 BsvPrice owner/App K-V 接管。
 */
export const bsvPriceConfig = {
  pricePublisherPublicKeyHex: readPublisherPublicKeyHex()
};
