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
import { countRender, useCapability, useCurrentPath, useI18n, usePluginHost, useResourceSelector, router } from "@keymaster/runtime";
import type {
  ActiveKeyState,
  InitialActivationNotice,
  KeyIdentity,
  KeyspaceService,
  NoticeRecord,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { RouteRenderer } from "./RouteRenderer.js";
import { Sidebar } from "./Sidebar.js";
import { SiteFooter } from "./SiteFooter.js";
import { Topbar } from "./Topbar.js";
import type { ShellGuardResource } from "./shellResources.js";

/** 已解锁壳层守卫的判定结果。 */
export type ShellGuardState =
  | { kind: "normal" }
  | { kind: "empty-vault-recovery" }
  | { kind: "needs-repair"; keys: KeyIdentity[] }
  | { kind: "diagnostic"; error: string };

const EMPTY_NOTICE_RECORDS: NoticeRecord[] = [];

/** Guard 状态按语义比较，避免重复通知创建新对象导致壳层重渲染。 */
export function areShellGuardStatesEqual(a: ShellGuardState, b: ShellGuardState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "diagnostic" && b.kind === "diagnostic") return a.error === b.error;
  if (a.kind !== "needs-repair" || b.kind !== "needs-repair") return true;
  if (a.keys.length !== b.keys.length) return false;
  return a.keys.every((key, index) => {
    const other = b.keys[index];
    return other !== undefined &&
      key.publicKeyHex === other.publicKeyHex &&
      key.label === other.label &&
      key.createdAt === other.createdAt &&
      key.capabilities.length === other.capabilities.length &&
      key.capabilities.every((capability, capabilityIndex) => capability === other.capabilities[capabilityIndex]);
  });
}

const KEY_MANAGEMENT_PATH = "/settings/vault";
const AUTO_LOCK_IDLE_MS = 5 * 60 * 1000;
const AUTO_LOCK_ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  "pointerdown",
  "keydown",
  "mousemove",
  "touchstart",
  "wheel"
];

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
  countRender("apps/web/AppShell");
  const [mobileOpen, setMobileOpen] = useState(false);
  const host = usePluginHost();
  const activationNotice = useResourceSelector<InitialActivationNotice | null, InitialActivationNotice | null>(host.resourceStore, "shell.activation-notice", [], (s) => s.data ?? null);
  const notices = useResourceSelector<NoticeRecord[], NoticeRecord[]>(host.resourceStore, "shell.notices", [], (s) => s.data ?? EMPTY_NOTICE_RECORDS);
  const guardResource = useResourceSelector<ShellGuardResource, ShellGuardResource>(host.resourceStore, "shell.guard", [], (s) => s.data ?? { kind: "normal" }, areShellGuardStatesEqual);
  const guard = guardResource as ShellGuardState;
  const vault = useCapability<VaultService>("vault.service");
  const vaultStatus = useResourceSelector<VaultStatus, VaultStatus>(host.resourceStore, "shell.vault-status", [], (s) => s.data ?? "uninitialized");
  const path = useCurrentPath();
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。

  // 施工单 002：自动锁定改为向 Coordinator 发送节流 activity。
  // 页面 hidden、blur、暂停不应立即 lock；无任意用户活动达到配置时长才全局 lock。
  // Coordinator client 通过 capability 获取（在组件顶层调用 hook）。
  let coordinatorClient: { getIsConnected(): boolean; sendActivity(): void } | null = null;
  coordinatorClient = useCapability<{ getIsConnected(): boolean; sendActivity(): void }>("session-coordinator.client") ?? null;

  useEffect(() => {
    if (vaultStatus !== "unlocked") {
      return;
    }

    if (!coordinatorClient || !coordinatorClient.getIsConnected()) return;

    // 使用 Coordinator：发送节流 activity
    let lastActivityTime = 0;
    const ACTIVITY_THROTTLE_MS = 5000; // 5 秒节流

    const onActivity = () => {
      const now = Date.now();
      if (now - lastActivityTime >= ACTIVITY_THROTTLE_MS) {
        lastActivityTime = now;
        coordinatorClient!.sendActivity();
      }
    };

    for (const eventName of AUTO_LOCK_ACTIVITY_EVENTS) {
      window.addEventListener(eventName, onActivity, { passive: true });
    }

    return () => {
      for (const eventName of AUTO_LOCK_ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, onActivity);
      }
    };
  }, [vault, vaultStatus]);

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
    if (guard.kind !== "empty-vault-recovery") return;
    void (typeof vault.recoverEmptyVaultToUninitialized === "function"
      ? vault.recoverEmptyVaultToUninitialized()
      : vault.lock());
  }, [guard.kind, vault]);

  function dismissNotice() {
    if (vault && typeof vault.clearInitialActivationNotice === "function") {
      vault.clearInitialActivationNotice();
    }
  }

  function retryGuardEvaluation() {
    // 诊断态下让用户能重试一次 listKeys——只重新触发守卫评估，
    // 不直接调用 listKeys（让守卫函数自己处理错误归类）。
    host.resourceStore.invalidate("shell.guard", []);
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
        <NoticeRail host={host} notices={notices} />
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
        <NoticeRail host={host} notices={notices} />
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
        host,
        notices,
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
            <NoticeRail host={host} notices={notices} />
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
    host,
    notices,
    t
  });
}

