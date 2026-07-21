import { useState } from "react";
import { Button } from "@keymaster/ui";
import { useI18n, usePluginHost, useRegistry } from "@keymaster/runtime";
import type { Contact, ContactPublicKeyAction } from "@keymaster/contracts";

const COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-f]{64}$/i;

export function ContactPublicKeyActions({ contact }: { contact: Contact }) {
  const host = usePluginHost();
  const { t } = useI18n();
  const actions = useRegistry((h) => h.contactPublicKeyActions.list());
  const [pending, setPending] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const valid = COMPRESSED_PUBLIC_KEY.test(contact.publicKeyHex);

  if (!valid) {
    console.warn("Invalid contact publicKeyHex", contact.id);
    return null;
  }

  async function run(action: ContactPublicKeyAction) {
    if (pending) return;
    setPending(action.id);
    setError(undefined);
    try { await action.run({ publicKeyHex: contact.publicKeyHex.trim().toLowerCase() }); }
    catch (err) {
      console.error("Contact public-key action failed", action.id, err);
      setError(t("contacts.page.actionFailed", { defaultValue: "操作失败" }));
    } finally { setPending(undefined); }
  }

  return (
    <span className="contact-public-key-actions">
      {actions.map((action) => (
        <Button key={action.id} size="sm" variant="ghost" disabled={Boolean(pending)} onClick={() => void run(action)}>
          {host.i18n.text(action.label)}
        </Button>
      ))}
      {error ? <span role="alert" className="contacts-page__error">{error}</span> : null}
    </span>
  );
}
