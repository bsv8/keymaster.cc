import { createElement, type ComponentType } from "react";
import { ScopedPluginConsumerProvider, useInstanceActive } from "@keymaster/runtime";
import {
  APPLICATION_AI_TOOLS_CAPABILITY, BREADCRUMB_REGISTRY_CAPABILITY, BUSINESS_REGISTRY_CAPABILITY, CENTRAL_STORAGE_DECLARATIONS,
  I18N_SERVICE_CAPABILITY, MSFILE_SERVICE_CAPABILITY, PAGE_UI_REGISTRY_CAPABILITY, PAGE_UI_RENDERER_CAPABILITY,
  STORAGE_KV_CLIENTS_CAPABILITY, VAULT_LOCAL_SECRET_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY,
  bindWalletIdentity, defineRuntimeUnitDependencies, type PluginContext, type PluginManifest, type PluginSetup, type WorkspaceResultView,
} from "@keymaster/contracts";
import { P2PKH_CAPABILITY } from "@keymaster/plugin-p2pkh";
import { createAiRepository } from "./repository.js";
import { AiRuntime } from "./runtime.js";
import { AiGate, AiSettings, Conversations, SessionActions, SessionList } from "./Ui.js";
import { Sandbox } from "./Sandbox.js";
import { object, string } from "./tools.js";
import "./styles.css";

export const aiPlugin = {
  id: "ai", name: "AI", description: "本地加密会话、浏览器直连供应商、动态工具和隔离的单文件结果。",
  units: [{ id: "ai.window", runtime: "window-main", scopeKind: "owner-session", provides: [],
    storages: [CENTRAL_STORAGE_DECLARATIONS.aiState],
    dependencies: defineRuntimeUnitDependencies([
      { capability: STORAGE_KV_CLIENTS_CAPABILITY, reason: "AI 本地加密数据" },
      { capability: VAULT_LOCAL_SECRET_CAPABILITY, reason: "按钱包身份封装密钥与会话" },
      { capability: VAULT_WALLET_STATE_CAPABILITY, reason: "绑定当前身份及运行世代" },
      { capability: PAGE_UI_REGISTRY_CAPABILITY, reason: "设置、会话和首启配置" },
      { capability: PAGE_UI_RENDERER_CAPABILITY, reason: "AI 结果工作区" },
      { capability: BUSINESS_REGISTRY_CAPABILITY, reason: "AI 设置入口" },
      { capability: BREADCRUMB_REGISTRY_CAPABILITY, reason: "AI 设置导航" },
      { capability: I18N_SERVICE_CAPABILITY, reason: "AI 页面语言上下文" },
      { capability: P2PKH_CAPABILITY, optional: true, reason: "钱包只读工具" },
      { capability: MSFILE_SERVICE_CAPABILITY, optional: true, reason: "BitFS 只读工具" },
      { capability: APPLICATION_AI_TOOLS_CAPABILITY, reason: "有效 Connect App 的动态工具" },
    ]),
  }],
} satisfies PluginManifest;

