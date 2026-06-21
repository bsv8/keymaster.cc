// packages/plugin-contacts/src/ContactDetailPage.tsx
// 单个联系人详情：根据 path 参数显示。
// 设计缘由：动态资源名（联系人名）由 breadcrumb provider resolve，页面只展示。
//
// 硬切换 008 收尾：catch listContacts 错误；无 key 时显示"请选择一个 key"，
// 避免把"无 key"误显为"联系人已被删除"。
//
// 硬切换 005 收尾：删掉 "all 模式" 分支，仅以 activePublicKeyHex 缺失
// 作为阻断条件。
//
// 硬切换 003：所有展示文案走 i18n。

import { useEffect, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
import { EmptyState, PageHeader } from "@keymaster/ui";
import type { Contact, ContactsService, KeyspaceService } from "@keymaster/contracts";

// 不引入 react-router；直接用 location.pathname 解析。
// 路径形态：/contacts/:id

export function ContactDetailPage() {
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  const id = path.split("/").filter(Boolean).pop() ?? "";
  const service = useCapability<ContactsService>("contacts.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const { t } = useI18n();
  useI18n().language();
  const [contact, setContact] = useState<Contact | undefined>(undefined);
  const [noActiveKey, setNoActiveKey] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (!keyspace.active().activePublicKeyHex) {
      setContact(undefined);
      setNoActiveKey(true);
      return;
    }
    setNoActiveKey(false);
    service.listContacts()
      .then((list) => {
        if (!mounted) return;
        setContact(list.find((c) => c.id === id));
      })
      .catch(() => {
        if (!mounted) return;
        setContact(undefined);
        setNoActiveKey(true);
      });
    return () => {
      mounted = false;
    };
  }, [service, keyspace, id]);

  if (!contact) {
    return (
      <div className="contact-detail">
        <PageHeader title={t("contacts.detail.title", { defaultValue: "联系人" })} />
        <EmptyState
          title={noActiveKey
            ? t("contacts.detail.noKey.title", { defaultValue: "请选择一个 key" })
            : t("contacts.detail.notFound.title", { defaultValue: "未找到联系人" })}
          description={
            noActiveKey
              ? t("contacts.detail.noKey.desc", { defaultValue: "切到任一 key 后再查看联系人。" })
              : t("contacts.detail.notFound.desc", { defaultValue: "可能已被删除，或确认联系人 id 正确。" })
          }
        />
      </div>
    );
  }

  return (
    <div className="contact-detail">
      <PageHeader title={contact.name} description={contact.address} />
      {contact.note ? <p>{contact.note}</p> : null}
      <p>
        {t("contacts.detail.tagsLabel", { defaultValue: "标签：" })}
        {contact.tags.join(", ") || t("contacts.detail.tagsEmpty", { defaultValue: "无" })}
      </p>
    </div>
  );
}
