// packages/plugin-contacts/src/RecentContactsWidget.tsx
// 最近联系人 widget。
//
// 设计缘由：
//   - 只展示联系人 name + short publicKeyHex；
//   - active key 缺失时直接清空，不做 all-mode 回退；
//   - 作为首页侧栏只提供快速识别，不承载编辑逻辑。

import { EmptyState } from "@keymaster/ui";
import { countRender, useOptionalCapability, useResourceSelector } from "webloom-framework/react";
import { useI18n, usePluginHost } from "@keymaster/runtime";
import { CONTACTS_SERVICE_CAPABILITY, formatShortPublicKey, type Contact } from "@keymaster/contracts";

export function RecentContactsWidget() {
  countRender("plugin-contacts/RecentContactsWidget");
  const host = usePluginHost();
  const { t, language } = useI18n();
  const service = useOptionalCapability(CONTACTS_SERVICE_CAPABILITY);
  const hasResource = host.resourceRegistry?.get("contacts.list") !== undefined;
  if (!service || !hasResource) {
    // contacts namespace 随 owner 实例回收；不可用空态使用本地双语文本，
    // 避免在资源已经注销后调用 t() 触发开发期 warning。
    const unavailableText = language() === "zh-CN"
      ? { title: "最近联系人", message: "当前会话暂时无法提供联系人服务。" }
      : { title: "Recent contacts", message: "Contacts are temporarily unavailable for this session." };
    return (
      <div className="home-widget home-widget--contacts-recent home-widget--unavailable" data-contacts-home-widget="unavailable">
        <header className="home-widget__head">
          <h3>{unavailableText.title}</h3>
        </header>
        <p className="home-widget__status">
          {unavailableText.message}
        </p>
      </div>
    );
  }
  return <RecentContactsWidgetContent />;
}

function RecentContactsWidgetContent() {
  const host = usePluginHost();
  const { t } = useI18n();
  const rows = useResourceSelector<Contact[], Contact[]>(
    host.resourceStore, "contacts.list", [],
    (snapshot) => [...(snapshot.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5),
    (a, b) => a === b
  );

  return (
    <div className="home-widget home-widget--contacts-recent">
      <header className="home-widget__head">
        <h3>{t("contacts.home.recent", { defaultValue: "Recent contacts" })}</h3>
      </header>
      {rows.length === 0 ? (
        <EmptyState title={t("contacts.empty.recent", { defaultValue: "No contacts yet" })} />
      ) : (
        <ul className="home-widget__list">
          {rows.map((c) => (
            <li key={c.id}>
              <span className="name">{c.name}</span>
              <code className="addr">{formatShortPublicKey(c.publicKeyHex)}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
