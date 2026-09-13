// apps/web/src/App.tsx
// 根组件：根据当前 path 决定渲染协议 popup / LockedShell / UnlockedShell。
// 设计缘由：Booting/Locked/Unlocked 三态由 runtime 决定，App 只负责调度。
//
// 硬切换 003：启动 loading 文案走 i18n。正常路径下 i18n service 在 host
// 创建时已存在；这里直接 useI18n 取 t() 即可。
//
// 施工单 001 收口（协议 V1 硬切换）：
//   - `/protocol/v1/popup` 是协议页的**唯一**入口。本 App 是这条路径
//     的唯一入口点；plugin-protocol 自身**不**再注册到 route.registry，
//     避免 "route.registry 路径 → 组件" 与 "App.tsx 特例直接渲染" 两套
//     真值并存。
//   - 钱包状态与协议路径互不干扰：uninitialized / locked / unlocked 都
//     能进入协议页；locked 态在 popup 内先解锁再继续当前请求。
//   - 其它路径保持原壳层逻辑（LockedShell / UnlockedShell）。

import { useEffect, useRef } from "react";
import type { ApplicationBootstrapSnapshot, ApplicationBootstrapStatus, VaultService, VaultStatus } from "@keymaster/contracts";
import {
  APPLICATION_BOOTSTRAP_READY_CAPABILITY,
  APPLICATION_BOOTSTRAP_RESOURCE_ID,
  KEYSPACE_SERVICE_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
} from "@keymaster/contracts";
import { useHasCapability, useOptionalCapability, useResource } from "webloom-framework/react";
import { useCurrentPath, useHostVersion, useI18n, usePluginHost, useRuntimeStatus } from "@keymaster/runtime";
import { StorageBucketManagerPage, StorageUnavailableGuard } from "@keymaster/platform-storage";
import { ProtocolPopupPage } from "@keymaster/plugin-protocol";
import { LockedShell } from "./shell/LockedShell.js";
import { UnlockedShell } from "./shell/UnlockedShell.js";
import { InitialSetupPage } from "./shell/InitialSetupPage.js";
import { StartupError, StartupPlaceholder } from "./shell/StartupPlaceholder.js";

/** 协议 popup 单一路由。 */
const PROTOCOL_POPUP_PATH = "/protocol/v1/popup";

function isProtocolPopupPath(path: string): boolean {
  // 单一路由，**不**做前缀匹配：未来若要加 /protocol/v1/popup/sub 时
  // 再扩展匹配函数；当前只允许这条精确路径走协议入口。
  return path === PROTOCOL_POPUP_PATH;
}

export function App() {
  const path = useCurrentPath();
  // 存储桶是系统最外层管理面；即使 Vault 尚未初始化、已锁定或存储
  // runtime 尚未 ready，也必须能进入这个页面处理桶目录。
  if (path === "/storage/buckets") return <StorageBucketManagerPage />;

  return <ApplicationBootstrapApp path={path} />;
}

interface ApplicationBootstrapAppProps {
  path: string;
}

/**
 * Resource definition 缺失时不渲染 useResource 子树。
 *
 * WebLoom 的 useResource 会通过 ensure() 启动资源；当 Storage bucket
 * 世代切换正在同步回收定义时，直接调用 ensure 会把一个可恢复的短暂窗口
 * 升级成 fatal。把检查放在独立组件层，既保留 Hook 规则，也让 /storage/buckets
 * 完全绕过应用启动资源。
 */
function ApplicationBootstrapApp({ path }: ApplicationBootstrapAppProps) {
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

  return <ApplicationBootstrapResourceApp path={path} host={host} hostVersion={hostVersion} bootstrap={bootstrap} />;
}

