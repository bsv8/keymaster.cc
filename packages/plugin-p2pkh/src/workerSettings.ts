import type { BorrowedModuleFileStore, CoordinatorClientRequest, CoordinatorResponse, CoordinatorTaskSnapshot, WocService } from "@keymaster/contracts";
import { createP2pkhFileRepository } from "./storage/p2pkhFileRepository.js";
export interface WorkerSettingsDependencies {
  storage(): BorrowedModuleFileStore;
  session(): { sessionEpoch: string; activePublicKeyHex?: string };
  projection: { p2pkhSettings: { includeTestnet: boolean }; p2pkhProviderConfigs?: Record<string, Record<string, unknown>> };
  beforeWrite(): void;
  clearSnapshots(): void;
  reschedule(): Promise<void>;
  taskSnapshots(): CoordinatorTaskSnapshot[];
  publishSnapshot(event: { type: "background.snapshot.changed"; snapshots: CoordinatorTaskSnapshot[]; p2pkhSettings: { includeTestnet: boolean } }): void;
  woc(): WocService | undefined;
}

/** P2PKH owns persistence, validation and publication of its settings. */
export function createWorkerP2pkhSettings(deps: WorkerSettingsDependencies) {
  let p2pkhSettingOwner: string | undefined;
  let revision = 0;
  const repository = () => createP2pkhFileRepository(deps.storage());
/** 从 setting.json 载入运行时镜像；同 owner 只载入一次。 */
async function loadP2pkhSettingForOwner(ownerPublicKeyHex: string | undefined): Promise<void> {
  const owner = ownerPublicKeyHex?.trim().toLowerCase();
  if (!owner) {
    p2pkhSettingOwner = undefined;
    return;
  }
  if (p2pkhSettingOwner === owner) return;
  const generation = revision;
  const epoch = deps.session().sessionEpoch;
  try {
    const setting = await repository().readSetting();
    if (generation !== revision || deps.session().sessionEpoch !== epoch || deps.session().activePublicKeyHex?.toLowerCase() !== owner) throw new Error("P2PKH settings load became stale");
    deps.projection.p2pkhSettings = { includeTestnet: setting.includeTestnet };
    // 旧 providerConfigs 中的 junglebus 等配置已由解析器丢弃。
    deps.projection.p2pkhProviderConfigs = structuredClone(setting.providerConfigs);
    p2pkhSettingOwner = owner;
  } catch (error) {
    // 读取失败不能把用户设置清成默认；保持当前镜像并允许后续重试。
    console.warn("[p2pkh] load setting.json failed", error instanceof Error ? error.message : String(error));
  }
}

/** 锁屏 / 切 owner：运行时不保留上一个 owner 的偏好与内存快照。 */
function resetP2pkhSettingsRuntime(): void {
  revision += 1;
  p2pkhSettingOwner = undefined;
  deps.projection.p2pkhProviderConfigs = {};
  deps.projection.p2pkhSettings = { includeTestnet: false };
  deps.clearSnapshots();
}

/** 读-改-写 setting.json；failure 时调用方不得更新内存镜像。 */
async function writeP2pkhSettingFile(patch: {
  includeTestnet?: boolean;
  feeRateSatoshisPerKb?: Partial<Record<"low" | "medium" | "high", number>>;
  providerConfigs?: Record<string, Record<string, unknown>>;
}): Promise<void> {
  deps.beforeWrite();
  const generation = revision;
  const epoch = deps.session().sessionEpoch;
  const assertFresh = () => { if (generation !== revision || deps.session().sessionEpoch !== epoch) throw new Error("P2PKH settings write became stale"); };
  const store = repository();
  const current = await store.readSetting();
  assertFresh();
  await store.writeSetting({
    includeTestnet: patch.includeTestnet ?? current.includeTestnet,
    feeRateSatoshisPerKb: {
      ...current.feeRateSatoshisPerKb,
      ...(patch.feeRateSatoshisPerKb ?? {})
    },
    providerConfigs: patch.providerConfigs ?? current.providerConfigs,
  });
  assertFresh();
}

async function handleP2pkhSettingsUpdate(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.settings.update" }>
): Promise<CoordinatorResponse> {
  if (typeof request.settings.includeTestnet !== "boolean") {
    return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "Invalid P2PKH network settings" } };
  }
  if (request.settings.feeRateSatoshisPerKb !== undefined) {
    for (const value of Object.values(request.settings.feeRateSatoshisPerKb)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: "Invalid P2PKH fee settings" } };
      }
    }
  }
  // 先写 owner 的 setting.json,成功后才更新内存镜像。
  await writeP2pkhSettingFile({
    includeTestnet: request.settings.includeTestnet,
    ...(request.settings.feeRateSatoshisPerKb === undefined ? {} : { feeRateSatoshisPerKb: request.settings.feeRateSatoshisPerKb })
  });
  deps.projection.p2pkhSettings = { includeTestnet: request.settings.includeTestnet };
  await deps.reschedule();
  deps.publishSnapshot( {
    type: "background.snapshot.changed",
    snapshots: deps.taskSnapshots(),
    // 设置写入成功后随同快照广播，窗口无需再发起 RPC 才能收敛 testnet 开关。
    p2pkhSettings: deps.projection.p2pkhSettings,
  });
  return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "accepted" } };
}

