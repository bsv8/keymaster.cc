// packages/plugin-contacts/src/RecentContactsWidget.tsx
// 最近联系人 widget。
//
// 设计缘由：
//   - 只展示联系人 name + short publicKeyHex；
//   - active key 缺失时直接清空，不做 all-mode 回退；
//   - 作为首页侧栏只提供快速识别，不承载编辑逻辑。

import { useEffect, useState } from "react";
import { EmptyState } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import { formatShortPublicKey, type Contact, type ContactsService, type KeyspaceService } from "@keymaster/contracts";

export function RecentContactsWidget() {
  const service = useCapability<ContactsService>("contacts.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const { t } = useI18n();
  useI18n().language();
  const [rows, setRows] = useState<Contact[]>([]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      if (!keyspace.active().activePublicKeyHex) {
        if (mounted) setRows([]);
        return;
      }
      try {
        const list = await service.listContacts();
        if (!mounted) return;
        list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        setRows(list.slice(0, 5));
      } catch {
        if (mounted) setRows([]);
      }
    };
    void refresh();
    return keyspace.onActiveChange(refresh);
  }, [service, keyspace]);

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
