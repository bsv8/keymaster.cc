import type { I18nPluginResources } from "@keymaster/contracts";
export const collectibleTransferResources: I18nPluginResources = {
  namespace: "collectibleTransfer",
  resources: {
    en: {
      "collectibles.transfer.route.transfer": "Transfer collectible",
      "collectibles.transfer.page.title": "Transfer collectible",
      "collectibles.transfer.page.invalid.title": "Cannot start transfer",
      "collectibles.transfer.page.invalid.desc": "Missing providerId/collectibleId parameter.",
      "collectibles.transfer.observation.confirmed": "WOC confirmed",
      "collectibles.transfer.observation.unconfirmed": "WOC observed (unconfirmed)",
      "collectibles.transfer.page.invalidRecipient": "The contact transfer target is invalid",
      "collectibles.transfer.page.loading": "Loading…",
      "collectibles.transfer.page.error.title": "Failed to load collectible",
      "collectibles.transfer.page.missing.title": "This collectible is unavailable",
      "collectibles.transfer.page.missing.desc": "WOC's final state removed it from current holdings. Return and choose another item.",
      "collectibles.transfer.page.empty.title": "No transfer handler available"
    },
    "zh-CN": {
      "collectibles.transfer.route.transfer": "转移藏品",
      "collectibles.transfer.page.title": "转移藏品",
      "collectibles.transfer.page.invalid.title": "无法开始转移",
      "collectibles.transfer.page.invalid.desc": "缺少 providerId/collectibleId 参数。",
      "collectibles.transfer.observation.confirmed": "WOC 已确认",
      "collectibles.transfer.observation.unconfirmed": "WOC 已观察（未确认）",
      "collectibles.transfer.page.invalidRecipient": "联系人转账目标无效",
      "collectibles.transfer.page.loading": "正在加载…",
      "collectibles.transfer.page.error.title": "载入藏品失败",
      "collectibles.transfer.page.missing.title": "该藏品已不可用",
      "collectibles.transfer.page.missing.desc": "WOC 最终状态已将其从当前持仓中移除，请返回后重新选择。",
      "collectibles.transfer.page.empty.title": "暂无可用转移处理器"
    }
  }
};
