// packages/plugin-contacts/src/ContactDetailPage.tsx
// 单个联系人详情页。
//
// 设计缘由：
//   - 只展示联系人自身字段，不显示 address；
//   - 详情页保留给 contacts 域内部查看与 breadcrumb 解析；
//   - 联系人身份以 publicKeyHex 为准。

import { useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { EmptyState, PageHeader } from "@keymaster/ui";
import type { Contact, ContactPresenceMap } from "@keymaster/contracts";
import { ContactPublicKeyActions } from "./ContactPublicKeyActions.js";

// 不引入 react-router；直接用 location.pathname 解析。
// 路径形态：/contacts/:id

export function ContactDetailPage() {
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  const id = path.split("/").filter(Boolean).pop() ?? "";
  const host = usePluginHost();
  const i18n = useI18n();
  const { t } = i18n;
  const state = useResourceSelector<Contact | undefined, { contact?: Contact; active: boolean }>(
    host.resourceStore, "contacts.detail", [id],
    (snapshot) => ({ contact: snapshot.data, active: snapshot.key[2] !== "none" }),
    (a, b) => a.contact === b.contact && a.active === b.active
  );
  const contact = state.contact;
  const noActiveKey = !state.active;
  const presenceByPublicKey = useResourceSelector<ContactPresenceMap, ContactPresenceMap>(
    host.resourceStore, "contacts.presence", [],
    (snapshot) => snapshot.data ?? {},
    (a, b) => a === b
  );

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

  const initials = getContactInitials(contact.name);
  const locale = i18n.language();
  const presence = presenceByPublicKey[contact.publicKeyHex.trim().toLowerCase()] ?? {
    publicKeyHex: contact.publicKeyHex.trim().toLowerCase(),
    state: "offline" as const
  };

  return (
    <div className="contact-detail contact-detail--ready">
      <PageHeader
        title={contact.name}
        description={t("contacts.detail.desc", { defaultValue: "Contact identity and saved details." })}
        actions={<ContactPublicKeyActions contact={contact} />}
      />

      <main className="contact-detail__content">
        <section className="contact-detail__identity" aria-labelledby="contact-detail-identity-title">
          <div className="contact-detail__avatar" aria-hidden="true">{initials}</div>
          <div className="contact-detail__identity-copy">
            <h2 id="contact-detail-identity-title" className="contact-detail__section-label">
              {t("contacts.detail.identity", { defaultValue: "Identity" })}
            </h2>
            <p className="contact-detail__key-label">
              {t("contacts.detail.publicKeyHex", { defaultValue: "Public key" })}
            </p>
            <code className="contact-detail__public-key">{contact.publicKeyHex}</code>
            <span className="contact-detail__presence" data-contact-presence={presence.state}>
              {t(`contacts.presence.${presence.state}`, { defaultValue: presence.state })}
            </span>
          </div>
        </section>

        <section className="contact-detail__details" aria-labelledby="contact-detail-details-title">
          <h2 id="contact-detail-details-title" className="contact-detail__section-title">
            {t("contacts.detail.details", { defaultValue: "Contact details" })}
          </h2>
          <dl className="contact-detail__definition-list">
            <div className="contact-detail__definition-row">
              <dt>{t("contacts.detail.note", { defaultValue: "Note" })}</dt>
              <dd className="contact-detail__note">
                {contact.note?.trim() || t("contacts.detail.noteEmpty", { defaultValue: "No note added." })}
              </dd>
            </div>
            <div className="contact-detail__definition-row">
              <dt>{t("contacts.detail.tagsLabel", { defaultValue: "Tags" })}</dt>
              <dd>
                {contact.tags.length > 0 ? (
                  <span className="contact-detail__tags">
                    {contact.tags.map((tag) => (
                      <span className="contact-detail__tag" key={tag}>{tag}</span>
                    ))}
                  </span>
                ) : t("contacts.detail.tagsEmpty", { defaultValue: "None" })}
              </dd>
            </div>
            <div className="contact-detail__definition-row">
              <dt>{t("contacts.detail.createdAt", { defaultValue: "Created" })}</dt>
              <dd><time dateTime={contact.createdAt}>{formatContactDate(contact.createdAt, locale)}</time></dd>
            </div>
            <div className="contact-detail__definition-row">
              <dt>{t("contacts.detail.updatedAt", { defaultValue: "Last updated" })}</dt>
              <dd><time dateTime={contact.updatedAt}>{formatContactDate(contact.updatedAt, locale)}</time></dd>
            </div>
          </dl>
        </section>
      </main>
    </div>
  );
}

function getContactInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.slice(0, 2).map((word) => Array.from(word)[0] ?? "").join("").toUpperCase();
  }
  return Array.from(words[0] ?? "?").slice(0, 2).join("").toUpperCase();
}

function formatContactDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}
