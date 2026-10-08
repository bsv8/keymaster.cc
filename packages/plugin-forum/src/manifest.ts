// Forum 插件装配。
//
// 运行单元：Window-only。这个版本没有把 Forum 放进 owner-session Worker，
// 理由是浏览器里必须运行的部分（libp2p lane、HTTPS 传输、Markdown renderer、
// 资源 URL）本来就在 Window，而且：
//   - 私钥边界不依赖单元归属。`ActiveKeyCrypto` 在 Window 里也是 Coordinator
//     crypto RPC 的客户端，签名请求走 MessagePort，私钥始终留在 Worker；
//   - Forum 的配置、索引缓存与发布任务都在受限 owner 文件句柄里，跨页面状态
//     通过订阅而不是跨 Runtime 调用。
//
// 依赖全部是既有 capability：Vault 提供受控签名与身份，MSFile 提供内容，P2PKH
// 提供资金与广播，Window P2P 提供唯一 Host 与 lane。Forum 不新建其中任何一个。

import {
  BREADCRUMB_REGISTRY_CAPABILITY,
  BUSINESS_REGISTRY_CAPABILITY,
  CENTRAL_STORAGE_DECLARATIONS,
  FORUM_SERVICE_CAPABILITY,
  I18N_SERVICE_CAPABILITY,
  MSFILE_CONTENT_CAPABILITY,
  OWNED_RESOURCE_ACCESS_CAPABILITY,
  P2PKH_FUNDING_CAPABILITY,
  P2PKH_PROTOCOL_SPEND_CAPABILITY,
  P2PKH_SUBMISSION_OBSERVER_CAPABILITY,
  PAGE_UI_REGISTRY_CAPABILITY,
  PROTECTED_OUTPOINT_REGISTRY_CAPABILITY,
  RESOURCE_REGISTRY_CAPABILITY,
  STORAGE_FILE_CLIENTS_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
  VAULT_WALLET_STATE_CAPABILITY,
  WINDOW_P2P_EXECUTOR_CAPABILITY,
  WOC_CAPABILITY,
  capabilityDescriptor,
  defineRuntimeUnitDependencies,
  type ActiveKeyCrypto,
  type PluginContext,
  type PluginManifest,
  type PluginSetup,
  type BsvNetwork,
  type ForumBroadcastState,
  type ForumService,
  type ProtocolSubmissionObservation,
  type WocService,
} from "@keymaster/contracts";
import { createElement, type ReactNode } from "react";

import { createForumService, setForumFundingSource, type ForumFundingSource } from "./domain/forumService.js";
import { ForumTrustError } from "./domain/rootTrust.js";
import { createForumFundingSource } from "./domain/forumFundingSource.js";
import { ForumP2pLane } from "./network/forumP2pLane.js";
import { createForumRepository } from "./storage/forumRepository.js";
import { forumResources } from "./resources.js";
import { ForumResourceProvider, type ForumUiContextValue } from "./ForumResourceContext.js";
import { ForumBoardPage, ForumHomePage, ForumPostPage, ForumPostsPage, ForumPublishPage } from "./pages.js";

export const FORUM_PLUGIN_ID = "forum";

/** Forum 仓储的存储 purpose；空串表示 `forum/` 模块根，与中央声明一致。 */
const FORUM_STORAGE_PURPOSE = "";