interface ApplicationBootstrapResourceAppProps {
  path: string;
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

function ApplicationBootstrapResourceApp({ path, host, hostVersion, bootstrap }: ApplicationBootstrapResourceAppProps) {
  // Storage unit 的 bucket-generation 重绑会先同步撤销旧 plugin scope，再
  // 异步安装新 scope；在这个受控窗口中 storage.status 定义暂时不存在。
  // 记住它曾经成功注册过，避免把生命周期重绑的 pending 窗口发布成
  // 终态错误；首次启动若从未注册过仍保持 fail-closed recovery page。
  const hadStorageStatusResource = useRef(false);
  const resourceArgs = [String(hostVersion)] as const;
  const snapshot = useResource<ApplicationBootstrapSnapshot>(
    host.resourceStore,
    APPLICATION_BOOTSTRAP_RESOURCE_ID,
    resourceArgs
  );

  const hasStorageController = useHasCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const hasVaultService = useHasCapability(VAULT_SERVICE_CAPABILITY);
  const hasKeyspaceService = useHasCapability(KEYSPACE_SERVICE_CAPABILITY);
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
    if (snapshot.status === "pending" || snapshot.status === "stale") return <StartupPlaceholder />;
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
  // 不能退回 InitialSetupPage。
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

  if (bootstrapSnapshot.phase === "storage-onboarding") {
    if (!bootstrapSnapshot.storageReady && hasStorageController) return <InitialSetupPage />;
    return (
      <StartupError
        title="存储启动状态不一致"
        message="存储初始化服务与启动快照不一致，未进入首次设置，以避免覆盖已有数据。请重试。"
        onRetry={() => retryStartup(host, bootstrap, resourceArgs)}
      />
    );
  }

  if (!bootstrapSnapshot.storageReady) {
    return (
      <StartupError
        title="存储启动状态不一致"
        message="应用快照尚未确认存储可用，不能继续装配钱包。请重试。"
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

  // Vault/Keyspace capability 和 vault-selection 都是读取 Vault 真值前的
  // 前置门禁。它们还未完成时只能显示启动占位，不能把缺能力误判为空 Vault。
  if (!bootstrapSnapshot.vaultCapabilityReady || !hasVaultService || !hasKeyspaceService) {
    return <StartupPlaceholder />;
  }
  if (!bootstrapSnapshot.vaultSelectionReady) return <StartupPlaceholder />;

  const vaultStatus = readVaultStatus(vaultService);
  if (vaultStatus === "booting" || vaultStatus === undefined) return <StartupPlaceholder />;

  // 协议 popup 是独立入口；在启动门禁已完成后继续交给 ProtocolPopupPage，
  // 包括它需要自己处理的 uninitialized/locked/unlocked 状态。
  if (vaultStatus === "uninitialized" && isProtocolPopupPath(path)) {
    return <StorageUnavailableGuard><RuntimeApp /></StorageUnavailableGuard>;
  }
  if (vaultStatus === "uninitialized") return <InitialSetupPage />;

  if (vaultStatus === "locked") {
    return <StorageUnavailableGuard><RuntimeApp initialVaultStatus="locked" /></StorageUnavailableGuard>;
  }

  const applicationReady = bootstrapSnapshot.phase === "connect-apps-ready"
    && bootstrapSnapshot.storageReady
    && bootstrapSnapshot.vaultCapabilityReady
    && bootstrapSnapshot.hasUnlockedActiveKey
    && bootstrapSnapshot.ownerAppsReady
    && bootstrapSnapshot.connectAppsReady
    && bootstrapSnapshot.assetWorkspaceReady
    && hasVaultService
    && hasKeyspaceService;
  if (!applicationReady) return <StartupPlaceholder message="正在准备应用…" />;
  return <StorageUnavailableGuard><RuntimeApp initialVaultStatus="unlocked" /></StorageUnavailableGuard>;
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
  /** Application bootstrap 已确认的同步 Vault 状态，用于首个业务 render。 */
  initialVaultStatus?: "locked" | "unlocked";
}

function RuntimeApp({ initialVaultStatus }: RuntimeAppProps = {}) {
  const { vault, ready } = useRuntimeStatus();
  const { t } = useI18n();
  const initialVaultStatusRef = useRef<RuntimeAppProps["initialVaultStatus"]>(initialVaultStatus);
  useEffect(() => {
    // 只用于跨过 useRuntimeStatus effect 的首个 render；后续 booting 必须
    // 重新显示启动占位，不能永久沿用旧状态。
    initialVaultStatusRef.current = undefined;
  }, []);
  const path = typeof window === "undefined" ? "/" : window.location.pathname;
  const effectiveVault = vault === "booting" && initialVaultStatusRef.current
    ? initialVaultStatusRef.current
    : vault;
  const effectiveReady = ready || initialVaultStatusRef.current !== undefined;

  if (!effectiveReady || effectiveVault === "booting") return <StartupPlaceholder message={t("common.status.loading", { defaultValue: "正在准备存储…" })} />;

  // 协议 popup 顶层特例：这是协议页的**唯一**入口点。
  // 钱包 locked / uninitialized / unlocked 都直接走协议页，
  // 协议 service 内部会自己处理 unlock / confirm 状态机。
  if (isProtocolPopupPath(path)) {
    return <ProtocolPopupPage />;
  }

  if (effectiveVault === "uninitialized" || effectiveVault === "locked") {
    return <LockedShell />;
  }

  return <UnlockedShell />;
}