interface NormalShellArgs {
  mobileOpen: boolean;
  setMobileOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  activationNotice: InitialActivationNotice | null;
  dismissNotice: () => void;
  host: ReturnType<typeof usePluginHost>;
  notices: NoticeRecord[];
  t: (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string;
}

function renderNormalShell({
  mobileOpen,
  setMobileOpen,
  activationNotice,
  dismissNotice,
  host,
  notices,
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
          <NoticeRail host={host} notices={notices} />
          {/*
            notice rail 现在是内容区顶部整宽块；业务页仍只挂在
            .app-shell__paged 里，避免 rail 和 route 内容互相耦合。
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

interface NoticeRailProps {
  host: ReturnType<typeof usePluginHost>;
  notices: NoticeRecord[];
}

function NoticeRail({ host, notices }: NoticeRailProps) {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <aside className="app-notice-rail" aria-label={t("shell.noticeRail.label", { defaultValue: "紧急通知" })}>
      <div className="app-notice-rail__header">
        <h2 className="app-notice-rail__title">
          {t("shell.noticeRail.title", { defaultValue: "紧急通知" })}
        </h2>
      </div>
      <div className="app-notice-rail__list">
        {notices.map((notice) => (
          <NoticeCard
            key={notice.id}
            notice={notice}
            onDismiss={() => host.notice.dismiss(notice.id)}
            onAction={async (action) => {
              try {
                if (action.run) {
                  await action.run();
                }
                if (action.navigateTo) {
                  router.push(action.navigateTo);
                }
                if (action.autoDismiss) {
                  host.notice.dismiss(notice.id);
                }
              } catch (err) {
                console.error("notice action failed", err);
              }
            }}
          />
        ))}
      </div>
    </aside>
  );
}

function NoticeCard(props: {
  notice: NoticeRecord;
  onDismiss: () => void;
  onAction: (action: NoticeRecord["actions"][number]) => Promise<void>;
}) {
  const { notice, onDismiss, onAction } = props;
  const { t, text } = useI18n();
  const canNavigate = typeof notice.routeTo === "string" && notice.routeTo.length > 0;
  return (
    <section
      className={`app-notice-card${canNavigate ? " app-notice-card--clickable" : ""}`}
      data-notice-id={notice.id}
      role={canNavigate ? "link" : undefined}
      tabIndex={canNavigate ? 0 : undefined}
      aria-label={canNavigate ? text(notice.title) : undefined}
      onClick={() => {
        if (canNavigate) {
          router.push(notice.routeTo!);
        }
      }}
      onKeyDown={(event) => {
        if (!canNavigate) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        router.push(notice.routeTo!);
      }}
    >
      <header className="app-notice-card__header">
        <div className="app-notice-card__headline">
          <h3 className="app-notice-card__title">{text(notice.title)}</h3>
          {notice.body ? <p className="app-notice-card__body">{text(notice.body)}</p> : null}
        </div>
        {notice.dismissible !== false ? (
          <button
            className="app-notice-card__dismiss"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
          >
            {t("shell.noticeRail.dismiss", { defaultValue: "关闭" })}
          </button>
        ) : null}
      </header>
      <div className="app-notice-card__actions">
        {notice.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className={`app-notice-card__action app-notice-card__action--${action.variant ?? "secondary"}`}
            onClick={(event) => {
              event.stopPropagation();
              void onAction(action);
            }}
          >
            {text(action.label)}
          </button>
        ))}
      </div>
    </section>
  );
}

interface RepairGuardProps {
  keys: KeyIdentity[];
  onGoToKeyManagement(): void;
  t: (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string;
}

function RepairGuard({ keys, onGoToKeyManagement, t }: RepairGuardProps) {
  // 硬切换 002 收尾：identityStatus 已删除，KeyIdentity 必 ready；
  // RepairGuard 永远不会再展示"failed / uninitialized"行；保留入口
  // 仅为兜底 0-key 护栏。
  const failedCount = useMemo(() => 0, [keys]);
  const uninitializedCount = useMemo(() => 0, [keys]);
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
          <li key={k.publicKeyHex} className="app-shell__repair-item">
            <span className="app-shell__repair-label">
              {k.label || t("vault.settings.empty.label", { defaultValue: "未命名" })}
            </span>
            <span className="app-shell__repair-status app-shell__repair-status--ready">
              {t("vault.settings.status.ready", { defaultValue: "可用" })}
            </span>
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
