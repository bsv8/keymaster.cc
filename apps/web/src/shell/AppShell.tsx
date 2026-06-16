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
//   - vault.status === "unlocked" + activePublicKeyHash 存在 → 正常渲染。
//   - vault.status === "unlocked" + activePublicKeyHash 缺失 +
//     listKeys().length === 0 → "0 key 异常态"，主动触发回
//     uninitialized 的恢复路径（让用户进入首启 welcome）。
//   - vault.status === "unlocked" + activePublicKeyHash 缺失 +
//     listKeys().length > 0 → "修复/管理态"：阻断普通业务页，
//     只允许去 Vault Key 管理页处理 failed / uninitialized key。
//   - 这两类都是壳层守卫，**不**引入新的全局 mode 概念。

import { useEffect, useMemo, useState } from "react";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import { useCapability, useI18n, router } from "@keymaster/runtime";
import type {
  InitialActivationNotice,
  KeyIdentity,
  KeyspaceService,
  VaultService
} from "@keymaster/contracts";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RouteRenderer } from "./RouteRenderer.js";
import { Sidebar } from "./Sidebar.js";
import { SiteFooter } from "./SiteFooter.js";
import { Topbar } from "./Topbar.js";

/** 已解锁壳层守卫的判定结果。 */
type ShellGuardState =
  | { kind: "normal" }
  | { kind: "empty-vault-recovery" }
  | { kind: "needs-repair"; keys: KeyIdentity[] };

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activationNotice, setActivationNotice] =
    useState<InitialActivationNotice | null>(null);
  const [guard, setGuard] = useState<ShellGuardState>({ kind: "normal" });
  const vault = useCapability<VaultService>("vault.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
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
  //   - vault.status === "unlocked" + activePublicKeyHash 存在 → normal。
  //   - vault.status === "unlocked" + activePublicKeyHash 缺失：
  //       * listKeys().length === 0 → "0 key 异常态"。
  //         此时必须主动触发回 uninitialized——继续在 unlocked
  //         状态会卡在"已经看到顶栏但永远没有 key"的死循环。
  //       * listKeys().length > 0 → "修复/管理态"，阻断普通业务页。
  // 任何时候 status 切到非 unlocked 都让壳层降级到 normal，由 App 决定
  // 切回 LockedShell。
  useEffect(() => {
    if (!vault || !keyspace) {
      setGuard({ kind: "normal" });
      return;
    }
    let cancelled = false;
    async function evaluate() {
      if (vault.status() !== "unlocked") {
        if (!cancelled) setGuard({ kind: "normal" });
        return;
      }
      const active = keyspace.active();
      if (active.activePublicKeyHash) {
        if (!cancelled) setGuard({ kind: "normal" });
        return;
      }
      // activePublicKeyHash 缺失：按 listKeys 决定走"恢复"还是"修复"。
      let list: KeyIdentity[] = [];
      try {
        list = await keyspace.listKeys();
      } catch {
        list = [];
      }
      if (cancelled) return;
      if (list.length === 0) {
        // 0 key：主动触发"0 key 异常态恢复"路径——调
        // vault.recoverEmptyVaultToUninitialized() 把状态收敛到
        // uninitialized，让用户进入首启 welcome。app.tsx 看到 status
        // 变化后切到 LockedShell。
        setGuard({ kind: "empty-vault-recovery" });
        if (typeof vault.recoverEmptyVaultToUninitialized === "function") {
          try {
            await vault.recoverEmptyVaultToUninitialized();
          } catch (err) {
            console.error(
              "AppShell guard: recoverEmptyVaultToUninitialized failed",
              err
            );
          }
        } else {
          // 旧版 vault service 没有此方法时的兜底：仍走 lock 路径。
          try {
            await vault.lock();
          } catch (err) {
            console.error(
              "AppShell guard: vault.lock during empty-vault-recovery fallback failed",
              err
            );
          }
        }
        return;
      }
      // 仍有 key 但都不可用：进入修复/管理态。
      setGuard({ kind: "needs-repair", keys: list });
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

  // "修复/管理态"：阻断普通业务页，直接引导到 Vault Key 管理页。
  if (guard.kind === "needs-repair") {
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
            <RepairGuard keys={guard.keys} onGoToKeyManagement={() => router.push("/settings/vault")} t={t} />
          </main>
        </div>
        <SiteFooter variant="app" />
      </div>
    );
  }

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
          <Breadcrumbs />
          <RouteRenderer />
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
