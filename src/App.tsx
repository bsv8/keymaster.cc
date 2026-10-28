import { useRuntimeStatus } from "@keymaster/runtime/assembly";
// src/App.tsx
// 根组件只按真实启动/钱包状态渲染完整钱包，不设置独立协议页入口。
// 外部 App 打开钱包时也先完成正常创建/导入/解锁；连接由 Protocol 宿主接管，
// 不从 URL 开启旁路授权或第二套钱包界面。

import { useRef } from "react";
import type { ApplicationBootstrapSnapshot, ApplicationBootstrapStatus, VaultService, VaultStatus } from "@keymaster/contracts";
import {
  APPLICATION_BOOTSTRAP_READY_CAPABILITY,
  APPLICATION_BOOTSTRAP_RESOURCE_ID,
  VAULT_WALLET_STATE_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
} from "@keymaster/contracts";
import { useHasCapability, useOptionalCapability, useResource } from "webloom-framework/react";
import { useI18n } from "@keymaster/runtime";
import { useHostVersion, usePluginHost } from "@keymaster/runtime/assembly";
import { PAGE_UI_RENDERER_CAPABILITY, type PageUiRenderer, type PageFrameSlot } from "@keymaster/contracts";
import { useSyncExternalStore, useCallback, createContext, useContext, type ReactNode } from "react";
import { StartupError, StartupPlaceholder } from "./shell/StartupPlaceholder.js";

const ApplicationPages = createContext<PageUiRenderer | undefined>(undefined);
export function App() {
  const pages = useOptionalCapability(PAGE_UI_RENDERER_CAPABILITY);
  return <ApplicationPages.Provider value={pages}><ApplicationBootstrapApp /></ApplicationPages.Provider>;
}

/**
 * Resource definition 缺失时不渲染 useResource 子树。
 *
 * WebLoom 的 useResource 会通过 ensure() 启动资源；当 Storage bucket
 * 世代切换正在同步回收定义时，直接调用 ensure 会把一个可恢复的短暂窗口
 * 升级成 fatal。把检查放在独立组件层，既保留 Hook 规则，也让启动恢复
 * 页完全绕过应用启动资源。
 */
