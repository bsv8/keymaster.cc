// apps/web/src/shell/AppShell.tsx
// 解锁后的统一布局：Topbar + Sidebar + Breadcrumbs + RouteRenderer。
// 设计缘由：shell 不写业务页面，只负责把"扩展点"按顺序渲染。
// 窄屏下侧边栏收起为抽屉式 overlay，AppShell 持有 mobileOpen 状态，
// 透传给 Topbar（汉堡按钮触发）和 Sidebar（开关 + 关闭）。
//
// 硬切换 009 收尾：AppShell 在挂载时订阅 vault 的
// `onInitialActivationNoticeChange` 事件，在主界面顶部展示一条
// "首 Key 已保存但未能自动设为 active"的提示横幅。这是修复
// 之前 messageBus 事件被错过的核心——notice 现在走可查询的
// vault state，新挂载的组件也能立即拿到当前值。
//
// 硬切换 005 收尾：已解锁壳层守卫。
//   - vault.status === "unlocked" + activePublicKeyHex 存在 → 正常渲染。
//   - vault.status === "unlocked" + activePublicKeyHex 缺失 +
//     listKeys() 读成功且 length === 0 → "0 key 异常态"，主动触发回
//     uninitialized 的恢复路径（让用户进入首启 welcome）。
//   - vault.status === "unlocked" + activePublicKeyHex 缺失 +
//     listKeys() 读成功且 length > 0 → "修复/管理态"：阻断普通业务页，
//     但 `/settings/vault`（VaultSettingsPage）**始终**允许渲染——
//     用户必须能在该页面导出 / 删除失败 / uninitialized key 才能脱离
//     修复态。
//   - listKeys() 抛错：进 "diagnostic" 态——渲染报错 + 重试按钮，**不**
//     触发空 Vault 收敛（把"读失败"误判为"0 key"会误删 meta）。
//   - 这几类都是壳层守卫，**不**引入新的全局 mode 概念。
//
// 守卫判定已抽出到 `evaluateShellGuard` 纯函数，可单测。
// `AppShell` 组件本身只负责订阅 + 渲染 + 路由允许。

import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import { useCapability, useCurrentPath, useI18n, router } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  InitialActivationNotice,
  KeyIdentity,
  KeyspaceService,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RouteRenderer } from "./RouteRenderer.js";
import { Sidebar } from "./Sidebar.js";
import { SiteFooter } from "./SiteFooter.js";
import { Topbar } from "./Topbar.js";

/** 已解锁壳层守卫的判定结果。 */
export type ShellGuardState =
  | { kind: "normal" }
  | { kind: "empty-vault-recovery" }
  | { kind: "needs-repair"; keys: KeyIdentity[] }
  | { kind: "diagnostic"; error: string };

const KEY_MANAGEMENT_PATH = "/settings/vault";

/**
 * 纯函数：评估当前已解锁状态下的壳层守卫。
 *
 * 设计缘由（硬切换 005 反馈修复）：
 *   - "读失败" 必须 fail-closed 成 "diagnostic"，**不**误判为 0 key
 *     触发空 Vault 收敛。
 *   - "0 key" 才允许走 "empty-vault-recovery"，并通过 `onEmpty` 触发
 *     vault.recoverEmptyVaultToUninitialized() 等收敛动作。
 *   - "仍有 key 但都不可用" 走 "needs-repair"，由组件层决定如何渲染
 *     （修复态下 `/settings/vault` 仍允许渲染以避免锁死用户）。
 *
 * 抽出此函数是为了让守卫决策本身可单测，避免每次新增分支都要靠
 * mock 整个 React runtime 才能验证。
 */
