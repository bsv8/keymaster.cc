// packages/plugin-contacts/src/RecentContactsWidget.tsx
// 最近联系人 widget。
//
// 设计缘由：
//   - 只展示联系人 name + short publicKeyHex；
//   - active key 缺失时直接清空，不做 all-mode 回退；
//   - 作为首页侧栏只提供快速识别，不承载编辑逻辑。

import { EmptyState } from "@keymaster/ui";
import { countRender, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { formatShortPublicKey, type Contact } from "@keymaster/contracts";

export function RecentContactsWidget() {
  countRender("plugin-contacts/RecentContactsWidget");
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
