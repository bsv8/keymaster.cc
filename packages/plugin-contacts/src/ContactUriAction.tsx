import { useEffect, useState } from "react";
import { Button } from "@keymaster/ui";
import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n } from "@keymaster/runtime";
import { CONTACTS_SERVICE_CAPABILITY, formatShortPublicKey, type Contact } from "@keymaster/contracts";
import { ContactsEditor } from "./ContactsEditor.js";
export function ContactUriAction({ publicKeyHex, close }: { publicKeyHex: string; close: () => void }) {
 const { t } = usePluginI18n();
 const service = usePluginCapability(CONTACTS_SERVICE_CAPABILITY);
 const [contact, setContact] = useState<Contact>();
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string>();
 const [editing, setEditing] = useState(false);
 useEffect(() => {
   let cancelled = false; setLoading(true); setError(undefined);
   void service.findByPublicKeyHex(publicKeyHex).then(value => { if (!cancelled) setContact(value); }).catch(() => { if (!cancelled) setError(t("contacts.uri.loadError")); }).finally(() => { if (!cancelled) setLoading(false); });
   return () => { cancelled = true; };
 }, [publicKeyHex, service, t]);
 return <section data-testid="contact-uri-action">
   <code title={publicKeyHex}>{formatShortPublicKey(publicKeyHex)}</code>
   {loading ? <p>{t("contacts.uri.loading")}</p> : error ? <p role="alert">{error}</p> : <>
     <p>{contact?.name ?? t("contacts.uri.notSaved")}</p>
     <Button onClick={() => setEditing(true)}>{t(contact ? "contacts.uri.edit" : "contacts.uri.save")}</Button>
   </>}
   <ContactsEditor open={editing} mode={contact ? "edit" : "create"} publicKeyHex={publicKeyHex} onClose={() => setEditing(false)} onSaved={saved => { setContact(saved); setEditing(false); }} />
   <Button variant="ghost" onClick={close}>{t("contacts.uri.done")}</Button>
 </section>;
}
