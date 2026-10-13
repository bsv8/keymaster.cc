import {
  defineBuiltinWorkerPlugin, VAULT_WALLET_STATE_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY,
  CONTACTS_PRESENCE_CHANNEL_CAPABILITY, type WorkerTaskRegistrar, type BorrowedModuleFileStore,
  type ContactsPresenceChannel, type ContactsService, type VaultWalletState,
} from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import { createContactsService, createContactsPresenceTask } from "./coordinator.js";

/** Contacts 服务及订阅归实例；晚到的 cleanup 只能移除自己。 */
export function createContactsWorkerRuntime(ports: { tasks: WorkerTaskRegistrar; changed(): void }) {
  let current: ContactsService | undefined;
  let currentCleanup: (() => Promise<void>) | undefined;
  async function install(input: {
    walletState: VaultWalletState; storage: BorrowedModuleFileStore; channel: ContactsPresenceChannel;
    messageBus?: MessageBus; assertActive(): void; ownCleanup?(cleanup: () => Promise<void>): void;
  }) {
    await currentCleanup?.();
    input.assertActive();
    const service = createContactsService(input);
    current = service;
    const offChange = service.onChange(ports.changed);
    const offPresence = service.onPresenceChange?.(ports.changed);
    let registration: Awaited<ReturnType<WorkerTaskRegistrar["register"]>> | undefined;
    let disposed = false;
    const revoke = () => {
      if (disposed) return;
      disposed = true;
      registration?.revoke();
      offChange(); offPresence?.();
      service.dispose?.();
      if (current === service) current = undefined;
    };
    const cleanup = async () => {
      revoke();
      await registration?.dispose();
      if (currentCleanup === cleanup) currentCleanup = undefined;
    };
    currentCleanup = cleanup;
    input.ownCleanup?.(cleanup);
    ports.changed();
    try {
      const task = createContactsPresenceTask({ service, walletState: input.walletState, vault: { status: () => input.walletState.snapshot().status } });
      registration = await ports.tasks.register(task, input.assertActive);
      if (disposed) { registration.revoke(); await registration.dispose(); }
      input.assertActive();
      return { revoke, dispose: cleanup };
    } catch (error) { await cleanup(); throw error; }
  }
  const plugin = defineBuiltinWorkerPlugin("contacts", [], async context => {
    const instance = await install({
      walletState: context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope),
      storage: context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, "address-book"),
      channel: context.capability(CONTACTS_PRESENCE_CHANNEL_CAPABILITY), messageBus: context.messageBus,
      assertActive: () => context.scope.assertActive(), ownCleanup: cleanup => context.onDispose(cleanup),
    });
    context.scope.onRevoke(instance.revoke);
  });
  return { plugin, install, current: () => current, reset() { void currentCleanup?.(); } };
}