const forumPluginDefinition = {
  id: FORUM_PLUGIN_ID,
  name: "Forum",
  description: "BSV8 Forum 客户端：索引浏览、MSFile 正文阅读与符合协议的签名发布。",
  units: [
    {
      id: "forum.window",
      runtime: "window-main",
      scopeKind: "owner-session",
      provides: [capabilityDescriptor(FORUM_SERVICE_CAPABILITY)],
      // Forum 只存配置、根验证证据、索引缓存、阅读位置、展示投影与发布任务；
      // 正文本体在 MSFile，不在这里。
      storage: CENTRAL_STORAGE_DECLARATIONS.forumFiles,
      dependencies: defineRuntimeUnitDependencies([
        { capability: STORAGE_FILE_CLIENTS_CAPABILITY, sourceRuntime: "window-main", reason: "论坛配置与发布任务的受限文件句柄" },
        { capability: VAULT_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "受控 active key 签名与 owner 身份" },
        { capability: VAULT_WALLET_STATE_CAPABILITY, sourceRuntime: "window-main", reason: "锁定/切 Key 时中止连接与新签名" },
        { capability: MSFILE_CONTENT_CAPABILITY, sourceRuntime: "window-main", reason: "正文与附件的统一获取、验证与读取" },
        { capability: P2PKH_PROTOCOL_SPEND_CAPABILITY, optional: true, sourceRuntime: "window-main", reason: "无找零构建与统一广播" },
        { capability: P2PKH_FUNDING_CAPABILITY, optional: true, sourceRuntime: "window-main", reason: "专用资金 UTXO 的选币、准备交易与保护登记" },
        { capability: P2PKH_SUBMISSION_OBSERVER_CAPABILITY, optional: true, sourceRuntime: "window-main", reason: "恢复时对账同一个持久提交，不重建不二次派发" },
        { capability: WOC_CAPABILITY, optional: true, reason: "按 (network, txid) 取创世根 raw 与链上/广播对账证据" },
        { capability: WINDOW_P2P_EXECUTOR_CAPABILITY, optional: true, reason: "WSS 与 WebRTC Direct 走唯一 Window Host 的 forum lane" },
        { capability: RESOURCE_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册论坛资源投影" },
        { capability: OWNED_RESOURCE_ACCESS_CAPABILITY, reason: "UI 读取所属实例资源" },
        { capability: PAGE_UI_REGISTRY_CAPABILITY, sourceRuntime: "window-main", reason: "注册论坛页面" },
        { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "论坛页面包屑" },
        { capability: BUSINESS_REGISTRY_CAPABILITY, reason: "首页业务导航入口" },
        { capability: I18N_SERVICE_CAPABILITY, sourceRuntime: "window-main", reason: "界面文案" },
      ]),
    },
  ],
  i18n: forumResources,
} satisfies PluginManifest;

export const forumPlugin = forumPluginDefinition;

/** 装配：注册 lane、提供 Forum 服务与页面；teardown 释放全部资源。 */
const setup: PluginSetup = (ctx: PluginContext) => {
  const walletState = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
  const vault = ctx.capability(VAULT_SERVICE_CAPABILITY);
  const content = ctx.capability(MSFILE_CONTENT_CAPABILITY);
  const store = ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, FORUM_STORAGE_PURPOSE);
  // 创世 raw 与链上/广播对账都走既有链数据源；缺席时这两项能力明确不可用，
  // 不回退去请求论坛站点（它没有这个接口）。
  const woc = ctx.optionalCapability(WOC_CAPABILITY);

  const lane = new ForumP2pLane();
  // Forum 只注册自己的 lane；公共 Host、lease 与身份 signer 由 Window P2P 拥有。
  const offLane = ctx.capability(WINDOW_P2P_EXECUTOR_CAPABILITY).register(lane);
  const deps = { submissionObserver: ctx.optionalCapability(P2PKH_SUBMISSION_OBSERVER_CAPABILITY) };

  // 当前 owner 的受控签名能力；锁定或切 Key 后必须重新取得，不复用旧授权句柄。
  let activeCrypto: ActiveKeyCrypto | undefined;
  let activeCryptoOwner: string | undefined;

  const currentOwner = (): string => {
    const owner = walletState.snapshot().activePublicKeyHex;
    if (typeof owner !== "string" || owner.length === 0) {
      throw new ForumOwnerUnavailableError();
    }
    return owner.toLowerCase();
  };

  const releaseCrypto = (reason: string): void => {
    activeCrypto?.dispose(reason);
    activeCrypto = undefined;
    activeCryptoOwner = undefined;
  };

  const service = createForumService({
    repository: createForumRepository(store),
    content,
    async activeCrypto(): Promise<ActiveKeyCrypto> {
      const owner = currentOwner();
      if (activeCrypto !== undefined && activeCryptoOwner === owner) return activeCrypto;
      releaseCrypto("owner-changed");
      const crypto = await vault.createActiveKeyCrypto(owner);
      activeCrypto = crypto;
      activeCryptoOwner = owner;
      return crypto;
    },
    ownerPublicKeyHex: currentOwner,
    protocolSpend: () => ctx.optionalCapability(P2PKH_PROTOCOL_SPEND_CAPABILITY),
    // Window 内直接调用同一个 lane 实例：Host 的取得、身份 pin 与超时策略只有一份。
    dispatchP2p: (operation, signal) => lane.call(operation as Parameters<ForumP2pLane["call"]>[0], signal),
    fetchRootRaw: (input, options) => fetchForumRootRaw(input, woc, options?.signal),
    sessionEpoch: () => walletState.snapshot().sessionEpoch,
    observeChain: async (network, txid, signal) => {
      // 链上观测来自链数据源；不可用时保持上一份证据而不是猜。
      if (woc === undefined) return "unknown";
      const observation = await woc.getTransactionObservation(network, txid, signal === undefined ? {} : { signal });
      // 链上「已确认」与 Forum「已确认索引」是两件事，这里只表达前者。
      if (observation.observation === "confirmed") return "confirmed";
      if (observation.observation === "unconfirmed") return "mempool";
      return "absent";
    },
    observeBroadcast: async ({ ownerPublicKeyHex, network, txid, submissionId }) => {
      const control = deps.submissionObserver;
      if (control === undefined) return "unknown";
      return mapSubmissionObservation(
        await control.observeProtocolSubmission({ ownerPublicKeyHex, network, txid, submissionId }),
      );
    },
  });

  // 专用资金来源：选币、资金准备交易与专用 UTXO 记账都归 P2PKH，
  // Forum 只消费结果并按 outpoint 花费。
  setForumFundingSource(() => createForumFundingSource({
    protocolSpend: () => ctx.optionalCapability(P2PKH_PROTOCOL_SPEND_CAPABILITY),
    funding: () => ctx.optionalCapability(P2PKH_FUNDING_CAPABILITY),
    protectedOutpoints: ctx.capability(PROTECTED_OUTPOINT_REGISTRY_CAPABILITY),
    woc,
    repository: createForumRepository(store),
  }));

  ctx.provide(FORUM_SERVICE_CAPABILITY, service);
  const offUi = registerForumPages(ctx, service);
  // 锁定、切 Key 或 Scope 撤销后立刻释放签名能力；已有发布任务保留公开证据，
  // 恢复时重新取得当前身份的能力，不恢复旧授权句柄。
  const offWallet = walletState.subscribe(() => {
    if (activeCryptoOwner !== undefined && activeCryptoOwner !== safeOwner(walletState.snapshot().activePublicKeyHex)) {
      releaseCrypto("owner-changed");
    }
  });

  return () => {
    setForumFundingSource(undefined);
    releaseCrypto("plugin-disposed");
    offWallet();
    offUi();
    offLane();
  };
};

