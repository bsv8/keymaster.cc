// packages/plugin-contacts/src/ContactsPage.tsx
// 联系人列表页。
//
// 设计缘由：
//   - 这里是联系人域的主入口，只负责列表、删除和打开编辑器；
//   - 表单实现收口到 ContactsEditor，避免消息页再复制一套联系人 modal；
//   - 联系人身份只显示 publicKeyHex，不再展示 address。

import { useState } from "react";
import { Button, DataTable, EmptyState, PageHeader, type DataTableColumn } from "@keymaster/ui";
import { AppLink, useCapability, useI18n, usePluginHost, useResourceSelector } from "@keymaster/runtime";
import { formatShortPublicKey, type Contact, type ContactPresenceMap, type ContactsService } from "@keymaster/contracts";
import { ContactsEditor } from "./ContactsEditor.js";
import { ContactPublicKeyActions } from "./ContactPublicKeyActions.js";

export function ContactsPage() {
  const service = useCapability<ContactsService>("contacts.service");
  const host = usePluginHost();
  const { t } = useI18n();
  const listState = useResourceSelector<Contact[], { rows: Contact[]; active: boolean; error?: string }>(
    host.resourceStore, "contacts.list", [],
    (snapshot) => ({ rows: snapshot.data ?? [], active: snapshot.key[2] !== "none", error: snapshot.error?.message }),
    (a, b) => a.active === b.active && a.error === b.error && a.rows === b.rows
  );
  const { rows, active } = listState;
  const presenceByPublicKey = useResourceSelector<ContactPresenceMap, ContactPresenceMap>(
    host.resourceStore, "contacts.presence", [],
    (snapshot) => snapshot.data ?? {},
    (a, b) => a === b
  );
  const [editing, setEditing] = useState<Contact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  function startNew() {
    setEditing(null);
    setError(null);
    setOpen(true);
  }

  function startEdit(c: Contact) {
    setEditing(c);
    setError(null);
    setOpen(true);
  }

  async function remove(c: Contact) {
    if (!confirm(t("contacts.page.confirmDelete", { defaultValue: "Delete " }) + c.name + "?")) return;
    try {
      await service.removeContact(c.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("contacts.page.err.delete", { defaultValue: "Delete failed" }));
    }
  }

  const columns: DataTableColumn<Contact>[] = [
    {
      key: "name",
      header: t("contacts.page.col.name", { defaultValue: "Name" }),
      render: (r) => (
        <AppLink to={`/contacts/${encodeURIComponent(r.id)}`}>
          {r.name}
        </AppLink>
      )
    },
    {
      key: "presence",
      header: t("contacts.page.col.presence", { defaultValue: "Status" }),
      render: (r) => {
        const presence = presenceByPublicKey[r.publicKeyHex.trim().toLowerCase()];
        const state = presence?.state ?? "offline";
        return <span data-contact-presence={state}>{t(`contacts.presence.${state}`, { defaultValue: state })}</span>;
      }
    },
    {
      key: "publicKeyHex",
      header: t("contacts.page.col.publicKeyHex", { defaultValue: "publicKeyHex" }),
      render: (r) => <code>{formatShortPublicKey(r.publicKeyHex)}</code>
    },
    { key: "tags", header: t("contacts.page.col.tags", { defaultValue: "Tags" }), render: (r) => r.tags.join(", ") },
    {
      key: "actions",
      header: t("contacts.page.col.actions", { defaultValue: "Actions" }),
      render: (r) => (
        <div className="row-actions">
          <ContactPublicKeyActions contact={r} />
          <Button size="sm" variant="ghost" onClick={() => startEdit(r)}>
            {t("contacts.page.action.edit", { defaultValue: "Edit" })}
          </Button>
          <Button size="sm" variant="danger" onClick={() => remove(r)}>
            {t("contacts.page.action.delete", { defaultValue: "Delete" })}
          </Button>
        </div>
      )
    }
  ];

  if (!active) {
    return (
      <div className="contacts-page">
        <PageHeader
          title={t("contacts.page.title", { defaultValue: "Contacts" })}
          description={t("contacts.page.desc", { defaultValue: "Manage contacts by publicKeyHex." })}
        />
        <EmptyState
          title={t("contacts.page.noKey.title", { defaultValue: "Pick a key" })}
          description={t("contacts.page.noKey.desc", { defaultValue: "Switch to any key from the topbar to manage contacts." })}
        />
      </div>
    );
  }

  return (
    <div className="contacts-page">
      <PageHeader
        title={t("contacts.page.title", { defaultValue: "Contacts" })}
        description={t("contacts.page.desc", { defaultValue: "Manage contacts by publicKeyHex." })}
        actions={<Button onClick={startNew}>{t("contacts.page.action.new", { defaultValue: "New" })}</Button>}
      />
      {error ? <p className="contacts-page__error">{error}</p> : null}
      {rows.length === 0 ? (
        <EmptyState
          title={t("contacts.page.empty.title", { defaultValue: "No contacts yet" })}
          description={t("contacts.page.empty.desc", { defaultValue: "Click \"New\" in the top right to add one." })}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
      )}
      <ContactsEditor
        open={open}
        mode={editing ? "edit" : "create"}
        contactId={editing?.id}
        publicKeyHex={editing?.publicKeyHex}
        onClose={() => setOpen(false)}
        onSaved={async () => {
          setOpen(false);
          setEditing(null);
          // The resource subscription observes the service change event.
        }}
      />
    </div>
  );
}