function ApplicationBootstrapApp() {
  const host = usePluginHost();
  const bootstrap = useOptionalCapability(APPLICATION_BOOTSTRAP_READY_CAPABILITY);
  const hostVersion = useHostVersion();
  const resourceArgs = [String(hostVersion)] as const;
  const hasBootstrapResource = host.resourceRegistry?.get(APPLICATION_BOOTSTRAP_RESOURCE_ID) !== undefined;

  if (!hasBootstrapResource) {
    return (
      <StartupError
        title="应用启动资源暂不可用"
        message="存储运行时正在恢复，启动状态资源尚未注册。请稍后重试。"
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }

  return <ApplicationBootstrapResourceApp host={host} hostVersion={hostVersion} bootstrap={bootstrap} />;
}

interface ApplicationBootstrapResourceAppProps {
  host: ReturnType<typeof usePluginHost>;
  hostVersion: number;
  bootstrap: ApplicationBootstrapStatus | undefined;
}

function retryStartup(
  host: ReturnType<typeof usePluginHost>,
  bootstrap: ApplicationBootstrapStatus | undefined,
  resourceArgs: readonly string[]
): void {
  // invalidate() 只触发已有定义的资源重新读取，不会像 ensure() 一样因
  // 定义暂缺而抛错；bootstrap.retry() 则沿用现有装配恢复语义。
  host.resourceStore.invalidate(APPLICATION_BOOTSTRAP_RESOURCE_ID, resourceArgs);
  void bootstrap?.retry().catch(() => undefined);
}

function ApplicationBootstrapResourceApp({ host, hostVersion, bootstrap }: ApplicationBootstrapResourceAppProps) {
  // Storage unit 的 bucket-generation 重绑会先同步撤销旧 plugin scope，再
  // 异步安装新 scope；在这个受控窗口中 storage.status 定义暂时不存在。
  // 记住它曾经成功注册过，避免把生命周期重绑的 pending 窗口发布成
  // 终态错误；首次启动若从未注册过仍保持 fail-closed recovery page。
  const hadStorageStatusResource = useRef(false);
  // Keep the existing unlock form mounted until this Window's business scopes
  // are ready. Worker unlock success alone must not insert a startup screen.
  const hasUnlockEntry = useRef(false);
  const resourceArgs = [String(hostVersion)] as const;
  const snapshot = useResource<ApplicationBootstrapSnapshot>(
    host.resourceStore,
    APPLICATION_BOOTSTRAP_RESOURCE_ID,
    resourceArgs
  );

  const hasStorageController = useHasCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const hasVaultService = useHasCapability(VAULT_SERVICE_CAPABILITY);
  const hasVaultWalletState = useHasCapability(VAULT_WALLET_STATE_CAPABILITY);
  const vaultService = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const hasStorageStatusResource = host.resourceRegistry?.get("storage.status") !== undefined;
  if (hasStorageStatusResource) hadStorageStatusResource.current = true;

  if (snapshot.status === "error") {
    return (
      <StartupError
        title="无法读取应用启动状态"
        message={snapshot.error?.message ?? "启动状态资源读取失败，请重试。"}
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }
  if (snapshot.status === "blocked") {
    return (
      <StartupError
        title="应用启动被阻止"
        message="启动状态资源被运行时阻止，应用尚未安全启动。请检查运行时后重试。"
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }

  // 初次 pending/stale 且没有 data 时，不能把“未知”折算为
  // storageReady=false；只有真实快照 ready 后才允许进入 setup。
  // 后续 pending/stale 若保留旧 data，则继续使用旧决定，避免刷新闪回首次设置。
  const bootstrapSnapshot = snapshot.data;
  if (!bootstrapSnapshot) {
    if (snapshot.status === "pending" || snapshot.status === "stale") {
      // hostVersion changes the resource arguments as plugins register. Its new
      // record has no data yet; preserve only the already mounted unlock entry,
      // never infer that business pages are ready from an older record.
      const currentVault = readVaultStatus(vaultService);
      if (hasUnlockEntry.current && hasStorageStatusResource && hasStorageController
        && hasVaultWalletState && (currentVault === "locked" || currentVault === "unlocked")) {
        return <RuntimeApp vaultStatus="locked" walletEntry />;
      }
      return <StartupPlaceholder />;
    }
    return (
      <StartupError
        title="应用启动状态为空"
        message="启动状态资源没有返回可用快照，无法安全判断钱包状态。请重试。"
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }

  // Resource Store 会把“已有 data 的加载失败”表示为 stale；明确的 error
  // 仍然不应悄悄使用旧决定，避免把一个真实读取错误隐藏成业务页面。
  if (bootstrapSnapshot.phase === "error") {
    return (
      <StartupError
        title="应用装配失败"
        message={bootstrapSnapshot.error ?? "应用装配失败，请重试。"}
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }

  // StorageUnavailableGuard 内部会读取 storage.status；先检查定义，
  // 避免短暂回收窗口中挂载子树并调用 ensure()。这条路径必须是恢复页，
  // 不能退回创建/导入入口。
  if (!hasStorageStatusResource) {
    if (hadStorageStatusResource.current) return <StartupPlaceholder />;
    return (
      <StartupError
        title="存储运行时正在恢复"
        message="存储状态资源暂不可用，已保留当前钱包状态；请稍后重试。"
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }

  // 本地钱包尚未就绪（uninitialized / corrupt / unsupported / degraded）：
  // 只有 uninitialized 是正常的「还没有钱包 Key」，可以提供创建或导入入口。
  // 其余状态必须由 StorageUnavailableGuard 呈现明确的恢复/升级说明，绝不能
  // 退回创建入口——那会用空钱包覆盖仍可能可恢复的本地数据。
  if (bootstrapSnapshot.phase === "storage-onboarding") {
    if (hasStorageController && hasVaultService) {
      return <ApplicationFrame slot="storage-guard"><ApplicationFrame slot="wallet-entry" /></ApplicationFrame>;
    }
    return <StartupPlaceholder />;
  }

  if (!bootstrapSnapshot.storageReady) {
    return (
      <StartupError
        title="本地钱包状态不一致"
        message="启动快照尚未确认本地钱包结构完整，不能继续装配。请重试。"
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }
  if (!hasStorageController) {
    return (
      <StartupError
        title="存储运行时未就绪"
        message="启动快照已确认存储可用，但存储控制能力尚未注册。请稍后重试。"
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }

  const vaultStatus = readVaultStatus(vaultService);
  if (vaultStatus === "booting" || vaultStatus === undefined) return <StartupPlaceholder />;

  // Vault 与 WalletState 是读取钱包真值和提供创建/解锁入口的前置条件。
  // 缺能力时只能停在占位页：不能把「capability 还没注册」误判成空钱包而
  // 渲染创建入口，那会诱导用户在错误的判断上覆盖数据。
  if (!bootstrapSnapshot.vaultCapabilityReady || !hasVaultService || !hasVaultWalletState) {
    return <StartupPlaceholder />;
  }
  // locked 不需要等 vault-selection 之后的业务插件装配：解锁页与创建/导入
  // 入口都只依赖第一阶段就已经注册的 Vault 能力。
  if (vaultStatus === "locked") {
    hasUnlockEntry.current = true;
    return <RuntimeApp vaultStatus="locked" walletEntry />;
  }
  if (vaultStatus === "uninitialized") {
    hasUnlockEntry.current = false;
    return <ApplicationFrame slot="wallet-entry" />;
  }

  const applicationReady = bootstrapSnapshot.phase === "connect-apps-ready"
    && bootstrapSnapshot.storageReady
    && bootstrapSnapshot.vaultCapabilityReady
    && bootstrapSnapshot.vaultSelectionReady
    && bootstrapSnapshot.hasUnlockedActiveKey
    && bootstrapSnapshot.ownerAppsReady
    && bootstrapSnapshot.connectAppsReady
    && hasVaultService
    && hasVaultWalletState;
  if (!applicationReady && hasUnlockEntry.current) {
    return <RuntimeApp vaultStatus="locked" walletEntry />;
  }
  if (!bootstrapSnapshot.vaultSelectionReady) return <StartupPlaceholder />;
  if (!applicationReady) return <StartupPlaceholder message="正在准备应用…" />;
  hasUnlockEntry.current = false;
  return <RuntimeApp vaultStatus="unlocked" />;
}

function readVaultStatus(vaultService: VaultService | undefined): VaultStatus | undefined {
  if (!vaultService) return undefined;
  try {
    return vaultService.status();
  } catch {
    return undefined;
  }
}

interface RuntimeAppProps {
  /** Root revalidates this decision on every render. Resource context rebinding
   * may temporarily leave vault.key-state pending, but must not undo it. */
  vaultStatus?: "locked" | "unlocked";
  walletEntry?: boolean;
}

function RuntimeApp({ vaultStatus, walletEntry }: RuntimeAppProps = {}) {
  const { vault, ready } = useRuntimeStatus();
  const { t } = useI18n();
  const effectiveVault = vaultStatus ?? vault;
  const effectiveReady = ready || vaultStatus !== undefined;

  if (walletEntry) {
    return <ApplicationFrame slot="storage-guard"><ApplicationFrame slot="wallet-entry" /></ApplicationFrame>;
  }
  if (!effectiveReady || effectiveVault === "booting") return <StartupPlaceholder message={t("common.status.loading", { defaultValue: "正在准备存储…" })} />;

  if (effectiveVault === "uninitialized" || effectiveVault === "locked") {
    return <ApplicationFrame slot="storage-guard"><ApplicationFrame slot="wallet-entry" /></ApplicationFrame>;
  }

  return <ApplicationFrame slot="storage-guard"><ApplicationFrame slot="unlocked-shell" /></ApplicationFrame>;
}

/** Trusted app selects a registered entry; Page retains every executable closure. */
function ApplicationFrame({ slot, children }: { slot: PageFrameSlot; children?: ReactNode }) {
  const pages = useContext(ApplicationPages);
  const subscribe = useCallback((listener: () => void) => pages?.subscribe(listener) ?? (() => {}), [pages]);
  const snapshot = useCallback(() => pages?.revision() ?? 0, [pages]);
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return pages ? <>{pages.renderFrame(slot, children)}</> : <StartupPlaceholder />;
}