async function handleP2pkhProviderConfigGet(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.provider-config.get" }>
): Promise<CoordinatorResponse> {
  // 只剩 WoC 一个 Provider；未知 provider id 直接拒绝。
  if (request.providerId !== "woc") {
    return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: `Unknown P2PKH provider: ${request.providerId}` } };
  }
  const persisted = deps.projection.p2pkhProviderConfigs?.woc;
  if (persisted) return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "ok" }, operationResult: { ...persisted } };
  const woc = deps.woc();
  if (woc) {
    const config = woc.getConfig();
    return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "ok" }, operationResult: { endpoint: config.baseUrl, requestsPerSecond: config.requestsPerSecond } };
  }
  return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "ok" }, operationResult: {} };
}

async function handleP2pkhProviderConfigUpdate(
  requestId: string,
  request: Extract<CoordinatorClientRequest, { kind: "p2pkh.provider-config.update" }>
): Promise<CoordinatorResponse> {
  if (request.providerId !== "woc") {
    return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "validation-error", message: `Unknown P2PKH provider: ${request.providerId}` } };
  }
  const previousConfigs = deps.projection.p2pkhProviderConfigs;
  const previousConfig = previousConfigs?.woc;
  const nextConfig = { ...(previousConfig ?? {}), ...request.config };
  const nextProviderConfigs = { ...(previousConfigs ?? {}), woc: nextConfig };
  const woc = deps.woc();
  const previousWocConfig = woc?.getConfig();
  try {
    // Persist the candidate before changing the running service. A failed
    // write must leave the running session untouched.
    await writeP2pkhSettingFile({ providerConfigs: nextProviderConfigs });
    if (woc) {
      const update: Partial<import("@keymaster/contracts").WocConfig> = {};
      if (typeof request.config.endpoint === "string" && request.config.endpoint.trim()) update.baseUrl = request.config.endpoint.trim();
      if (typeof request.config.requestsPerSecond === "number") update.requestsPerSecond = request.config.requestsPerSecond;
      if (Object.keys(update).length) woc.updateConfig(update);
    }
  } catch (error) {
    if (previousWocConfig) woc?.updateConfig?.(previousWocConfig);
    throw error;
  }
  deps.projection.p2pkhProviderConfigs = nextProviderConfigs;
  await deps.reschedule();
  return { requestId, sessionEpoch: deps.session().sessionEpoch, ack: { status: "accepted" } };
}

  return { load: loadP2pkhSettingForOwner, reset: resetP2pkhSettingsRuntime, write: writeP2pkhSettingFile, update: handleP2pkhSettingsUpdate, getProviderConfig: handleP2pkhProviderConfigGet, updateProviderConfig: handleP2pkhProviderConfigUpdate };
}
