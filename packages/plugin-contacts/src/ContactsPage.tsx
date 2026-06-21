// packages/plugin-contacts/src/ContactsPage.tsx
// 联系人列表 + 新增/编辑。
//
// 硬切换 008 收尾：
//   - 接入 keyspace 做页面级 guard：all / 无 active key 模式显示"请选择一个 key"占位。
//   - refresh / remove 都包 try/catch，service 抛 ContactsNoActiveKeyError
//     或其他错时显示错误提示，不让 React 静默吞掉。
//
// 硬切换 003：所有展示文案走 i18n。

import { useCallback, useEffect, useState } from "react";
import { Button, DataTable, EmptyState, Modal, PageHeader, TextInput, type DataTableColumn } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { ActiveKeyState, Contact, ContactInput, ContactsService, KeyspaceService } from "@keymaster/contracts";
import { ContactsDuplicateError } from "./contactsService.js";

export function ContactsPage() {
  const service = useCapability<ContactsService>("contacts.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const { t } = useI18n();
  useI18n().language();
  const [active, setActive] = useState<ActiveKeyState>(keyspace.active());
  const [rows, setRows] = useState<Contact[]>([]);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [draft, setDraft] = useState<ContactInput>({ name: "", address: "", tags: [] });
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRows(await service.listContacts());
      setError(null);
    } catch (err) {
      setRows([]);
      setError(err instanceof Error ? err.message : t("contacts.modal.err.load", { defaultValue: "联系人加载失败" }));
    }
  }, [service, t]);

  useEffect(() => {
    void refresh();
    return service.onChange(refresh);
  }, [refresh, service]);

  useEffect(() => {
    return keyspace.onActiveChange((s) => {
      setActive(s);
      setEditing(null);
      setDraft({ name: "", address: "", tags: [] });
      setError(null);
      setOpen(false);
      void refresh();
    });
  }, [keyspace, refresh]);

  function startNew() {
    setEditing(null);
    setDraft({ name: "", address: "", tags: [] });
    setError(null);
    setOpen(true);
  }

  function startEdit(c: Contact) {
    setEditing(c);
    setDraft({ name: c.name, address: c.address, note: c.note, tags: c.tags });
    setError(null);
    setOpen(true);
  }

  async function save() {
    setError(null);
    try {
      if (editing) {
        await service.updateContact(editing.id, draft);
      } else {
        await service.addContact(draft);
      }
      setOpen(false);
    } catch (err) {
      if (err instanceof ContactsDuplicateError) {
        setError(
          t("contacts.modal.dupAddress", { defaultValue: "地址已存在：" }) + err.address
        );
      } else {
        setError(err instanceof Error ? err.message : t("contacts.modal.err.save", { defaultValue: "保存失败" }));
      }
    }
  }

  async function remove(c: Contact) {
    if (!confirm(t("contacts.modal.confirmDelete", { defaultValue: "删除 " }) + c.name + "?")) return;
    try {
      await service.removeContact(c.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("contacts.modal.err.delete", { defaultValue: "删除失败" }));
    }
  }

  const columns: DataTableColumn<Contact>[] = [
    { key: "name", header: t("contacts.page.col.name", { defaultValue: "名称" }), render: (r) => r.name },
    { key: "address", header: t("contacts.page.col.address", { defaultValue: "地址" }), render: (r) => <code>{r.address}</code> },
    { key: "tags", header: t("contacts.page.col.tags", { defaultValue: "标签" }), render: (r) => r.tags.join(", ") },
    {
      key: "actions",
      header: t("contacts.page.col.actions", { defaultValue: "操作" }),
      render: (r) => (
        <div className="row-actions">
          <Button size="sm" variant="ghost" onClick={() => startEdit(r)}>
            {t("contacts.page.action.edit", { defaultValue: "编辑" })}
          </Button>
          <Button size="sm" variant="danger" onClick={() => remove(r)}>
            {t("contacts.page.action.delete", { defaultValue: "删除" })}
          </Button>
        </div>
      )
    }
  ];

  if (!active.activePublicKeyHex) {
    return (
      <div className="contacts-page">
        <PageHeader
          title={t("contacts.page.title", { defaultValue: "联系人" })}
          description={t("contacts.page.desc", { defaultValue: "按地址管理常用联系人。" })}
        />
        <EmptyState
          title={t("contacts.page.noKey.title", { defaultValue: "请选择一个 key" })}
          description={t("contacts.page.noKey.desc", { defaultValue: "在顶栏切换到任一 key 后即可管理联系人。" })}
        />
      </div>
    );
  }

  return (
    <div className="contacts-page">
      <PageHeader
        title={t("contacts.page.title", { defaultValue: "联系人" })}
        description={t("contacts.page.desc", { defaultValue: "按地址管理常用联系人。" })}
        actions={<Button onClick={startNew}>{t("contacts.page.action.new", { defaultValue: "新增" })}</Button>}
      />
      {error ? <p className="contacts-page__error">{error}</p> : null}
      {rows.length === 0 ? (
        <EmptyState
          title={t("contacts.page.empty.title", { defaultValue: "还没有联系人" })}
          description={t("contacts.page.empty.desc", { defaultValue: "点击右上角新增。" })}
        />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
      )}
      <Modal
        open={open}
        title={editing ? t("contacts.modal.title.edit", { defaultValue: "编辑联系人" }) : t("contacts.modal.title.new", { defaultValue: "新增联系人" })}
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("contacts.modal.action.cancel", { defaultValue: "取消" })}
            </Button>
            <Button onClick={save}>{t("contacts.modal.action.save", { defaultValue: "保存" })}</Button>
          </>
        }
      >
        <TextInput
          label={t("contacts.modal.label.name", { defaultValue: "名称" })}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
        />
        <TextInput
          label={t("contacts.modal.label.address", { defaultValue: "地址" })}
          value={draft.address}
          onChange={(e) => setDraft({ ...draft, address: e.currentTarget.value })}
          error={error ?? undefined}
        />
        <TextInput
          label={t("contacts.modal.label.note", { defaultValue: "备注" })}
          value={draft.note ?? ""}
          onChange={(e) => setDraft({ ...draft, note: e.currentTarget.value })}
        />
        <TextInput
          label={t("contacts.modal.label.tags", { defaultValue: "标签（逗号分隔）" })}
          value={draft.tags?.join(", ") ?? ""}
          onChange={(e) =>
            setDraft({
              ...draft,
              tags: e.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean)
            })
          }
        />
      </Modal>
    </div>
  );
}
