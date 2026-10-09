// 卖方发布渠道 → 发布可达性证据。
//
// 判据只有一个：**卖方运行单元现在真的在对外提供**。把它写成「配置里有
// sellerEnabled」会让一份从没被提供过的内容显示成「已发布」——那正是施工单要求
// 不能出现的情况。
//
// 这个模块是 manifest 装配时**直接调用**的那一份，不是照抄的判断逻辑：抄一份的
// 后果是测试全绿而生产仍按旧规则判可达。

import type { MsFileSellerPublicationEvidence } from "./msfileContentService.js";

/**
 * 从 MSFile 服务当前快照构造发布渠道证据。
 *
 * `service` 只要求 `getSettingsSnapshot`：可达性完全由卖方设置与运行单元状态决定，
 * 不需要也不应该读正文、下载缓存或任何可能不存在的来源。
 */
export function createMsFileSellerPublicationEvidence(service: {
  getSettingsSnapshot(): Promise<{
    sellerSettings: { sellerEnabled: boolean };
    sellerRuntimeStatus: import("@keymaster/contracts").MsFileSellerRuntimeStatus;
  }>;
}): MsFileSellerPublicationEvidence {
  return {
    async publicationEvidence() {
      const snapshot = await service.getSettingsSnapshot();
      const status = snapshot.sellerRuntimeStatus;
      if (!snapshot.sellerSettings.sellerEnabled) {
        return { published: false, sourceIds: [], detail: "卖方模式未开启：内容只保存在本地" };
      }
      // 配置问题与运行未就绪都不是「已发布」：说成已发布会掩盖真实缺口。
      switch (status) {
        case "configuration-error":
          return { published: false, sourceIds: [], detail: "卖方配置不完整（缺少本地来源或仲裁方），无法对外提供" };
        case "disabled":
          return { published: false, sourceIds: [], detail: "卖方运行单元未启用" };
        case "waiting-unlock":
        case "waiting-dependency":
          return { published: false, sourceIds: [], detail: `卖方运行单元尚未就绪（${status}）` };
        case "indexing":
          // 索引没完成时读者还取不到；说成已发布等于骗用户。
          return { published: false, sourceIds: [], detail: "卖方索引尚未完成，内容暂不可被读者获取" };
        case "degraded":
          return { published: false, sourceIds: [], detail: "卖方运行单元降级，可用性无保证" };
        case "ready":
        case "selling":
          return {
            published: true,
            sourceIds: ["seller:local-bitfs"],
            detail: status === "selling"
              ? "卖方模式正在对外提供，读者可经 BitFS 获取"
              : "卖方模式已就绪，读者可经 BitFS 获取",
          };
        default: {
          const exhaustive: never = status;
          throw new Error(`未知的卖方运行状态：${String(exhaustive)}`);
        }
      }
    },
  };
}