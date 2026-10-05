import { usePluginI18n, useResourceViewSelector, router } from "@keymaster/runtime";
import { type NoticeRecord } from "@keymaster/contracts";
import { usePageNoticeController, usePageResources } from "../PageResourceContext.js";
export function NoticeRail() {
  const { t } = usePluginI18n();
  const controls = usePageNoticeController();
  const notices = useResourceViewSelector<NoticeRecord[], NoticeRecord[]>(usePageResources(), "page.notices", [], s => s.data ?? []);
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
            onDismiss={() => controls.dismiss(notice)}
            onAction={async (action) => {
              try {
                if (!controls.isCurrent(notice)) return;
                if (action.run) {
                  await action.run();
                }
                if (!controls.isCurrent(notice)) return;
                if (action.navigateTo) {
                  router.push(action.navigateTo);
                }
                if (action.autoDismiss) {
                  controls.dismiss(notice);
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
  const { t, text } = usePluginI18n();
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