function owned<P extends object>(ctx: PluginContext, Component: ComponentType<P>, props: P) {
  return function Owned(extraProps: Partial<P>) {
    const active = useInstanceActive(ctx.consumer, ctx.scope);
    return active ? createElement(ScopedPluginConsumerProvider, { consumer: ctx.consumer, children: createElement(Component, { ...props, ...extraProps }) }) : null;
  };
}
export const aiSetup: PluginSetup = async ctx => {
  const state = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
  const identity = bindWalletIdentity(state);
  const assertActive = () => { ctx.scope.assertActive(); identity.assertActive(); };
  const repo = createAiRepository(ctx.capability(STORAGE_KV_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, CENTRAL_STORAGE_DECLARATIONS.aiState.purposeId), ctx.capability(VAULT_LOCAL_SECRET_CAPABILITY), assertActive);
  const page = ctx.capability(PAGE_UI_RENDERER_CAPABILITY);
  let result: { conversationId: string; view: WorkspaceResultView } | undefined;
  const runtime = new AiRuntime(repo, assertActive, (conversationId, artifact) => {
    assertActive();
    const Result = owned(ctx, Sandbox, { artifact, runtime, conversationId, onSubmit: payload => runtime.feedback(conversationId, artifact.id, payload), onBack: () => { runtime.select(conversationId); } });
    const view = page.openResult({ id: "ai-result", title: artifact.title, render: () => createElement(Result), onClose: () => { result = undefined; } });
    result = { conversationId, view };
  }, conversationId => {
    if (!conversationId || result?.conversationId === conversationId) result?.view.close();
  });
  const unsubscribe = state.subscribe(() => { if (!identity.isActive()) runtime.dispose(); });
  ctx.scope.onRevoke(() => { unsubscribe(); runtime.dispose(); });
  try { await runtime.initialize(); } catch (error) { runtime.dispose(); unsubscribe(); throw error; }
  assertActive();
  const p2pkh = () => ctx.optionalCapability(P2PKH_CAPABILITY);
  const bitfs = () => ctx.optionalCapability(MSFILE_SERVICE_CAPABILITY);
  runtime.tools.register({ id: "wallet_available_balance", source: "钱包", description: "查询 UTXO manager 当前可用余额投影（聪）；不主动刷新链。未知不是零。", parameters: object(), available: () => !!p2pkh(), execute: async () => {
    const service = p2pkh(); if (!service) throw new Error("钱包查询不可用");
    const result = await service.getAvailableUtxos();
    return result.hasResult ? { hasResult: true, availableSatoshis: result.utxos.reduce((sum, utxo) => sum + utxo.value, 0), syncedAt: result.syncedAt } : { hasResult: false, availableSatoshis: null };
  } });
  runtime.tools.register({ id: "wallet_history", source: "钱包", description: "分页查询当前钱包链上交易历史。cursor 为上一页 nextCursor，不主动刷新。", parameters: object({ cursor: string(1000), limit: { type: "integer", minimum: 1, maximum: 100 } }), available: () => !!p2pkh(), execute: async args => {
    const service = p2pkh(); if (!service) throw new Error("钱包查询不可用");
    return service.listHistory({ cursor: args.cursor as string | undefined, limit: args.limit as number | undefined });
  } });
  runtime.tools.register({ id: "wallet_local_transactions", source: "钱包", description: "分页查询当前钱包本地提交，默认只返回尚未链上收敛的记录。结果 unknown 不等于付款失败，不应自动重试。", parameters: object({ cursor: string(1000), limit: { type: "integer", minimum: 1, maximum: 100 }, includeResolved: { type: "boolean" } }), available: () => !!p2pkh(), execute: async args => {
    const service = p2pkh(); if (!service) throw new Error("钱包查询不可用");
    return service.listLocalTransactions({ cursor: args.cursor as string | undefined, limit: args.limit as number | undefined, includeResolved: args.includeResolved as boolean | undefined });
  } });
  runtime.tools.register({ id: "wallet_transaction", source: "钱包", description: "按 txid 查询交易详情，可能请求链上服务；不会签名或转账。", parameters: object({ txid: string(64) }, ["txid"]), available: () => !!p2pkh(), execute: async args => {
    if (!/^[0-9a-f]{64}$/i.test(args.txid as string)) throw new Error("txid 必须是 64 位十六进制");
    const service = p2pkh(); if (!service) throw new Error("钱包查询不可用");
    return await service.getTransactionDetail({ txid: args.txid as string }) ?? { found: false };
  } });
  runtime.tools.register({ id: "bitfs_settings", source: "BitFS", description: "查询 BitFS 当前配置与定价，不修改、不购买。", parameters: object(), available: () => !!bitfs(), execute: async () => {
    const service = bitfs(); if (!service) throw new Error("BitFS 不可用");
    return service.getSettingsSnapshot();
  } });
  runtime.tools.register({ id: "bitfs_stat", source: "BitFS", description: "按 Seed hash 查询本地与已配置 MSFile 供应商的文件名、大小、类型及可用性/报价；查询 hash 将发送给供应商，不读取付费内容或购买。", parameters: object({ seedHashHex: string(64) }, ["seedHashHex"]), available: () => !!bitfs(), execute: async (args, context) => {
    if (!/^[0-9a-f]{64}$/i.test(args.seedHashHex as string)) throw new Error("Seed hash 必须是 64 位十六进制");
    const service = bitfs(); if (!service) throw new Error("BitFS 不可用");
    return service.stat({ seedHashHex: args.seedHashHex as string, signal: context.signal });
  } });
  runtime.tools.register({ id: "bitfs_quotes", source: "BitFS", description: "读取已存在的 BitFS 内容需求和已验证报价；不发布需求，不启动购买。", parameters: object({ seedHashHex: string(64) }, ["seedHashHex"]), available: () => !!bitfs()?.getBitfsDemand, execute: async args => {
    if (!/^[0-9a-f]{64}$/i.test(args.seedHashHex as string)) throw new Error("Seed hash 必须是 64 位十六进制");
    const service = bitfs(); if (!service?.getBitfsDemand) throw new Error("BitFS 报价查询不可用");
    return service.getBitfsDemand(args.seedHashHex as string);
  } });
  runtime.tools.register({ id: "local_time", source: "实验", description: "返回设备当前 UTC 和本地时间及所在时区，不是可信外部授时。", parameters: object(), available: () => true, execute: async () => ({ utc: new Date().toISOString(), local: new Date().toString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
  runtime.tools.register({ id: "weather", source: "实验 · Open-Meteo", description: "按经纬度查询当前天气。请求位置将提交 Open-Meteo，不使用浏览器定位。", parameters: object({ latitude: { type: "number", minimum: -90, maximum: 90 }, longitude: { type: "number", minimum: -180, maximum: 180 } }, ["latitude", "longitude"]), available: () => true, execute: async (args, context) => {
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({ latitude: String(args.latitude), longitude: String(args.longitude), current: "temperature_2m,weather_code,wind_speed_10m" }).toString();
    return fetchJson(url, context.signal);
  } });
  runtime.tools.register({ id: "market_price", source: "实验 · CoinGecko", description: "查询 BSV、BTC、ETH 的美元参考价（可选 bitcoin-sv/bitcoin/ethereum）；可能限流，不保证实时性。", parameters: object({ coin: string(30) }, ["coin"]), available: () => true, execute: async (args, context) => {
    if (!["bitcoin-sv", "bitcoin", "ethereum"].includes(args.coin as string)) throw new Error("不支持该资产");
    return fetchJson(new URL(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(args.coin as string)}&vs_currencies=usd&include_last_updated_at=true`), context.signal);
  } });
  const appTools = ctx.capability(APPLICATION_AI_TOOLS_CAPABILITY);
  const registrations = new Map<string, { signature: string; remove(): void }>();
  const syncAppTools = () => {
    if (!identity.isActive()) return;
    const current = appTools.list();
    const ids = new Set(current.map(tool => tool.id));
    for (const [id, registered] of registrations) if (!ids.has(id)) { registered.remove(); registrations.delete(id); }
    for (const item of current) {
      const signature = JSON.stringify([item.connectionId, item.definition]);
      if (registrations.get(item.id)?.signature === signature) continue;
      registrations.get(item.id)?.remove();
      const remove = runtime.tools.register({
        id: item.id, source: `App · ${item.applicationName}`,
        description: item.definition.description,
        parameters: item.definition.parameters as unknown as Record<string, unknown>,
        available: () => appTools.list().some(tool => tool.id === item.id && tool.connectionId === item.connectionId),
        execute: async (args, context) => {
          if (!appTools.list().some(tool => tool.id === item.id && tool.connectionId === item.connectionId)) throw new Error("原 App 工具连接已失效，请刷新工具");
          return appTools.invoke(item.id, args, context.signal);
        },
      });
      registrations.set(item.id, { signature, remove });
    }
  };
  const offTools = runtime.tools.subscribe(runtime.changed);
  const offApps = appTools.subscribe(syncAppTools);
  ctx.scope.onRevoke(() => { offApps(); offTools(); registrations.clear(); });
  syncAppTools();
  const ui = ctx.capability(PAGE_UI_REGISTRY_CAPABILITY).bind(ctx.consumer, ctx.scope).view;
  for (const [slot, Component] of [["ai-session-actions", SessionActions], ["ai-session-list", SessionList], ["ai-conversations", Conversations]] as const) {
    const View = owned(ctx, Component, { runtime });
    ui.register({ id: slot, kind: "frame", slot, label: "AI", render: () => createElement(View) });
  }
  const Settings = owned(ctx, AiSettings, { runtime });
  ui.register({ id: "ai.settings", kind: "page", path: "/settings/ai", label: "AI", settingsPlacement: "embedded", render: () => createElement(Settings) });
  const Gate = owned(ctx, AiGate, { runtime, children: undefined as import("react").ReactNode });
  ui.register({ id: "ai.onboarding", kind: "frame", slot: "ai-onboarding", label: "AI", render: location => createElement(Gate, { children: location.children }) });
  ctx.capability(BUSINESS_REGISTRY_CAPABILITY).registerFeature("ai", "settings", { id: "ai.settings", label: "AI", order: 25, icon: "Sparkles", entry: { path: "/settings/ai", routeId: "ai.settings" } });
  ctx.capability(BREADCRUMB_REGISTRY_CAPABILITY).register({ id: "ai.settings", order: 100, match: path => path === "/settings/ai", resolve: () => [{ label: "设置" }, { label: "AI" }] });
  return () => { unsubscribe(); runtime.dispose(); };
};
async function fetchJson(url: URL, signal: AbortSignal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
  if (!response.ok) throw new Error(`外部 API 请求失败（HTTP ${response.status}）`);
  return response.json();
}