export async function evaluateShellGuard(args: {
  vaultStatus: VaultStatus;
  active: ActiveKeyState;
  listKeys: () => Promise<KeyIdentity[]>;
  /**
   * 进入 empty-vault-recovery 时触发的副作用。组件层通常在这里
   * 调 vault.recoverEmptyVaultToUninitialized()；本函数本身不感知。
   * 副作用抛错会被吞掉（recorderError 字段返回 true），但不影响
   * 守卫结果。
   */
  onEmpty?: () => Promise<void> | void;
}): Promise<{ state: ShellGuardState; recorderError: boolean }> {
  if (args.vaultStatus !== "unlocked") {
    return { state: { kind: "normal" }, recorderError: false };
  }
  if (args.active.activePublicKeyHex) {
    return { state: { kind: "normal" }, recorderError: false };
  }
  // activePublicKeyHex 缺失：按 listKeys 决定走"恢复"/"修复"/"诊断"。
  let list: KeyIdentity[];
  try {
    list = await args.listKeys();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      state: { kind: "diagnostic", error: msg },
      recorderError: false
    };
  }
  if (list.length === 0) {
    let recorderError = false;
    if (args.onEmpty) {
      try {
        await args.onEmpty();
      } catch {
        recorderError = true;
      }
    }
    return { state: { kind: "empty-vault-recovery" }, recorderError };
  }
  return { state: { kind: "needs-repair", keys: list }, recorderError: false };
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activationNotice, setActivationNotice] =
    useState<InitialActivationNotice | null>(null);
  const [guard, setGuard] = useState<ShellGuardState>({ kind: "normal" });
  const vault = useCapability<VaultService>("vault.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const path = useCurrentPath();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。
  useI18n().language();

  useEffect(() => {
    if (!vault || typeof vault.onInitialActivationNoticeChange !== "function") {
      return;
    }
    return vault.onInitialActivationNoticeChange((notice) => {
      setActivationNotice(notice);
    });
  }, [vault]);

  // 硬切换 005 收尾：已解锁壳层守卫。
  // 不变量：
  //   - vault.status === "unlocked" + activePublicKeyHex 存在 → normal。
  //   - vault.status === "unlocked" + activePublicKeyHex 缺失：
  //       * listKeys() 读失败 → "diagnostic"（**不**触发空 Vault 收敛，
  //         避免把"读失败"误判为"0 key"而误删 meta）。
  //       * listKeys() length === 0 → "0 key 异常态"，调
  //         `vault.recoverEmptyVaultToUninitialized()` 收敛到 uninitialized。
  //       * listKeys() length > 0 → "修复/管理态"。
  // 任何时候 status 切到非 unlocked 都让壳层降级到 normal，由 App 决定
  // 切回 LockedShell。
  useEffect(() => {
    if (!vault || !keyspace) {
      setGuard({ kind: "normal" });
      return;
    }
    let cancelled = false;
    async function evaluate() {
      const result = await evaluateShellGuard({
        vaultStatus: vault.status(),
        active: keyspace.active(),
        listKeys: () => keyspace.listKeys(),
        onEmpty: async () => {
          if (typeof vault.recoverEmptyVaultToUninitialized === "function") {
            try {
              await vault.recoverEmptyVaultToUninitialized();
            } catch (err) {
              console.error(
                "AppShell guard: recoverEmptyVaultToUninitialized failed",
                err
              );
              throw err;
            }
            return;
          }
          // 旧版 vault service 没有此方法时的兜底：仍走 lock 路径。
          try {
            await vault.lock();
          } catch (err) {
            console.error(
              "AppShell guard: vault.lock during empty-vault-recovery fallback failed",
              err
            );
            throw err;
          }
        }
      });
      if (cancelled) return;
      setGuard(result.state);
    }
    void evaluate();
    const offActive = keyspace.onActiveChange(() => {
      void evaluate();
    });
    const offStatus = vault.onStatusChange(() => {
      void evaluate();
    });
    return () => {
      cancelled = true;
      offActive();
      offStatus();
    };
  }, [vault, keyspace]);

  function dismissNotice() {
    if (vault && typeof vault.clearInitialActivationNotice === "function") {
      vault.clearInitialActivationNotice();
    }
    setActivationNotice(null);
  }

  function retryGuardEvaluation() {
    // 诊断态下让用户能重试一次 listKeys——只重新触发守卫评估，
    // 不直接调用 listKeys（让守卫函数自己处理错误归类）。
    if (!vault || !keyspace) return;
    void (async () => {
      const result = await evaluateShellGuard({
        vaultStatus: vault.status(),
        active: keyspace.active(),
        listKeys: () => keyspace.listKeys(),
        onEmpty: async () => {
          if (typeof vault.recoverEmptyVaultToUninitialized === "function") {
            await vault.recoverEmptyVaultToUninitialized();
            return;
          }
          await vault.lock();
        }
      });
      setGuard(result.state);
    })();
  }

  // "诊断态"：listKeys 读失败。**不**触发空 Vault 收敛，暴露错误
  // 并允许重试。
  if (guard.kind === "diagnostic") {
    return (
      <div className="app-shell app-shell--diagnostic">
        <PageHeader
          title={t("shell.appShell.diagnostic.title", { defaultValue: "无法读取 key 列表" })}
          description={t("shell.appShell.diagnostic.desc", {
            defaultValue: "读取 key 列表时出错；为避免误删数据，壳层守卫已暂停自动恢复路径。"
          })}
        />
        <EmptyState
          title={t("shell.appShell.diagnostic.errorTitle", { defaultValue: "读取失败" })}
          description={guard.error}
          action={
            <Button onClick={retryGuardEvaluation}>
              {t("shell.appShell.diagnostic.retry", { defaultValue: "重试" })}
            </Button>
          }
        />
      </div>
    );
  }

  // "0 key 异常态"恢复期：渲染极简"正在恢复"占位，避免业务页
  // 抢跑触发空指针。
  if (guard.kind === "empty-vault-recovery") {
    return (
      <div className="app-shell app-shell--recovering">
        <PageHeader
          title={t("shell.appShell.recover.title", { defaultValue: "正在恢复…" })}
          description={t("shell.appShell.recover.desc", {
            defaultValue: "检测到 Vault 内已无 key，正在回到首启页面。"
          })}
        />
      </div>
    );
  }

  // "修复/管理态"：阻断普通业务页。但当用户已经在 Vault Key 管理页
  // 上时，**必须**允许 RouteRenderer 渲染 VaultSettingsPage——否则
  // 用户会被锁死：点击"前往 Key 管理"按钮 router.push 改了 URL，
  // 但当前分支根本不渲染 RouteRenderer，URL 变了 UI 也不动。
  //
  // 设计缘由：硬切换 005 反馈修复——修复态的"阻断"目标是把普通业务页
  // （assets / transfer / contacts / p2pkh / poker）挡在外面，而不是
  // 把唯一能修复的 Key 管理页也挡掉。
  if (guard.kind === "needs-repair") {
    const isOnKeyManagement = path === KEY_MANAGEMENT_PATH;
    if (isOnKeyManagement) {
      // 在 Key 管理页：渲染正常壳层，让 VaultSettingsPage 显示并允许
      // 用户导出 / 删除失败 / uninitialized key。failure 列表仍通过
      // activationNotice 之外的方式显示——本分支直接渲染 RouteRenderer
      // 即可，VaultSettingsPage 自己会列出所有 keys。
      return renderNormalShell({
        mobileOpen,
        setMobileOpen,
        activationNotice,
        dismissNotice,
        t
      });
    }
    return (
      <div className={`app-shell app-shell--repair ${mobileOpen ? "is-mobile-nav-open" : ""}`}>
        <Topbar
          mobileOpen={mobileOpen}
          onToggleMobileNav={() => setMobileOpen((v) => !v)}
        />
        <div className="app-shell__body">
          <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
          {mobileOpen ? (
            <button
              type="button"
              className="app-shell__backdrop"
              aria-label="关闭菜单"
              onClick={() => setMobileOpen(false)}
            />
          ) : null}
          <main className="app-shell__main">
            <RepairGuard
              keys={guard.keys}
              onGoToKeyManagement={() => router.push(KEY_MANAGEMENT_PATH)}
              t={t}
            />
          </main>
        </div>
        <SiteFooter variant="app" />
      </div>
    );
  }

  return renderNormalShell({
    mobileOpen,
    setMobileOpen,
    activationNotice,
    dismissNotice,
    t
  });
}

