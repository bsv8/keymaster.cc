// packages/plugin-contacts/src/contactsService.ts
// 联系人服务实现。
//
// 设计缘由：
//   - 联系人按 active key 的 key-scoped K-V 隔离；
//   - canonical 身份只有 publicKeyHex；
//   - 不保留 address / publicKeyHex 双语义，不做猜测式迁移；
//   - service 只负责联系人读写，不承担消息 / p2pkh 的投影逻辑。

import type {
  BackgroundTaskDefinition,
  Contact,
  ContactInput,
  ContactPresence,
  ContactPresenceMap,
  ContactsService,
  KeyValueStore,
  KeyspaceService,
  MessageBus,
  ChannelRuntime,
  JSONValue
} from "@keymaster/contracts";
import { newPing } from "bsv8-channel-protocol/ping";
import { createContactsRepository, type ContactsRepositoryHandle } from "./storage/contactsRepository.js";

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
  storage?: KeyValueStore;
  messageBus?: MessageBus;
  /** Coordinator Channel runtime；缺失时联系人 CRUD 仍可用，但不会探测在线状态。 */
  channel?: ChannelRuntime;
}

/** Contacts 在线探测后台任务的构造参数。 */
export interface ContactsPresenceTaskDeps {
  service: ContactsService;
  keyspace: KeyspaceService;
  vault: { status(): string };
}

/** 创建统一后台平台使用的联系人 Ping 任务。 */
export function createContactsPresenceTask(deps: ContactsPresenceTaskDeps): BackgroundTaskDefinition {
  return {
    id: "contacts.presence-probe",
    pluginId: "contacts",
    label: { key: "contacts.task.presence", fallback: "联系人在线探测" },
    description: { key: "contacts.task.presence.description", fallback: "使用固定 Ping/Pong 协议更新联系人在线状态。" },
    schedule: {
      group: "contacts-presence",
      defaultIntervalMs: 5 * 60 * 1000,
      minIntervalMs: 5 * 60 * 1000
    },
    keyScope: () => {
      const publicKeyHex = deps.keyspace.active().activePublicKeyHex;
      return publicKeyHex ? { publicKeyHex } : undefined;
    },
    canRun: () => {
      if (deps.vault.status() !== "unlocked") {
        return { ready: false, reason: { key: "background.blocked.unlock", fallback: "保险箱已锁定" }, retryOn: "unlock" };
      }
      if (deps.keyspace.isInitializing()) {
        return { ready: false, reason: { key: "background.blocked.keyReady", fallback: "密钥空间初始化中" }, retryOn: "key-ready" };
      }
      return deps.keyspace.active().activePublicKeyHex
        ? { ready: true }
        : { ready: false, reason: { key: "background.blocked.noActiveKey", fallback: "没有活跃密钥" }, retryOn: "key-ready" };
    },
    async run(context) {
      await deps.service.probePresence?.({ signal: context.signal });
      context.assertSessionFresh?.();
    }
  };
}

