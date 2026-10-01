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
//     只显示恢复提示。Key 管理页已删除（等待并入桶管理），暂不提供跳转。
//   - listKeys() 抛错：进 "diagnostic" 态——渲染报错 + 重试按钮，**不**
//     触发空 Vault 收敛（把"读失败"误判为"0 key"会误删 meta）。
//   - 这几类都是壳层守卫，**不**引入新的全局 mode 概念。
//
// 守卫判定已抽出到 `evaluateShellGuard` 纯函数，可单测。
// `AppShell` 组件本身只负责订阅 + 渲染 + 路由允许。

import { useEffect, useState } from "react";
import { Button, EmptyState, PageHeader } from "@keymaster/ui";
import { countRender, useCapability, useOptionalCapability, useResourceSelector } from "webloom-framework/react";
import { useI18n, usePluginHost, router } from "@keymaster/runtime";
import type {
  NoticeRecord,
  VaultService,
  VaultStatus
} from "@keymaster/contracts";
import { COORDINATOR_ACTIVITY_CAPABILITY, VAULT_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { Breadcrumbs } from "./Breadcrumbs.js";
import { IndexedDbPersistenceBar } from "./IndexedDbPersistenceBar.js";
import { RouteRenderer } from "./RouteRenderer.js";
import { Sidebar } from "./Sidebar.js";
import { SiteFooter } from "./SiteFooter.js";
import { Topbar } from "./Topbar.js";
import type { ShellGuardResource } from "./shellResources.js";

/** 已解锁壳层守卫的判定结果。 */
export type ShellGuardState =
  | { kind: "normal" }
  | { kind: "needs-repair"; publicKeyHex?: string }
  | { kind: "diagnostic"; error: string };

const EMPTY_NOTICE_RECORDS: NoticeRecord[] = [];

/** Guard 状态按语义比较，避免重复通知创建新对象导致壳层重渲染。 */
export function areShellGuardStatesEqual(a: ShellGuardState, b: ShellGuardState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "diagnostic" && b.kind === "diagnostic") return a.error === b.error;
  if (a.kind !== "needs-repair" || b.kind !== "needs-repair") return true;
  return a.publicKeyHex === b.publicKeyHex;
}

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
 * 设计缘由（单 Key 本地存储，docs/存储.md）：
 *   - 已解锁且能读到唯一 Key 的公开身份 → normal。
 *   - 已解锁但读不到身份 → needs-repair。**不**做任何自动收敛：系统里
 *     只有一把 Key，没有"切到另一把"这种退路，也不需要"回未初始化"的
 *     恢复路径；那样做只会破坏用户本地数据。
 *   - 读取抛错 → diagnostic，fail closed。
 *
 * 抽出此函数是为了让守卫决策本身可单测，避免每次新增分支都要靠
 * mock 整个 React runtime 才能验证。
 */
export async function evaluateShellGuard(args: {
  vaultStatus: VaultStatus;
  getCurrentKey: () => Promise<{ publicKeyHex: string } | undefined>;
  /** 身份投影里的公钥；仅用于 needs-repair 的诊断展示。 */
  projectedPublicKeyHex?: string;
}): Promise<ShellGuardState> {
  if (args.vaultStatus !== "unlocked") return { kind: "normal" };
  try {
    const key = await args.getCurrentKey();
    if (key) return { kind: "normal" };
    return { kind: "needs-repair", publicKeyHex: args.projectedPublicKeyHex };
  } catch (err) {
    return { kind: "diagnostic", error: err instanceof Error ? err.message : String(err) };
  }
}