interface NormalShellArgs {
  mobileOpen: boolean;
  setMobileOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  activationNotice: InitialActivationNotice | null;
  dismissNotice: () => void;
  t: (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string;
}

function renderNormalShell({
  mobileOpen,
  setMobileOpen,
  activationNotice,
  dismissNotice,
  t
}: NormalShellArgs) {
  return (
    <div className={`app-shell ${mobileOpen ? "is-mobile-nav-open" : ""}`}>
      <Topbar
        mobileOpen={mobileOpen}
        onToggleMobileNav={() => setMobileOpen((v) => !v)}
      />
      {activationNotice ? (
        <div className="app-shell__notice" role="status">
          <span>
            {t("shell.unlocked.notice.activationPending", {
              defaultValue:
                "首把 Key 已保存，但未能自动设为 active。请在 Key 管理中手动切换。"
            })}
            {activationNotice.label ? ` (${activationNotice.label})` : ""}
          </span>
          <Button variant="ghost" size="sm" onClick={dismissNotice}>
            {t("shell.unlocked.notice.dismiss", { defaultValue: "知道了" })}
          </Button>
        </div>
      ) : null}
      <div className="app-shell__body">
        <Sidebar mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
        {mobileOpen ? (
          <button
            type="button"
            className="app-shell__backdrop"
            aria-label="关闭菜单"
            onClick={() => setMobileOpen(false)}
          />
        ) : null}
        <main className="app-shell__main">
          {/*
            硬切换 013：把「面包屑下方业务页」包进 .app-shell__paged，
            让窄屏 grid 收敛规则有明确的边界——repair 分支虽然也在
            .app-shell__main 里但不进这个 wrapper，因此不会被纳入，
            也就不依赖「repair 恰好没 actions」这个隐性不变量。
          */}
          <div className="app-shell__paged">
            <Breadcrumbs />
            <RouteRenderer />
          </div>
        </main>
      </div>
      <SiteFooter variant="app" />
    </div>
  );
}

interface RepairGuardProps {
  keys: KeyIdentity[];
  onGoToKeyManagement(): void;
  t: (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string;
}

function RepairGuard({ keys, onGoToKeyManagement, t }: RepairGuardProps) {
  const failedCount = useMemo(
    () => keys.filter((k) => k.identityStatus === "failed").length,
    [keys]
  );
  const uninitializedCount = useMemo(
    () => keys.filter((k) => k.identityStatus === "uninitialized").length,
    [keys]
  );
  return (
    <div className="app-shell__repair">
      <PageHeader
        title={t("shell.appShell.repair.title", { defaultValue: "需要修复 Key 状态" })}
        description={t("shell.appShell.repair.desc", {
          defaultValue:
            "当前 Vault 内已无可用的 active key。处理完失败或未初始化的 key 后再继续。"
        })}
      />
      <EmptyState
        title={t("shell.appShell.repair.emptyTitle", { defaultValue: "无可用 active key" })}
        description={t("shell.appShell.repair.emptyDesc", {
          defaultValue:
            "检测到 Vault 内的 key 全部不可用（身份失败 / 初始化中）。请前往 Key 管理处理。"
        })}
        action={
          <Button onClick={onGoToKeyManagement}>
            {t("shell.appShell.repair.cta", { defaultValue: "前往 Key 管理" })}
          </Button>
        }
      />
      <ul className="app-shell__repair-list">
        {keys.map((k) => (
          <li key={k.keyId} className="app-shell__repair-item">
            <span className="app-shell__repair-label">
              {k.label || t("vault.settings.empty.label", { defaultValue: "未命名" })}
            </span>
            <span className={`app-shell__repair-status app-shell__repair-status--${k.identityStatus ?? "uninitialized"}`}>
              {k.identityStatus === "failed"
                ? t("vault.settings.status.failed", { defaultValue: "身份失败" })
                : k.identityStatus === "uninitialized"
                ? t("vault.settings.status.initializing", { defaultValue: "初始化中" })
                : t("vault.settings.status.ready", { defaultValue: "可用" })}
            </span>
            {k.identityError ? (
              <code className="app-shell__repair-error">{k.identityError}</code>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="app-shell__repair-summary">
        {t("shell.appShell.repair.summary", {
          defaultValue:
            "共 {{total}} 把 key：{{failed}} 失败 / {{init}} 初始化中。其它业务页已禁用。",
          total: keys.length,
          failed: failedCount,
          init: uninitializedCount
        })}
      </p>
    </div>
  );
}
