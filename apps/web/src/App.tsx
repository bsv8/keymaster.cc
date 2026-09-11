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

import type { ApplicationBootstrapSnapshot } from "@keymaster/contracts";
import {
  APPLICATION_BOOTSTRAP_READY_CAPABILITY,
  APPLICATION_BOOTSTRAP_RESOURCE_ID,
  KEYSPACE_SERVICE_CAPABILITY,
  STORAGE_RUNTIME_CONTROLLER_CAPABILITY,
  VAULT_SERVICE_CAPABILITY,
} from "@keymaster/contracts";
import { useHasCapability, useOptionalCapability, useResourceSelector } from "webloom-framework/react";
import { useCurrentPath, useHostVersion, useI18n, usePluginHost, useRuntimeStatus } from "@keymaster/runtime";
import { StorageBucketManagerPage, StorageUnavailableGuard } from "@keymaster/platform-storage";
import { ProtocolPopupPage } from "@keymaster/plugin-protocol";
import { LockedShell } from "./shell/LockedShell.js";
import { UnlockedShell } from "./shell/UnlockedShell.js";
import { InitialSetupPage } from "./shell/InitialSetupPage.js";

/** 协议 popup 单一路由。 */
const PROTOCOL_POPUP_PATH = "/protocol/v1/popup";

function isProtocolPopupPath(path: string): boolean {
  // 单一路由，**不**做前缀匹配：未来若要加 /protocol/v1/popup/sub 时
  // 再扩展匹配函数；当前只允许这条精确路径走协议入口。
  return path === PROTOCOL_POPUP_PATH;
}

export function App() {
  const host = usePluginHost();
  const hasStorageController = useHasCapability(STORAGE_RUNTIME_CONTROLLER_CAPABILITY);
  const hasVaultService = useHasCapability(VAULT_SERVICE_CAPABILITY);
  const hasKeyspaceService = useHasCapability(KEYSPACE_SERVICE_CAPABILITY);
  const vaultService = useOptionalCapability(VAULT_SERVICE_CAPABILITY);
  const bootstrap = useOptionalCapability(APPLICATION_BOOTSTRAP_READY_CAPABILITY);
  const hostVersion = useHostVersion();
  const fallbackBootstrapSnapshot: ApplicationBootstrapSnapshot = {
    // Resource 首次加载完成前只能显示门禁页。不能把 pending 资源伪装成
    // final-ready，否则 capability 刚注入而 bootstrap 状态尚未发布时，
    // React 会提前进入 RuntimeApp。
    phase: hasStorageController ? "vault-selection" : "storage-onboarding",
    storageReady: false,
    vaultCapabilityReady: hasVaultService && hasKeyspaceService,
    hasUnlockedActiveKey: false,
    vaultSelectionReady: hasVaultService && hasKeyspaceService,
    ownerAppsReady: false,
    connectAppsReady: false,
    assetWorkspaceReady: false
  };
  const bootstrapSnapshot = useResourceSelector<ApplicationBootstrapSnapshot, ApplicationBootstrapSnapshot>(
    host.resourceStore,
    APPLICATION_BOOTSTRAP_RESOURCE_ID,
    // Keyspace capability/active-key 变化会刷新 Resource Store 绑定。把 Host
    // 修订作为订阅世代传给 Hook，确保 React 从旧 record 迁移到新 record；
    // ResourceDefinition.key 不使用这个参数，因此资源本身仍是同一全局状态。
    [String(hostVersion)],
    (snapshot) => snapshot.data ?? fallbackBootstrapSnapshot,
    (previous, next) => JSON.stringify(previous) === JSON.stringify(next)
  );

  const path = useCurrentPath();
  // 存储桶是系统最外层管理面；即使 Vault 尚未初始化、已锁定或存储
  // runtime 尚未 ready，也必须能进入这个页面处理桶目录。
  if (path === "/storage/buckets") return <StorageBucketManagerPage />;

  // Storage plugin 是未就绪时唯一允许启动的应用入口；Vault capability
  // 也必须由同一份 application-bootstrap.ready 状态确认后才进入 RuntimeApp。
  if (!hasStorageController || !bootstrapSnapshot.storageReady) return <InitialSetupPage />;
  // 首次设置必须保持同一个页面实例：桶刚就绪而 Vault capability 尚在装配时，
  // 不能临时切到 booting/LockedShell，否则页面内存中的一次性密码会丢失。
  if (!bootstrapSnapshot.hasUnlockedActiveKey && (!bootstrapSnapshot.vaultCapabilityReady || vaultService?.status() === "uninitialized")) {
    return <InitialSetupPage />;
  }
  const vaultSelectionReady = bootstrapSnapshot.phase === "vault-selection"
    && bootstrapSnapshot.vaultSelectionReady
    && bootstrapSnapshot.vaultCapabilityReady
    && !bootstrapSnapshot.hasUnlockedActiveKey;
  const applicationReady = bootstrapSnapshot.phase === "connect-apps-ready" &&
    bootstrapSnapshot.storageReady &&
    bootstrapSnapshot.vaultCapabilityReady &&
    bootstrapSnapshot.ownerAppsReady &&
    bootstrapSnapshot.connectAppsReady &&
    bootstrapSnapshot.assetWorkspaceReady &&
    hasVaultService &&
    hasKeyspaceService;
  if (vaultSelectionReady) {
    return <StorageUnavailableGuard><RuntimeApp /></StorageUnavailableGuard>;
  }
  if (!applicationReady) {
    if (bootstrapSnapshot.phase === "error") {
      return (
        <div className="app-booting">
          <p>应用装配失败：{bootstrapSnapshot.error ?? "未知错误"}</p>
          {bootstrap && <button type="button" onClick={() => void bootstrap.retry().catch(() => undefined)}>重试应用装配</button>}
        </div>
      );
    }
    return <div className="app-booting"><p>正在完成应用装配…</p></div>;
  }
  return <StorageUnavailableGuard><RuntimeApp /></StorageUnavailableGuard>;
}

function RuntimeApp() {
  const { vault, ready } = useRuntimeStatus();
  const { t } = useI18n();
  const path = typeof window === "undefined" ? "/" : window.location.pathname;

  if (!ready || vault === "booting") {
    return (
      <div className="app-booting">
        <p>{t("common.status.loading", { defaultValue: "正在加载…" })}</p>
      </div>
    );
  }

  // 协议 popup 顶层特例：这是协议页的**唯一**入口点。
  // 钱包 locked / uninitialized / unlocked 都直接走协议页，
  // 协议 service 内部会自己处理 unlock / confirm 状态机。
  if (isProtocolPopupPath(path)) {
    return <ProtocolPopupPage />;
  }

  if (vault === "uninitialized" || vault === "locked") {
    return <LockedShell />;
  }

  return <UnlockedShell />;
}
