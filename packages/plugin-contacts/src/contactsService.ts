import { sameWalletSession } from "@keymaster/contracts";
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
  BorrowedOwnerFileStore,
  VaultWalletState,
  ContactsPresenceChannel,
  JSONValue
} from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import { newPing } from "bsv8-channel-protocol/ping";
import { createContactsRepository, normalizeContactInput, type ContactsRepositoryHandle } from "./storage/contactsRepository.js";

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
  walletState: VaultWalletState;
  storage: BorrowedOwnerFileStore;
  messageBus?: MessageBus;
  /** Coordinator Channel runtime；缺失时联系人 CRUD 仍可用，但不会探测在线状态。 */
  channel?: ContactsPresenceChannel;
}

/** Contacts 在线探测后台任务的构造参数。 */
export interface ContactsPresenceTaskDeps {
  service: ContactsService;
  walletState: VaultWalletState;
  vault: { status(): string };
}

/** 创建统一后台平台使用的联系人 Ping 任务。 */
export function createContactsPresenceTask(deps: ContactsPresenceTaskDeps): BackgroundTaskDefinition & { unitId: string } {
  return {
    id: "contacts.presence-probe",
    pluginId: "contacts",
    unitId: "contacts.coordinator-worker",
    label: { key: "contacts.task.presence", fallback: "联系人在线探测" },
    description: { key: "contacts.task.presence.description", fallback: "使用固定 Ping/Pong 协议更新联系人在线状态。" },
    schedule: {
      group: "contacts-presence",
      defaultIntervalMs: 5 * 60 * 1000,
      minIntervalMs: 5 * 60 * 1000
    },
    keyScope: () => {
      const publicKeyHex = deps.walletState.snapshot().activePublicKeyHex;
      return publicKeyHex ? { publicKeyHex } : undefined;
    },
    canRun: () => {
      if (deps.vault.status() !== "unlocked") {
        return { ready: false, reason: { key: "background.blocked.unlock", fallback: "保险箱已锁定" }, retryOn: "unlock" };
      }
      return deps.walletState.snapshot().activePublicKeyHex
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
  if (!deps.storage) throw new Error("Contacts central storage binding is required");
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

  let disposed = false;
  function operationFence() {
    const session = deps.walletState.snapshot();
    return () => { if (disposed || !sameWalletSession(session, deps.walletState.snapshot())) throw new Error("Contacts wallet session has changed"); };
  }

  function notify() {
    for (const l of listeners) l();
  }

  function currentOwner(): string | undefined {
    return deps.walletState.snapshot().activePublicKeyHex?.trim().toLowerCase();
  }

  function clearPresence(owner?: string): void {
    const changedKeys = new Set<string>(presenceByContact.keys());
    presenceByContact.clear();
    presenceCursor = 0;
    presenceOwnerPublicKeyHex = owner;
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

  async function probeOne(contactPublicKeyHex: string, assertSession: () => void, signal?: AbortSignal): Promise<void> {
    if (!deps.channel || signal?.aborted || !isContactPublicKey(contactPublicKeyHex)) return;
    try {
      await deps.channel.publishPrivate({
        recipientPublicKeyHex: contactPublicKeyHex,
        protocol: "bsv8.ping.v1",
        content: newPing() as unknown as JSONValue
      });
      assertSession();
    } catch {
      // 单个联系人探测失败即为 offline，不重试、不广播。
      try { assertSession(); } catch { return; }
      notifyPresence(contactPublicKeyHex);
    }
  }

  async function probePresence(input: { signal?: AbortSignal } = {}): Promise<void> {
    const assertSession = operationFence();
    const owner = currentOwner();
    if (!owner || !deps.channel || !deps.channel.isReady()) return;
    if (presenceOwnerPublicKeyHex !== owner) clearPresence(owner);
    const { contacts } = await (await getStoreForActiveKey()).list();
    assertSession();
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
        assertSession();
        const index = nextIndex++;
        const contact = selected[index];
        if (!contact) return;
        await probeOne(contact, assertSession, input.signal);
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
    const state = deps.walletState.snapshot();
    if (!state.activePublicKeyHex) {
      throw new ContactsNoActiveKeyError();
    }
    if (handle && handleFor === state.activePublicKeyHex) {
      return handle;
    }
    handle ??= createContactsRepository(deps.storage);
    handleFor = state.activePublicKeyHex;
    return handle;
  }

  let observedWalletSession = deps.walletState.snapshot();
  const offActiveKeyChanged = deps.walletState.subscribe((state) => {
    const sessionChanged = !sameWalletSession(observedWalletSession, state);
    observedWalletSession = state;
    if (sessionChanged || state.activePublicKeyHex !== presenceOwnerPublicKeyHex) clearPresence(state.activePublicKeyHex?.trim().toLowerCase());
    if (!sessionChanged && handle && state.activePublicKeyHex === handleFor) {
      return;
    }
    if (handle) {
      handle = undefined;
      handleFor = undefined;
    }
    subscribeOwnerInbox();
    notify();
  });

  return {
    async addContact(input) {
      const assertSession = operationFence();
      const contactRepository = await getStoreForActiveKey();
      const normalized = normalizeContactInput(input);
      const existing = await contactRepository.findByPublicKeyHex(normalized.publicKeyHex);
      assertSession();
      if (existing) throw new ContactsDuplicateError(normalized.publicKeyHex);
      const now = new Date().toISOString();
      const contact: Contact = {
        publicKeyHex: normalized.publicKeyHex,
        name: normalized.name,
        ...(normalized.note === undefined ? {} : { note: normalized.note }),
        tags: normalized.tags,
        createdAt: now,
        updatedAt: now
      };
      try {
        assertSession();
        await contactRepository.create(contact);
      } catch (error) {
        // 并发创建：原生 ifNoneMatch CAS 失败等价于重复。
        if (error && typeof error === "object" && (error as { code?: string }).code === "storage_conflict") {
          throw new ContactsDuplicateError(normalized.publicKeyHex);
        }
        throw error;
      }
      assertSession();
      notify();
      return contact;
    },
    async updateContact(publicKeyHex, input) {
      const assertSession = operationFence();
      const contactRepository = await getStoreForActiveKey();
      const existing = await contactRepository.get(publicKeyHex);
      assertSession();
      if (!existing) throw new Error(`Contact ${publicKeyHex} not found`);
      const normalized = normalizeContactInput(input);
      const sameIdentity = existing.publicKeyHex === normalized.publicKeyHex;
      if (!sameIdentity && await contactRepository.findByPublicKeyHex(normalized.publicKeyHex)) {
        throw new ContactsDuplicateError(normalized.publicKeyHex);
      }
      const updated: Contact = {
        publicKeyHex: normalized.publicKeyHex,
        name: normalized.name,
        ...(normalized.note === undefined ? {} : { note: normalized.note }),
        tags: normalized.tags,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString()
      };
      assertSession();
      if (sameIdentity) {
        await contactRepository.put(updated);
      } else {
        // 身份变化 = 改名：先写新文件（拒绝覆盖），成功后再删旧文件。
        await contactRepository.create(updated);
        assertSession();
        await contactRepository.remove(existing.publicKeyHex);
      }
      assertSession();
      notify();
      return updated;
    },
    async removeContact(publicKeyHex) {
      const assertSession = operationFence();
      const contactRepository = await getStoreForActiveKey();
      assertSession();
      await contactRepository.remove(publicKeyHex);
      assertSession();
      notify();
    },
    async listContacts() {
      const assertSession = operationFence();
      const contactRepository = await getStoreForActiveKey();
      const contacts = (await contactRepository.list()).contacts;
      assertSession(); return contacts;
    },
    async findByPublicKeyHex(publicKeyHex) {
      const assertSession = operationFence();
      const contactRepository = await getStoreForActiveKey();
      const contact = await contactRepository.findByPublicKeyHex(publicKeyHex.trim().toLowerCase());
      assertSession(); return contact;
    },
    async findByPublicKeyHexes(publicKeyHexes) {
      const assertSession = operationFence();
      const contactRepository = await getStoreForActiveKey();
      const contacts = await contactRepository.findByPublicKeyHexes(publicKeyHexes.map((key) => key.trim().toLowerCase()));
      assertSession(); return contacts;
    },
    onChange(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    getPresence(publicKeyHex) {
      return presenceFor(publicKeyHex);
    },
    async getPresenceSnapshot(): Promise<ContactPresenceMap> {
      const assertSession = operationFence();
      if (!currentOwner()) return {};
      const { contacts } = await (await getStoreForActiveKey()).list();
      assertSession();
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
    resetPresence: () => clearPresence(),
    dispose() {
      disposed = true;
      keyDeletingOff?.();
      offActiveKeyChanged();
      presenceListeners.clear();
      handle = undefined;
      handleFor = undefined;
    }
  };
}
