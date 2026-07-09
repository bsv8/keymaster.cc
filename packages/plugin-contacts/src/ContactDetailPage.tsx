// packages/plugin-contacts/src/ContactDetailPage.tsx
// 单个联系人详情页。
//
// 设计缘由：
//   - 只展示联系人自身字段，不显示 address；
//   - 详情页保留给 contacts 域内部查看与 breadcrumb 解析；
//   - 联系人身份以 publicKeyHex 为准。

import { useEffect, useState } from "react";
import { useCapability, useI18n } from "@keymaster/runtime";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { formatShortPublicKey, type Contact, type ContactsService, type KeyspaceService } from "@keymaster/contracts";

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
    const refresh = async () => {
      if (!keyspace.active().activePublicKeyHex) {
        if (mounted) {
          setContact(undefined);
          setNoActiveKey(true);
        }
        return;
      }
      if (mounted) setNoActiveKey(false);
      try {
        const list = await service.listContacts();
        if (!mounted) return;
        setContact(list.find((c) => c.id === id));
      } catch {
        if (!mounted) return;
        setContact(undefined);
        setNoActiveKey(true);
      }
    };
    void refresh();
    const off = keyspace.onActiveChange(() => {
      void refresh();
    });
    return () => {
      mounted = false;
      off();
    };
  }, [service, keyspace, id]);

  if (!contact) {
    return (
      <div className="contact-detail">
        <PageHeader title={t("contacts.detail.title", { defaultValue: "Contacts" })} />
        <EmptyState
          title={
            noActiveKey
              ? t("contacts.detail.noKey.title", { defaultValue: "Pick a key" })
              : t("contacts.detail.notFound.title", { defaultValue: "Contact not found" })
          }
          description={
            noActiveKey
              ? t("contacts.detail.noKey.desc", { defaultValue: "Switch to any key to view contacts." })
              : t("contacts.detail.notFound.desc", { defaultValue: "It may have been deleted, or check the contact id." })
          }
        />
      </div>
    );
  }

  return (
    <div className="contact-detail">
      <PageHeader
        title={contact.name}
        description={contact.publicKeyHex}
      />
      <p>
        <strong>publicKeyHex: </strong>
        <code>{contact.publicKeyHex}</code>
      </p>
      {contact.note ? <p>{contact.note}</p> : null}
      <p>
        {t("contacts.detail.tagsLabel", { defaultValue: "Tags: " })}
        {contact.tags.join(", ") || t("contacts.detail.tagsEmpty", { defaultValue: "None" })}
      </p>
      <p>
        <strong>short: </strong>
        <code>{formatShortPublicKey(contact.publicKeyHex)}</code>
      </p>
    </div>
  );
}
