import { sameWalletSession, type VaultLifecycleSnapshot } from "@keymaster/contracts";
import { useWalletState } from "@keymaster/runtime";
// packages/plugin-contacts/src/ContactsEditor.tsx
// 联系人编辑器：新建 / 编辑共用的唯一表单实现。
//
// 设计缘由：
//   - 表单、校验、重复检查、保存逻辑都归 contacts 域；
//   - 其它插件只通过 capability 打开，不复制联系人表单；
//   - create / edit 两种模式共享一套字段，避免消息页再长出第二套联系人 modal。

import { useEffect, useRef, useState } from "react";
import { Button, Modal, TextInput } from "@keymaster/ui";
import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n } from "@keymaster/runtime";
import { CONTACTS_SERVICE_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, type Contact, type ContactInput } from "@keymaster/contracts";
import { ContactsDuplicateError } from "./contactsService.js";

export interface ContactsEditorProps {
  open: boolean;
  mode: "create" | "edit";
  publicKeyHex?: string;
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
  const service = usePluginCapability(CONTACTS_SERVICE_CAPABILITY);
  const walletState = useWalletState();
  const { t } = usePluginI18n();
  const generation = useRef(0);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Contact | null>(null);
  const boundSession = useRef<Readonly<VaultLifecycleSnapshot> | undefined>(undefined);
  const [boundActivePublicKeyHex, setBoundActivePublicKeyHex] = useState<string | null>(null);

  // A closed, replaced or revoked editor must ignore a pending save completion.
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [props.open, props.mode, props.publicKeyHex, service, walletState]);

  // @resource-boundary allow: active-key-editor-safety
  useEffect(() => {
    if (!props.open) {
      setDraft(EMPTY_DRAFT);
      setError(null);
      setCurrent(null);
      setBoundActivePublicKeyHex(null);
      return;
    }
    let cancelled = false;
    const openedSession = walletState.snapshot();
    boundSession.current = openedSession;
    const openedFor = openedSession.activePublicKeyHex ?? null;
    setBoundActivePublicKeyHex(openedFor);
    setError(null);
    setLoading(true);
    void service
      .listContacts()
      .then((list) => {
        if (cancelled || !sameWalletSession(openedSession, walletState.snapshot())) return;
        const next = props.publicKeyHex ? list.find((c) => c.publicKeyHex === props.publicKeyHex) : undefined;
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
        if (!cancelled && sameWalletSession(openedSession, walletState.snapshot())) {
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
        if (!cancelled && sameWalletSession(openedSession, walletState.snapshot())) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [walletState, props.mode, props.open, props.publicKeyHex, service, t]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    return walletState.subscribe((state) => {
      if (boundSession.current && !sameWalletSession(boundSession.current, state)) {
        // active key 变化后，编辑器必须立即收口，不能继续暴露旧草稿。
        generation.current += 1;
        boundSession.current = undefined;
        setDraft(EMPTY_DRAFT);
        setError(null);
        setCurrent(null);
        setLoading(false);
        setBoundActivePublicKeyHex(null);
        props.onClose();
      }
    });
  }, [boundActivePublicKeyHex, walletState, props.onClose, props.open]);

  async function save() {
    const savingGeneration = generation.current;
    const savingSession = boundSession.current;
    setError(null);
    try {
      const currentActivePublicKeyHex = walletState.snapshot().activePublicKeyHex ?? null;
      if (!savingSession || !sameWalletSession(savingSession, walletState.snapshot()) || !boundActivePublicKeyHex || currentActivePublicKeyHex !== boundActivePublicKeyHex) {
        setError(
          t("contacts.editor.err.keyChanged", { defaultValue: "Active key changed. Please reopen the editor." })
        );
        return;
      }
      const input: ContactInput = {
        publicKeyHex: draft.publicKeyHex.trim().toLowerCase(),
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
          ? await service.updateContact(current!.publicKeyHex, input)
          : await service.addContact(input);
      if (generation.current !== savingGeneration || !savingSession || !sameWalletSession(savingSession, walletState.snapshot())) return;
      props.onSaved(saved);
    } catch (err) {
      if (generation.current !== savingGeneration) return;
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
        disabled={loading || !boundActivePublicKeyHex}
        onChange={(e) => {
          const publicKeyHex = e.currentTarget.value.trim();
          setDraft((currentDraft) => ({ ...currentDraft, publicKeyHex }));
        }}
      />
      <TextInput
        label={t("contacts.modal.label.name", { defaultValue: "Name" })}
        value={draft.name}
        disabled={loading || !boundActivePublicKeyHex}
        onChange={(e) => {
          const name = e.currentTarget.value;
          setDraft((currentDraft) => ({ ...currentDraft, name }));
        }}
      />
      <TextInput
        label={t("contacts.modal.label.note", { defaultValue: "Note" })}
        value={draft.note ?? ""}
        disabled={loading || !boundActivePublicKeyHex}
        onChange={(e) => {
          const note = e.currentTarget.value;
          setDraft((currentDraft) => ({ ...currentDraft, note }));
        }}
      />
      <TextInput
        label={t("contacts.modal.label.tags", { defaultValue: "Tags (comma-separated)" })}
        value={draft.tags?.join(", ") ?? ""}
        disabled={loading || !boundActivePublicKeyHex}
        onChange={(e) => {
          const tags = e.currentTarget.value
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          setDraft((currentDraft) => ({ ...currentDraft, tags }));
        }}
        error={error ?? undefined}
      />
    </Modal>
  );
}
