// packages/plugin-contacts/src/contactsService.ts
// 联系人服务实现。
//
// 设计缘由：
//   - 联系人按 active key 的 key-scoped DB 隔离；
//   - canonical 身份只有 publicKeyHex；
//   - 不保留 address / publicKeyHex 双语义，不做猜测式迁移；
//   - service 只负责联系人读写，不承担消息 / p2pkh 的投影逻辑。

import type { Contact, ContactInput, ContactsService, KeyspaceService } from "@keymaster/contracts";
import { createContactsDb, openContactsDb, type ContactsDbHandle } from "./contactsDb.js";

export class ContactsDuplicateError extends Error {
  constructor(public readonly publicKeyHex: string) {
    super(`Contact for publicKeyHex ${publicKeyHex} already exists`);
  }
}

export class ContactsNoActiveKeyError extends Error {
  constructor() {
    super("Contacts require an active key");
  }
}

export interface ContactsServiceDeps {
  keyspace: KeyspaceService;
}

export function createContactsService(deps: ContactsServiceDeps): ContactsService {
  const listeners = new Set<() => void>();
  let handle: ContactsDbHandle | undefined;
  let handleFor: string | undefined;

  function notify() {
    for (const l of listeners) l();
  }

  async function getDbForActiveKey(): Promise<ContactsDbHandle> {
    const state = deps.keyspace.active();
    if (!state.activePublicKeyHex) {
      throw new ContactsNoActiveKeyError();
    }
    if (handle && handleFor === state.activePublicKeyHex) {
      return handle;
    }
    if (handle) {
      try {
        handle.close();
      } catch {
        // 静默。
      }
      handle = undefined;
      handleFor = undefined;
    }
    const bundle = await openContactsDb({
      keyspace: deps.keyspace,
      publicKeyHex: state.activePublicKeyHex
    });
    handle = createContactsDb(bundle);
    handleFor = state.activePublicKeyHex;
    return handle;
  }

  deps.keyspace.onActiveKeyChanged((state) => {
    if (handle && state.activePublicKeyHex === handleFor) {
      return;
    }
    if (handle) {
      try {
        handle.close();
      } catch {
        // 静默。
      }
      handle = undefined;
      handleFor = undefined;
    }
    notify();
  });

  return {
    async addContact(input) {
      const db = await getDbForActiveKey();
      const publicKeyHex = input.publicKeyHex.trim().toLowerCase();
      if (!publicKeyHex) throw new Error("publicKeyHex is required");
      if (!input.name.trim()) throw new Error("Name is required");
      const existing = await db.findByPublicKeyHex(publicKeyHex);
      if (existing) throw new ContactsDuplicateError(publicKeyHex);
      const now = new Date().toISOString();
      const contact: Contact = {
        id: crypto.randomUUID(),
        publicKeyHex,
        name: input.name.trim(),
        note: input.note,
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now
      };
      await db.put(contact);
      notify();
      return contact;
    },
    async updateContact(id, input) {
      const db = await getDbForActiveKey();
      const existing = await db.get(id);
      if (!existing) throw new Error(`Contact ${id} not found`);
      const publicKeyHex = input.publicKeyHex.trim().toLowerCase();
      if (!publicKeyHex) throw new Error("publicKeyHex is required");
      if (!input.name.trim()) throw new Error("Name is required");
      const sameIdentity = existing.publicKeyHex === publicKeyHex;
      if (!sameIdentity) {
        const duplicate = await db.findByPublicKeyHex(publicKeyHex);
        if (duplicate && duplicate.id !== id) {
          throw new ContactsDuplicateError(publicKeyHex);
        }
      }
      const updated: Contact = {
        ...existing,
        publicKeyHex,
        name: input.name.trim(),
        note: input.note,
        tags: input.tags ?? existing.tags,
        updatedAt: new Date().toISOString()
      };
      await db.put(updated);
      notify();
      return updated;
    },
    async removeContact(id) {
      const db = await getDbForActiveKey();
      await db.remove(id);
      notify();
    },
    async listContacts() {
      const db = await getDbForActiveKey();
      return db.list();
    },
    async findByPublicKeyHex(publicKeyHex) {
      const db = await getDbForActiveKey();
      return db.findByPublicKeyHex(publicKeyHex.trim().toLowerCase());
    },
    async findByPublicKeyHexes(publicKeyHexes) {
      const db = await getDbForActiveKey();
      return db.findByPublicKeyHexes(publicKeyHexes.map((key) => key.trim().toLowerCase()));
    },
    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
}
