import { useContactsResources } from "./ContactsResourceContext.js";
import { usePluginCapability } from "webloom-framework/react";
import { CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY } from "@keymaster/contracts";
import { useState } from "react";
import { Button } from "@keymaster/ui";
import { usePluginI18n, useResourceViewSelector } from "@keymaster/runtime";
import type { Contact, ContactPublicKeyAction } from "@keymaster/contracts";

const COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-f]{64}$/i;

export function ContactPublicKeyActions({ contact }: { contact: Contact }) {
  const registry = usePluginCapability(CONTACT_PUBLIC_KEY_ACTION_REGISTRY_CAPABILITY);
  const { t, text } = usePluginI18n();
  const actions = useResourceViewSelector<ContactPublicKeyAction[], ContactPublicKeyAction[]>(
    useContactsResources(), "contacts.public-key-actions", [], snapshot => snapshot.data ?? [],
  );
  const [pending, setPending] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const valid = COMPRESSED_PUBLIC_KEY.test(contact.publicKeyHex);

  if (!valid) {
    console.warn("Invalid contact publicKeyHex", contact.publicKeyHex);
    return null;
  }

  async function run(action: ContactPublicKeyAction) {
    // A resource snapshot may still contain the previous contribution during invalidation.
    if (pending || registry.get(action.id) !== action) return;
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
          {text(action.label)}
        </Button>
      ))}
      {error ? <span role="alert" className="contacts-page__error">{error}</span> : null}
    </span>
  );
}