/**
 * 按 (network, txid) 取创世根 raw。
 *
 * 来源是链数据源而不是论坛站点：服务端只注册 `/roundtrip` 与 `/readyz`，向它
 * GET 拿不到交易。返回的 hex 会被 `verifyForumRoot` 独立核对 txid、输出结构与
 * forumSig，因此数据源同样不替代身份。
 */
async function fetchForumRootRaw(
  input: { readonly network: BsvNetwork; readonly txid: string },
  woc: Pick<WocService, "getRawTransaction"> | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (woc?.getRawTransaction === undefined) {
    throw new ForumTrustError("chain-source-unavailable", "链数据源不可用，无法按 (network, txid) 取得创世 raw");
  }
  const rawTxHex = await woc.getRawTransaction(input.network, input.txid, signal === undefined ? {} : { signal });
  const trimmed = rawTxHex.trim();
  if (!/^[0-9a-fA-F]+$/.test(trimmed) || trimmed.length % 2 !== 0) {
    throw new ForumTrustError("root-raw-format", `链数据源返回的 raw 不是 hex：${trimmed.slice(0, 32)}…`);
  }
  const out = new Uint8Array(trimmed.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(trimmed.slice(index * 2, index * 2 + 2), 16);
  if (out.byteLength === 0 || out.byteLength > 1024 * 1024) {
    throw new ForumTrustError("root-raw-size", `根 raw 体积异常：${out.byteLength} 字节`);
  }
  return out;
}

/**
 * 提交观测 → 发布广播状态。
 *
 * `dropped` 与 `rejected` 是各自的终态：都意味着这笔交易没有留在网络里，但原因
 * 不同，界面必须区分，不能都折成「已观测未确认」。
 */
function mapSubmissionObservation(observation: ProtocolSubmissionObservation): ForumBroadcastState {
  switch (observation) {
    case "not-dispatched":
      return "definitely-not-dispatched";
    case "dispatched":
      return "dispatched";
    case "observed-unconfirmed":
      return "observed-unconfirmed";
    case "observed-confirmed":
      return "observed-confirmed";
    case "dropped":
    case "rejected":
      return "not-dispatched";
    default:
      return "unknown";
  }
}

function safeOwner(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : undefined;
}

export class ForumOwnerUnavailableError extends Error {
  constructor() {
    super("当前钱包未解锁，没有 Forum 身份");
    this.name = "ForumOwnerUnavailableError";
  }
}


/**
 * 注册论坛页面。
 *
 * 路由字面量写在 setup 里，因此页面注册与静态路由盘点读到的是同一份字符串。
 * 每个页面都包在 `ForumResourceProvider` 里，资源与订阅因此绑定该页面 Scope：
 * 退出或身份失效时随之释放。
 */
function registerForumPages(ctx: PluginContext, forum: ForumService): () => void {
  // UI 使用当前 Scope 下的服务实例，而不是装配时闭包里的那一份。
  const scoped = ctx.capability(FORUM_SERVICE_CAPABILITY);
  const pages = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
  const business = ctx.capability(BUSINESS_REGISTRY_CAPABILITY);
  const breadcrumbs = ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY);

  /** 页面外壳：把 Scope 绑定的服务注入组件树。 */
  function shell(render: (params: Readonly<Record<string, string>>) => ReactNode) {
    return function BoundForumPage(location: { readonly params: Readonly<Record<string, string>> }): ReactNode {
      const value: ForumUiContextValue = { forum: scoped };
      return createElement(ForumResourceProvider, { value, children: render(location.params) });
    };
  }

  // 逐个注册；注销按 id 反序进行，先注销依赖面更窄的页面。
  pages.register({
    kind: "page", id: "forum.home", path: "/forum", order: 700,
    label: { key: "forum.page.title", fallback: "Forum" },
    render: shell(() => createElement(ForumHomePage)),
  });
  pages.register({
    kind: "page", id: "forum.boards", path: "/forum/:configId", order: 701,
    label: { key: "forum.list.boards", fallback: "Boards" },
    render: shell((params) =>
      params.configId === undefined ? createElement(ForumHomePage) : createElement(ForumBoardPage, { configId: params.configId })),
  });
  pages.register({
    kind: "page", id: "forum.posts", path: "/forum/:configId/board/:boardTxid", order: 702,
    label: { key: "forum.list.posts", fallback: "Posts" },
    render: shell((params) =>
      params.configId === undefined || params.boardTxid === undefined
        ? createElement(ForumHomePage)
        : createElement(ForumPostsPage, { configId: params.configId, boardTxid: params.boardTxid })),
  });
  pages.register({
    kind: "page", id: "forum.post", path: "/forum/:configId/post/:txid", order: 703,
    label: { key: "forum.list.replies", fallback: "Replies" },
    render: shell((params) =>
      params.configId === undefined || params.txid === undefined
        ? createElement(ForumHomePage)
        : createElement(ForumPostPage, { configId: params.configId, txid: params.txid })),
  });
  pages.register({
    kind: "page", id: "forum.publish", path: "/forum/:configId/publish/:txid", order: 704,
    label: { key: "forum.reply.title", fallback: "Reply" },
    render: shell((params) =>
      params.configId === undefined || params.txid === undefined
        ? createElement(ForumHomePage)
        : createElement(ForumPublishPage, { configId: params.configId, targetTxid: params.txid })),
  });

  breadcrumbs.register({
    id: "forum.crumbs",
    order: 700,
    match: (path) => path.startsWith("/forum"),
    resolve: () => [{ label: { key: "forum.page.title", fallback: "Forum" } }],
  });
  business.registerFeature("forum", "home", {
    id: "forum.home",
    label: { key: "forum.page.title", fallback: "Forum" },
    order: 700,
    entry: { path: "/forum", routeId: "forum.home", visibleWhen: ({ unlocked }: { unlocked: boolean }) => unlocked },
  });

  return () => {
    for (const id of ["forum.publish", "forum.post", "forum.posts", "forum.boards", "forum.home"]) pages.unregister(id);
    business.unregisterFeature("forum.home");
    // breadcrumb provider 由 Scope 生命周期托管，没有显式注销入口。
    void forum;
  };
}

export const forumSetup = setup;