// packages/plugin-contacts/src/ContactDetailPage.tsx
// 单个联系人详情页。
//
// 设计缘由：
//   - 只展示联系人自身字段，不显示 address；
//   - 详情页保留给 contacts 域内部查看与 breadcrumb 解析；
//   - 联系人身份以 publicKeyHex 为准。

import { useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { EmptyState, PageHeader } from "@keymaster/ui";
import { formatShortPublicKey, type Contact } from "@keymaster/contracts";
import { ContactPublicKeyActions } from "./ContactPublicKeyActions.js";

// 不引入 react-router；直接用 location.pathname 解析。
// 路径形态：/contacts/:id

export function ContactDetailPage() {
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  const id = path.split("/").filter(Boolean).pop() ?? "";
  const host = usePluginHost();
  const { t } = useI18n();
  const state = useResourceSelector<Contact | undefined, { contact?: Contact; active: boolean }>(
    host.resourceStore, "contacts.detail", [id],
    (snapshot) => ({ contact: snapshot.data, active: snapshot.key[2] !== "none" }),
    (a, b) => a.contact === b.contact && a.active === b.active
  );
  const contact = state.contact;
  const noActiveKey = !state.active;

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
        actions={<ContactPublicKeyActions contact={contact} />}
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