export function AppShell() {
  countRender("apps/web/AppShell");
  const [mobileOpen, setMobileOpen] = useState(false);
  const host = usePluginHost();
  const notices = useResourceSelector<NoticeRecord[], NoticeRecord[]>(host.resourceStore, "shell.notices", [], (s) => s.data ?? EMPTY_NOTICE_RECORDS);
  const guardResource = useResourceSelector<ShellGuardResource, ShellGuardResource>(host.resourceStore, "shell.guard", [], (s) => s.data ?? { kind: "normal" }, areShellGuardStatesEqual);
  const guard = guardResource as ShellGuardState;
  const vault = useCapability(VAULT_SERVICE_CAPABILITY);
  const vaultStatus = useResourceSelector<VaultStatus, VaultStatus>(host.resourceStore, "shell.vault-status", [], (s) => s.data ?? "uninitialized");
  const { t } = useI18n();
  // 触发 languageChanged 重渲染。

  // 施工单 002：自动锁定改为向 Coordinator 发送节流 activity。
  // 页面 hidden、blur、暂停不应立即 lock；无任意用户活动达到配置时长才全局 lock。
  // Coordinator client 通过 capability 获取（在组件顶层调用 hook）。
  let coordinatorClient: { getIsConnected(): boolean; sendActivity(): void } | null = null;
  coordinatorClient = useOptionalCapability(COORDINATOR_ACTIVITY_CAPABILITY) ?? null;

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

  function retryGuardEvaluation() {
    // 只重新触发守卫评估；错误归类交给守卫函数自己处理。
    host.resourceStore.invalidate("shell.guard", []);
  }

  // "诊断态"：读取唯一 Key 身份失败。fail closed，暴露错误并允许重试。
  if (guard.kind === "diagnostic") {
    return (
      <div className="app-shell app-shell--diagnostic">
        <PageHeader
          title={t("shell.appShell.diagnostic.title", { defaultValue: "无法读取钱包 Key" })}
          description={t("shell.appShell.diagnostic.desc", {
            defaultValue: "读取钱包 Key 信息时出错；为避免误改数据，壳层守卫已暂停自动恢复路径。"
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

  // "修复态"：已解锁但读不到唯一 Key 的公开身份时必须阻断普通业务页，
  // 避免用户在身份不明的情况下继续操作。这里不做任何自动收敛——
  // 单 Key 钱包没有"切到另一把 Key"的退路。
  if (guard.kind === "needs-repair") {
    return (
      <div className={`app-shell app-shell--repair ${mobileOpen ? "is-mobile-nav-open" : ""}`}>
        <IndexedDbPersistenceBar />
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
            <RepairGuard publicKeyHex={guard.publicKeyHex} t={t} />
          </main>
        </div>
        <SiteFooter variant="app" />
      </div>
    );
  }

  return renderNormalShell({
    mobileOpen,
    setMobileOpen,
    host,
    notices,
    t
  });
}

interface NormalShellArgs {
  mobileOpen: boolean;
  setMobileOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  host: ReturnType<typeof usePluginHost>;
  notices: NoticeRecord[];
  t: (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string;
}

function renderNormalShell({
  mobileOpen,
  setMobileOpen,
  host,
  notices,
  t
}: NormalShellArgs) {
  return (
    <div className={`app-shell ${mobileOpen ? "is-mobile-nav-open" : ""}`}>
      <IndexedDbPersistenceBar />
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
  publicKeyHex?: string;
  t: (key: string, values?: { defaultValue?: string; [k: string]: string | number | boolean | null | undefined }) => string;
}

function RepairGuard({ publicKeyHex, t }: RepairGuardProps) {
  return (
    <div className="app-shell__repair">
      <PageHeader
        title={t("shell.appShell.repair.title", { defaultValue: "钱包 Key 状态不一致" })}
        description={t("shell.appShell.repair.desc", {
          defaultValue:
            "钱包已解锁，但读不到唯一 Key 的公开身份。已阻断其它业务页，以免在身份不明时修改数据。"
        })}
      />
      <EmptyState
        title={t("shell.appShell.repair.emptyTitle", { defaultValue: "读不到钱包 Key" })}
        description={t("shell.appShell.repair.emptyDesc", {
          defaultValue:
            "请先锁定再解锁；如果仍然失败，需要重置钱包后重新创建或导入。重置会删除当前 Key 和全部本地钱包数据。"
        })}
      />
      {publicKeyHex ? (
        <p className="app-shell__repair-summary">{publicKeyHex}</p>
      ) : null}
    </div>
  );
}