export function createContactsService(deps: ContactsServiceDeps): ContactsService {
  const listeners = new Set<() => void>();
  let handle: ContactsRepositoryHandle | undefined;
  let handleFor: string | undefined;
  const presenceByContact = new Map<string, number>();
  const presenceListeners = new Set<(presence: ContactPresence) => void>();
  let presenceCursor = 0;
  let presenceOwnerPublicKeyHex: string | undefined;

  const PRESENCE_TTL_MS = 10 * 60 * 1000;
  const PRESENCE_MAX_PER_ROUND = 32;
  const PRESENCE_CONCURRENCY = 4;

  function notify() {
    for (const l of listeners) l();
  }

  function currentOwner(): string | undefined {
    return deps.keyspace.active().activePublicKeyHex?.trim().toLowerCase();
  }

  function resetPresence(): void {
    const changedKeys = new Set<string>(presenceByContact.keys());
    presenceByContact.clear();
    presenceCursor = 0;
    presenceOwnerPublicKeyHex = currentOwner();
    for (const publicKeyHex of changedKeys) notifyPresence(publicKeyHex);
  }

  function presenceFor(publicKeyHex: string): ContactPresence {
    const normalized = publicKeyHex.trim().toLowerCase();
    const lastPongAtMs = presenceByContact.get(normalized);
    const now = Date.now();
    const state = lastPongAtMs !== undefined
      && lastPongAtMs <= now
      && now - lastPongAtMs < PRESENCE_TTL_MS
      ? "online"
      : "offline";
    return { publicKeyHex: normalized, state, ...(lastPongAtMs === undefined ? {} : { lastPongAtMs }) };
  }

  function notifyPresence(publicKeyHex: string): void {
    const presence = presenceFor(publicKeyHex);
    for (const listener of presenceListeners) {
      try {
        listener(presence);
      } catch {
        // 单个 UI listener 异常不能影响在线状态真值。
      }
    }
  }

  function isContactPublicKey(value: string): boolean {
    return /^(02|03)[0-9a-f]{64}$/.test(value);
  }

  function subscribeOwnerInbox(): void {
    const owner = currentOwner();
    if (!deps.channel || !owner) return;
    // Contacts 的 system caller 只声明 owner inbox；物理 Supplier/频道
    // 并集由 Coordinator Mux 对账，本 service 不直接收费 Subscribe。
    void deps.channel.subscriptionSet([`bsv8.inbox.${owner}`]).catch(() => undefined);
  }

  function recordVerifiedPong(input: { contactPublicKeyHex: string; receivedAtMs?: number }): void {
    const contactPublicKeyHex = input.contactPublicKeyHex.trim().toLowerCase();
    if (!isContactPublicKey(contactPublicKeyHex) || !currentOwner()) return;
    // 关系、签名、request_message_id 和 TTL 已由 Coordinator 验证；这里
    // 只更新 Contacts 的 presence 投影，不再次解析协议或关联 pending。
    presenceByContact.set(contactPublicKeyHex, input.receivedAtMs ?? Date.now());
    notifyPresence(contactPublicKeyHex);
  }

  async function probeOne(contactPublicKeyHex: string, ownerPublicKeyHex: string, signal?: AbortSignal): Promise<void> {
    if (!deps.channel || signal?.aborted || !isContactPublicKey(contactPublicKeyHex)) return;
    try {
      await deps.channel.publishPrivate({
        recipientPublicKeyHex: contactPublicKeyHex,
        protocol: "bsv8.ping.v1",
        content: newPing() as unknown as JSONValue
      });
      if (currentOwner() !== ownerPublicKeyHex) return;
    } catch {
      // 单个联系人探测失败即为 offline，不重试、不广播。
      if (currentOwner() === ownerPublicKeyHex) notifyPresence(contactPublicKeyHex);
    }
  }

  async function probePresence(input: { signal?: AbortSignal } = {}): Promise<void> {
    const owner = currentOwner();
    if (!owner || !deps.channel || !deps.channel.isReady()) return;
    if (presenceOwnerPublicKeyHex !== owner) resetPresence();
    const contacts = await (await getStoreForActiveKey()).list();
    const eligible = contacts
      .map((contact) => contact.publicKeyHex.trim().toLowerCase())
      .filter(isContactPublicKey);
    if (eligible.length === 0 || input.signal?.aborted) return;
    const start = presenceCursor % eligible.length;
    const selected = Array.from({ length: Math.min(PRESENCE_MAX_PER_ROUND, eligible.length) }, (_, index) => eligible[(start + index) % eligible.length]!);
    presenceCursor = (start + selected.length) % eligible.length;
    for (const publicKeyHex of selected) notifyPresence(publicKeyHex);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (!input.signal?.aborted) {
        const index = nextIndex++;
        const contact = selected[index];
        if (!contact) return;
        await probeOne(contact, owner, input.signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRESENCE_CONCURRENCY, selected.length) }, () => worker()));
  }

  presenceOwnerPublicKeyHex = currentOwner();

  const keyDeletingOff = deps.messageBus?.subscribe<{ publicKeyHex: string }>("key.deleting", ({ publicKeyHex }) => {
    if (!handle || handleFor !== publicKeyHex) return;
    handle = undefined;
    handleFor = undefined;
    notify();
  });

  async function getStoreForActiveKey(): Promise<ContactsRepositoryHandle> {
    const state = deps.keyspace.active();
    if (!state.activePublicKeyHex) {
      throw new ContactsNoActiveKeyError();
    }
    if (handle && handleFor === state.activePublicKeyHex) {
      return handle;
    }
    if (!deps.storage) throw new ContactsNoActiveKeyError();
    handle ??= createContactsRepository(deps.storage);
    handleFor = state.activePublicKeyHex;
    return handle;
  }

  subscribeOwnerInbox();
  const offActiveKeyChanged = deps.keyspace.onActiveKeyChanged((state) => {
    if (state.activePublicKeyHex !== presenceOwnerPublicKeyHex) resetPresence();
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
    subscribeOwnerInbox();
    notify();
  });

  return {
    async addContact(input) {
      const contactRepository = await getStoreForActiveKey();
      const publicKeyHex = input.publicKeyHex.trim().toLowerCase();
      if (!publicKeyHex) throw new Error("publicKeyHex is required");
      if (!input.name.trim()) throw new Error("Name is required");
      const existing = await contactRepository.findByPublicKeyHex(publicKeyHex);
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
      await contactRepository.put(contact);
      notify();
      return contact;
    },
    async updateContact(id, input) {
      const contactRepository = await getStoreForActiveKey();
      const existing = await contactRepository.get(id);
      if (!existing) throw new Error(`Contact ${id} not found`);
      const publicKeyHex = input.publicKeyHex.trim().toLowerCase();
      if (!publicKeyHex) throw new Error("publicKeyHex is required");
      if (!input.name.trim()) throw new Error("Name is required");
      const sameIdentity = existing.publicKeyHex === publicKeyHex;
      if (!sameIdentity) {
        const duplicate = await contactRepository.findByPublicKeyHex(publicKeyHex);
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
      await contactRepository.put(updated);
      notify();
      return updated;
    },
    async removeContact(id) {
      const contactRepository = await getStoreForActiveKey();
      await contactRepository.remove(id);
      notify();
    },
    async listContacts() {
      const contactRepository = await getStoreForActiveKey();
      return contactRepository.list();
    },
    async findByPublicKeyHex(publicKeyHex) {
      const contactRepository = await getStoreForActiveKey();
      return contactRepository.findByPublicKeyHex(publicKeyHex.trim().toLowerCase());
    },
    async findByPublicKeyHexes(publicKeyHexes) {
      const contactRepository = await getStoreForActiveKey();
      return contactRepository.findByPublicKeyHexes(publicKeyHexes.map((key) => key.trim().toLowerCase()));
    },
    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    getPresence(publicKeyHex) {
      return presenceFor(publicKeyHex);
    },
    async getPresenceSnapshot(): Promise<ContactPresenceMap> {
      if (!currentOwner()) return {};
      const contacts = await (await getStoreForActiveKey()).list();
      const presence: Record<string, ContactPresence> = {};
      for (const contact of contacts) {
        const publicKeyHex = contact.publicKeyHex.trim().toLowerCase();
        presence[publicKeyHex] = presenceFor(publicKeyHex);
      }
      return presence;
    },
    onPresenceChange(handler) {
      presenceListeners.add(handler);
      return () => presenceListeners.delete(handler);
    },
    recordVerifiedPong,
    probePresence,
    resetPresence,
    dispose() {
      keyDeletingOff?.();
      offActiveKeyChanged();
      presenceListeners.clear();
      if (handle) {
        try { handle.close(); } catch { /* noop */ }
        handle = undefined;
        handleFor = undefined;
      }
    }
  };
}
