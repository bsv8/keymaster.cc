// packages/plugin-contacts/src/ContactsEditor.tsx
// 联系人编辑器：新建 / 编辑共用的唯一表单实现。
//
// 设计缘由：
//   - 表单、校验、重复检查、保存逻辑都归 contacts 域；
//   - 其它插件只通过 capability 打开，不复制联系人表单；
//   - create / edit 两种模式共享一套字段，避免消息页再长出第二套联系人 modal。

import { useEffect, useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { useCapability, useI18n } from "@keymaster/runtime";
import type { Contact, ContactInput, ContactsService } from "@keymaster/contracts";
import type { KeyspaceService } from "@keymaster/contracts";
import { ContactsDuplicateError } from "./contactsService.js";

export interface ContactsEditorProps {
  open: boolean;
  mode: "create" | "edit";
  publicKeyHex?: string;
  contactId?: string;
  onClose: () => void;
  onSaved: (contact: Contact) => void;
}

interface DraftState extends ContactInput {}

const EMPTY_DRAFT: DraftState = {
  publicKeyHex: "",
  name: "",
  note: "",
  tags: []
};

export function ContactsEditor(props: ContactsEditorProps): JSX.Element | null {
  const service = useCapability<ContactsService>("contacts.service");
  const keyspace = useCapability<KeyspaceService>("keyspace.service");
  const { t } = useI18n();
  useI18n().language();
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Contact | null>(null);
  const [boundActivePublicKeyHex, setBoundActivePublicKeyHex] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      setDraft(EMPTY_DRAFT);
      setError(null);
      setCurrent(null);
      setBoundActivePublicKeyHex(null);
      return;
    }
    let cancelled = false;
    const openedFor = keyspace.active().activePublicKeyHex ?? null;
    setBoundActivePublicKeyHex(openedFor);
    setError(null);
    setLoading(true);
    void service
      .listContacts()
      .then((list) => {
        if (cancelled) return;
        const found =
          props.contactId ? list.find((c) => c.id === props.contactId) : undefined;
        const next =
          found ?? (props.publicKeyHex ? list.find((c) => c.publicKeyHex === props.publicKeyHex) : undefined);
        setCurrent(next ?? null);
        if (props.mode === "edit") {
          if (!next) {
            setError(t("contacts.editor.err.notFound", { defaultValue: "Contact not found" }));
            setDraft({
              publicKeyHex: props.publicKeyHex ?? "",
              name: "",
              note: "",
              tags: []
            });
          } else {
            setDraft({
              publicKeyHex: next.publicKeyHex,
              name: next.name,
              note: next.note ?? "",
              tags: next.tags
            });
          }
        } else {
          setDraft({
            publicKeyHex: props.publicKeyHex ?? "",
            name: "",
            note: "",
            tags: []
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrent(null);
          setDraft({
            publicKeyHex: props.publicKeyHex ?? "",
            name: "",
            note: "",
            tags: []
          });
          setError(t("contacts.editor.err.load", { defaultValue: "Failed to load contact" }));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [keyspace, props.contactId, props.mode, props.open, props.publicKeyHex, service, t]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    return keyspace.onActiveChange((state) => {
      const nextActivePublicKeyHex = state.activePublicKeyHex ?? null;
      if (boundActivePublicKeyHex && nextActivePublicKeyHex !== boundActivePublicKeyHex) {
        // active key 变化后，编辑器必须立即收口，不能继续暴露旧草稿。
        setDraft(EMPTY_DRAFT);
        setError(null);
        setCurrent(null);
        setLoading(false);
        setBoundActivePublicKeyHex(null);
        props.onClose();
      }
    });
  }, [boundActivePublicKeyHex, keyspace, props.onClose, props.open]);

  async function save() {
    setError(null);
    try {
      const currentActivePublicKeyHex = keyspace.active().activePublicKeyHex ?? null;
      if (!boundActivePublicKeyHex || currentActivePublicKeyHex !== boundActivePublicKeyHex) {
        setError(
          t("contacts.editor.err.keyChanged", { defaultValue: "Active key changed. Please reopen the editor." })
        );
        return;
      }
      const input: ContactInput = {
        publicKeyHex: draft.publicKeyHex.trim(),
        name: draft.name.trim(),
        note: draft.note?.trim() || undefined,
        tags: draft.tags ?? []
      };
      if (!input.publicKeyHex) {
        setError(t("contacts.editor.err.publicKeyHex", { defaultValue: "publicKeyHex is required" }));
        return;
      }
      if (!input.name) {
        setError(t("contacts.editor.err.name", { defaultValue: "Name is required" }));
        return;
      }
      if (props.mode === "edit" && !current) {
        setError(t("contacts.editor.err.notFound", { defaultValue: "Contact not found" }));
        return;
      }
      const saved =
        props.mode === "edit"
          ? await service.updateContact(current!.id, input)
          : await service.addContact(input);
      props.onSaved(saved);
    } catch (err) {
      if (err instanceof ContactsDuplicateError) {
        setError(
          t("contacts.editor.err.duplicate", { defaultValue: "Contact already exists: " }) +
            err.publicKeyHex
        );
        } else {
          setError(err instanceof Error ? err.message : t("contacts.editor.err.save", { defaultValue: "Save failed" }));
        }
      }
  }

  return (
    <Modal
      open={props.open}
      title={
        props.mode === "edit"
          ? t("contacts.modal.title.edit", { defaultValue: "Edit contact" })
          : t("contacts.modal.title.new", { defaultValue: "New contact" })
      }
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {t("contacts.modal.action.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button onClick={() => void save()} loading={loading}>
            {t("contacts.modal.action.save", { defaultValue: "Save" })}
          </Button>
        </>
      }
    >
      <TextInput
        label={t("contacts.modal.label.publicKeyHex", { defaultValue: "Contact publicKeyHex" })}
        value={draft.publicKeyHex}
        onChange={(e) => setDraft({ ...draft, publicKeyHex: e.currentTarget.value.trim() })}
      />
      <TextInput
        label={t("contacts.modal.label.name", { defaultValue: "Name" })}
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
      />
      <TextInput
        label={t("contacts.modal.label.note", { defaultValue: "Note" })}
        value={draft.note ?? ""}
        onChange={(e) => setDraft({ ...draft, note: e.currentTarget.value })}
      />
      <TextInput
        label={t("contacts.modal.label.tags", { defaultValue: "Tags (comma-separated)" })}
        value={draft.tags?.join(", ") ?? ""}
        onChange={(e) =>
          setDraft({
            ...draft,
            tags: e.currentTarget.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          })
        }
        error={error ?? undefined}
      />
    </Modal>
  );
}
