// packages/plugin-contacts/src/contactsService.ts
// 联系人服务实现（硬切换 008 收尾 + 硬切换 005 收尾）。
//
// 关键设计：
//   - 数据按 key namespace 隔离：contacts 存储在 key-scoped DB 内。
//   - 所有读写（addContact / updateContact / removeContact / listContacts /
//     findByAddress）都要求有 active publicKeyHex；缺失时抛
//     ContactsNoActiveKeyError（保留错误类型以兼容旧 i18n / 调用方）。
//   - 硬切换 005 收尾：删掉 all-mode 分支。activePublicKeyHex 缺失是
//     异常态，由壳层 AppShell 守卫（uninitialized / 修复/管理态），本
//     service 只在收到具体的 active key 后才正常服务；旧的 `mode === "all"`
//     分支不再存在。
//   - UI 仍然做 keyspace guard：调用前检查 activePublicKeyHex 存在，
//     订阅 onActiveChange 清空本地缓存并重新拉取。
//   - 切 active key 时发 onChange 通知 UI 重新拉。
//   - key.deleting / key.deleted 事件不做事：namespace DB 由 keyspace 整体删。

import type { Contact, ContactInput, ContactsService, KeyspaceService } from "@keymaster/contracts";
import { createContactsDb, openContactsDb, type ContactsDbHandle } from "./contactsDb.js";

export class ContactsDuplicateError extends Error {
  constructor(public readonly address: string) {
    super(`Contact for address ${address} already exists`);
  }
}

export class ContactsNoActiveKeyError extends Error {
  constructor() {
    super("Contacts require an active key; the shell guard should have prevented this call");
  }
}

export interface ContactsServiceDeps {
  keyspace: KeyspaceService;
}

export function createContactsService(deps: ContactsServiceDeps): ContactsService {
  const listeners = new Set<() => void>();
  // 缓存当前 namespace 的 db handle；切 active key 时由 handle 内部 close。
  let handle: ContactsDbHandle | undefined;
  let handleFor: string | undefined;

  function notify() {
    for (const l of listeners) l();
  }

  /**
   * 取得当前 namespace 的 db handle：active key 缺失时抛
   * ContactsNoActiveKeyError。
   *
   * 硬切换 005 收尾：不再区分 single / all 模式——无 active key 唯一指
   * "activePublicKeyHex 缺失"；壳层 AppShell 会拦截该情况，service 内部
   * 仍 fail-closed 抛 ContactsNoActiveKeyError。
   */
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
        // 静默
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

  // 监听 active key 变化：清空 handle + 通知监听者。
  deps.keyspace.onActiveChange((state) => {
    if (handle && state.activePublicKeyHex === handleFor) {
      // 未切换
      return;
    }
    if (handle) {
      try {
        handle.close();
      } catch {
        // 静默
      }
      handle = undefined;
      handleFor = undefined;
    }
    notify();
  });

  return {
    async addContact(input) {
      if (!input.address) throw new Error("Address is required");
      const db = await getDbForActiveKey();
      const existing = await db.findByAddress(input.address);
      if (existing) throw new ContactsDuplicateError(input.address);
      const now = new Date().toISOString();
      const publicKeyHex = deps.keyspace.active().activePublicKeyHex;
      const contact: Contact = {
        id: crypto.randomUUID(),
        name: input.name,
        address: input.address,
        note: input.note,
        tags: input.tags ?? [],
        publicKeyHex,
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
      const publicKeyHex = deps.keyspace.active().activePublicKeyHex;
      const updated: Contact = {
        ...existing,
        name: input.name,
        address: input.address,
        note: input.note,
        tags: input.tags ?? existing.tags,
        publicKeyHex,
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
    async findByAddress(address) {
      const db = await getDbForActiveKey();
      return db.findByAddress(address);
    },
    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    }
  };
}
