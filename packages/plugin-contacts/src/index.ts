// packages/plugin-contacts/src/index.ts
export { contactsPlugin, contactsSetup, CONTACTS_CAPABILITY, CONTACTS_PICKER, CONTACTS_EDITOR } from "./manifest.js";
export type { ContactsEditorProps } from "@keymaster/contracts";
export { createContactsService, createContactsPresenceTask } from "./contactsService.js";
