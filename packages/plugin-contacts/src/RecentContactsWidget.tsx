// packages/plugin-contacts/src/RecentContactsWidget.tsx
// 最近联系人 widget：按 updatedAt 倒序展示前 N 条。
//
// 硬切换 008 收尾：
//   - 接入 keyspace：无 active key 时不调用 service.listContacts，
//     直接清空 rows，避免 ContactsNoActiveKeyError 冒到 React 渲染。
//   - 订阅 onActiveChange：active 切换时重新拉；active 缺失时清空。
//
// 硬切换 005 收尾：删掉 "all 模式" 分支。activePublicKeyHash 缺失由
// 壳层守卫收敛，本 widget 只在 active key 缺失时清空 rows，不展示
// 任何"全部 key"提示。
//
// 硬切换 003：title 与 empty 走 i18n。

import { useEffect, useState } from "react";
import { EmptyState } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { Contact, ContactsService, KeyspaceService } from "@keymaster/contracts";

export function RecentContactsWidget() {
  const service = useCapability<ContactsService>("contacts.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const { t } = useI18n();
  useI18n().language();
  const [rows, setRows] = useState<Contact[]>([]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      if (!keyspace.active().activePublicKeyHash) {
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
        <h3>{t("contacts.home.recent", { defaultValue: "最近联系人" })}</h3>
      </header>
      {rows.length === 0 ? (
        <EmptyState title={t("contacts.empty.recent", { defaultValue: "还没有联系人" })} />
      ) : (
        <ul className="home-widget__list">
          {rows.map((c) => (
            <li key={c.id}>
              <span className="name">{c.name}</span>
              <code className="addr">{c.address}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
