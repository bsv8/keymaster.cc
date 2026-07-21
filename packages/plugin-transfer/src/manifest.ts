// packages/plugin-transfer/src/manifest.ts
// 转账平台：注册 /transfer 页面、菜单、面包屑。
// 设计缘由：硬切换后 Transfer 不再依赖 vault / contacts / 具体资产插件。
// 平台只列 Offer 并挂载 provider Widget。
//
// 硬切换 003：route / menu / breadcrumb 走 I18nText。

import type {
  BusinessFeatureRegistry,
  BreadcrumbProvider,
  BreadcrumbRegistry,
  I18nPluginResources,
  PluginManifest,
  ResourceRegistry,
  RouteRegistry,
  TransferOffer,
  ActiveKeyState,
  KeyspaceService,
  TransferRegistry
  ,CollectibleRegistry
  ,CollectibleTransferRegistry
  ,CollectibleSummary
} from "@keymaster/contracts";
import { RESOURCE_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { router } from "@keymaster/runtime";
import { TransferPage } from "./TransferPage.js";
import { createTransferFeatureCapability } from "./transferFeature.js";

const transferResources: I18nPluginResources = {
  namespace: "transfer",
  resources: {
    en: {
      "transfer.action.toContact": "Transfer",
      "transfer.route.title": "Transfer",
      "transfer.menu.title": "Transfer",
      "transfer.crumb.wallet": "Wallets",
      "transfer.crumb.title": "Transfer",
      "transfer.page.desc.pickKey": "Transfer requires single mode.",
      "transfer.page.desc.noKey": "No usable key yet.",
      "transfer.page.desc.noProvider": "No transfer providers yet.",
      "transfer.page.desc.default": "Confirm the recipient first, then choose an asset type and verify its receiving form before submitting.",
      "transfer.page.assets": "Assets",
      "transfer.page.completed": "Completed",
      "transfer.page.recipientTarget": "Recipient",
      "transfer.page.recipient.title": "Recipient",
      "transfer.page.recipient.hint": "Contacts provide a public key. Each asset type projects it into a verifiable receiving form.",
      "transfer.page.recipient.publicKey": "Recipient public key",
      "transfer.page.recipient.change": "Change recipient",
      "transfer.page.recipient.placeholder": "Select a contact",
      "transfer.page.recipient.manualAddress": "For address-only assets, select the asset and enter the address there for verification.",
      "transfer.page.assetType.title": "Asset type",
      "transfer.page.assetType.targetHint": "Only assets that support this recipient public key are shown.",
      "transfer.page.assetType.manualHint": "After selecting an asset, verify its required recipient address or public key.",
      "transfer.section.mainnet": "Mainnet",
      "transfer.section.testnet": "Testnet",
      "transfer.section.otherAssets": "Other assets",
      "transfer.section.collectibles": "Collectibles",
      "transfer.section.collectiblesEmpty": "No collectible transfer supports this contact public key.",
      "transfer.feature.source": "Source",
      "transfer.feature.getQuote": "Get quote",
      "transfer.feature.submitting": "Submitting…",
      "transfer.feature.submit": "Submit transfer",
      "transfer.page.empty.allMode.title": "Pick a key",
      "transfer.page.empty.allMode.desc": "Pick a specific key in the topbar to start a transfer.",
      "transfer.page.empty.noKey.title": "No key yet",
      "transfer.page.empty.noKey.desc": "Import or create a key before starting a transfer.",
      "transfer.page.empty.noProvider.title": "No provider",
      "transfer.page.empty.noProvider.desc": "Install at least one transfer asset provider (e.g. plugin-p2pkh) for entries to appear.",
      "transfer.page.empty.picker": "No transfer assets available.",
      "transfer.page.err.providerGone": "This offer's provider is no longer available.",
      "transfer.page.err.widget": "This provider's transfer widget errored: ",
      "transfer.page.txidPrefix": " · txid ",
      "transfer.page.completionPrefix": " · completed "
      ,"transfer.page.invalidRecipient": "Invalid contact transfer target"
      ,"transfer.page.noRecipientProvider": "No asset can transfer to this contact public key"
      ,"transfer.page.clearRecipient": "Clear target and browse all assets"
    },
    "zh-CN": {
      "transfer.action.toContact": "转账",
      "transfer.route.title": "转账",
      "transfer.menu.title": "转账",
      "transfer.crumb.wallet": "钱包",
      "transfer.crumb.title": "转账",
      "transfer.page.desc.pickKey": "转账要求 single 模式。",
      "transfer.page.desc.noKey": "还没有可用的 key。",
      "transfer.page.desc.noProvider": "还没有可用的转账 provider。",
      "transfer.page.desc.default": "先确认收款人，再选择资产类型，并在提交前核对该资产的收款形式。",
      "transfer.page.assets": "资产",
      "transfer.page.completed": "已完成",
      "transfer.page.recipientTarget": "联系人目标",
      "transfer.page.recipient.title": "收款人",
      "transfer.page.recipient.hint": "联系人提供公钥；不同资产类型会将其投影为可核对的收款形式。",
      "transfer.page.recipient.publicKey": "收款人公钥",
      "transfer.page.recipient.change": "更换收款人",
      "transfer.page.recipient.placeholder": "选择联系人",
      "transfer.page.recipient.manualAddress": "若资产只接受地址，可先选择资产，再填写并核对地址。",
      "transfer.page.assetType.title": "资产类型",
      "transfer.page.assetType.targetHint": "仅显示支持该收款人公钥的资产。",
      "transfer.page.assetType.manualHint": "选择资产后，按该资产要求核对收款地址或公钥。",
      "transfer.section.mainnet": "主网",
      "transfer.section.testnet": "测试网",
      "transfer.section.otherAssets": "其它资产",
      "transfer.section.collectibles": "收藏品",
      "transfer.section.collectiblesEmpty": "暂无支持该联系人公钥的可转移收藏品",
      "transfer.feature.source": "来源",
      "transfer.feature.getQuote": "获取报价",
      "transfer.feature.submitting": "提交中…",
      "transfer.feature.submit": "提交转账",
      "transfer.page.empty.allMode.title": "请选择一个 key",
      "transfer.page.empty.allMode.desc": "到顶栏选择一把具体的 key 后再开始转账。",
      "transfer.page.empty.noKey.title": "还没有 key",
      "transfer.page.empty.noKey.desc": "导入或创建一个 key 后再开始转账。",
      "transfer.page.empty.noProvider.title": "没有 provider",
      "transfer.page.empty.noProvider.desc": "安装至少一个转账资产 provider（例如 plugin-p2pkh）后这里会出现选项。",
      "transfer.page.empty.picker": "当前没有可用的转账资产。",
      "transfer.page.err.providerGone": "该 Offer 对应的 provider 不再可用。",
      "transfer.page.err.widget": "该 provider 的转移 Widget 出现错误：",
      "transfer.page.txidPrefix": " · txid ",
      "transfer.page.completionPrefix": " · 完成于 "
      ,"transfer.page.invalidRecipient": "联系人转账目标无效"
      ,"transfer.page.noRecipientProvider": "当前没有可向该联系人公钥转账的资产"
      ,"transfer.page.clearRecipient": "清除目标，浏览全部资产"
    }
  }
};

export const transferPlugin: PluginManifest = {
  id: "transfer",
  name: "Transfer",
  description: "转账平台：聚合 Transfer Offer 并挂载 provider Widget。",
  meta: {
    kind: "platform",
    startup: "optional",
    defaultEnabled: true,
    canDisable: true,
    displayGroup: "platform",
    providesCapabilities: ["feature.transfer"]
  },
  i18n: transferResources,
  dependencies: [
    { capability: "transfer.registry", reason: "需要 transfer 注册表" },
    { capability: "keyspace.service", reason: "读取 active key 资源" },
    { capability: RESOURCE_REGISTRY_CAPABILITY, reason: "注册资源定义" },
    { capability: "route.registry", reason: "注册 Transfer 页面" },
    { capability: "business.registry", reason: "接入资产业务导航" },
    { capability: "breadcrumb.registry", reason: "注册 Transfer 面包屑" },
    { capability: "contacts.public-key-action.registry", reason: "注册联系人转账操作" }
    ,{ capability: "collectible.registry", reason: "汇总联系人目标收藏品" }
    ,{ capability: "collectible-transfer.registry", reason: "筛选收藏品转移 handler" }
  ],
  setup(ctx) {
    const contactActions = ctx.get<import("@keymaster/contracts").ContactPublicKeyActionRegistry>("contacts.public-key-action.registry");
    contactActions.register({
      id: "transfer.to-contact",
      label: { key: "transfer.action.toContact", fallback: "转账" },
      icon: "Send",
      order: 10,
      run: ({ publicKeyHex }) => router.push(`/transfer?recipientPublicKeyHex=${encodeURIComponent(publicKeyHex)}`)
    });
    ctx.provide("feature.transfer", createTransferFeatureCapability());
    const registry = ctx.get<TransferRegistry>("transfer.registry");
    const collectibles = ctx.get<CollectibleRegistry>("collectible.registry");
    const collectibleTransfers = ctx.get<CollectibleTransferRegistry>("collectible-transfer.registry");
    const keyspace = ctx.get<KeyspaceService>("keyspace.service");
    const resources = ctx.get<ResourceRegistry>(RESOURCE_REGISTRY_CAPABILITY);

    resources.register<Array<{ providerId: string; items: CollectibleSummary[]; error?: string }>, readonly string[]>({
      id: "transfer.recipient-collectibles",
      scope: "active-key",
      key: (_args, context) => ["transfer.recipient-collectibles", context.activePublicKeyHex ?? "none"],
      load: async (_args, context) => {
        if (!context.activePublicKeyHex) return [];
        return Promise.all(collectibles.list().map(async (provider) => {
        try {
          const items = await provider.listCollectibles();
          return {
            providerId: provider.id,
            items: items.filter((item) => collectibleTransfers.listSupporting({ providerId: provider.id, collectibleId: item.collectibleId }).length > 0)
          };
        } catch (err) {
          return { providerId: provider.id, items: [], error: err instanceof Error ? err.message : String(err) };
        }
        }));
      },
      subscribe: (_args, _context, invalidate) => {
        const offs = collectibles.list().map((provider) => provider.onChange(invalidate));
        const offKey = keyspace.onActiveKeyChanged(invalidate);
        return () => { offs.forEach((off) => off()); offKey(); };
      },
      invalidation: "immediate"
    });
    void collectibleTransfers;

    // 注册资源定义（硬切换 003）
    // transfer.offers：所有 provider 的 Transfer Offer 列表
    resources.register<TransferOffer[], readonly string[]>({
      id: "transfer.offers",
      scope: "global",
      key: () => ["transfer.offers"],
      load: async () => {
        const providers = registry.list();
        const out: TransferOffer[] = [];
        for (const p of providers) {
          try {
            const list = await p.listOffers();
            for (const o of list) out.push(o);
          } catch {
            // 单 provider 失败不影响其他
          }
        }
        return out;
      },
      subscribe: (_args, _ctx, invalidate) => {
        const providers = registry.list();
        const unsubs = providers.map((p) => p.onChange(invalidate));
        return () => { for (const off of unsubs) off(); };
      },
      equals: (prev, next) => {
        if (!prev || !next) return prev === next;
        if (prev.length !== next.length) return false;
        for (let i = 0; i < prev.length; i++) {
          const a = prev[i];
          const b = next[i];
          if (!a || !b) return a === b;
          if (a.id !== b.id) return false;
        }
        return true;
      },
      invalidation: "immediate"
    });

    resources.register<ActiveKeyState, readonly string[]>({
      id: "transfer.active-key",
      scope: "global",
      key: () => ["transfer.active-key"],
      load: async (_args, context) =>
        context.getCapability<KeyspaceService>("keyspace.service")?.active() ?? { activePublicKeyHex: undefined },
      subscribe: (_args, context, invalidate) =>
        context.getCapability<KeyspaceService>("keyspace.service")?.onActiveKeyChanged(invalidate) ?? (() => {}),
      equals: (a, b) => a?.activePublicKeyHex === b?.activePublicKeyHex,
      invalidation: "immediate"
    });

    const routes = ctx.get<RouteRegistry>("route.registry");
    routes.register({
      id: "transfer.page",
      path: "/transfer",
      label: { key: "transfer.route.title", fallback: "Transfer" },
      component: TransferPage
    });

    const business = ctx.get<BusinessFeatureRegistry>("business.registry");
    business.registerFeature("transfer", "assets", {
      id: "assets.transfer",
      label: { key: "transfer.menu.title", fallback: "Transfer" },
      order: 20,
      icon: "Send",
      entry: {
        path: "/transfer",
        routeId: "transfer.page",
        visibleWhen: ({ unlocked }) => unlocked
      }
    });

    const breadcrumbs = ctx.get<BreadcrumbRegistry>("breadcrumb.registry");
    const crumbProvider: BreadcrumbProvider = {
      id: "transfer.crumbs",
      order: 150,
      match: (path) => path === "/transfer",
      resolve: () => [
        { label: { key: "transfer.crumb.wallet", fallback: "Wallets" }, path: "/" },
        { label: { key: "transfer.crumb.title", fallback: "Transfer" } }
      ]
    };
    breadcrumbs.register(crumbProvider);
    return () => {
      // no-op
    };
  }
};
