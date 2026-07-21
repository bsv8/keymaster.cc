import type { ActiveKeyState, KeyIdentity, KeyspaceService, NoticeRecord, NoticeRegistry, ResourceRegistry, VaultService, VaultStatus } from "@keymaster/contracts";

export type ShellGuardResource =
  | { kind: "normal" }
  | { kind: "empty-vault-recovery" }
  | { kind: "needs-repair"; keys: KeyIdentity[] }
  | { kind: "diagnostic"; error: string };

export function registerShellResources(registry: ResourceRegistry): void {
  registry.register<NoticeRecord[], readonly string[]>({
    id: "shell.notices", scope: "global", key: () => ["shell.notices"],
    load: async (_args, context) => context.getCapability<NoticeRegistry>("notice.registry")?.list() ?? [],
    subscribe: (_args, context, invalidate) => context.getCapability<NoticeRegistry>("notice.registry")?.subscribe(() => invalidate()) ?? (() => {}),
    invalidation: "immediate"
  });
  registry.register<VaultStatus, readonly string[]>({
    id: "shell.vault-status", scope: "global", key: () => ["shell.vault-status"],
    load: async (_args, context) => context.getCapability<VaultService>("vault.service")?.status() ?? "uninitialized",
    subscribe: (_args, context, invalidate) => context.getCapability<VaultService>("vault.service")?.onLifecycleChange(() => invalidate()) ?? (() => {}),
    invalidation: "immediate"
  });
  registry.register<unknown, readonly string[]>({
    id: "shell.activation-notice", scope: "global", key: () => ["shell.activation-notice"],
    load: async (_args, context) => context.getCapability<VaultService>("vault.service")?.getInitialActivationNotice?.() ?? null,
    subscribe: (_args, context, invalidate) => context.getCapability<VaultService>("vault.service")?.onInitialActivationNoticeChange(() => invalidate()) ?? (() => {}),
    invalidation: "immediate"
  });
  registry.register<ShellGuardResource, readonly string[]>({
    id: "shell.guard", scope: "global", key: () => ["shell.guard"],
    load: async (_args, context) => {
      const vault = context.getCapability<VaultService>("vault.service");
      const keyspace = context.getCapability<KeyspaceService>("keyspace.service");
      if (!vault || !keyspace || vault.status() !== "unlocked") return { kind: "normal" };
      const active: ActiveKeyState = keyspace.active();
      if (active.activePublicKeyHex) return { kind: "normal" };
      try {
        const keys = await keyspace.listKeys();
        return keys.length === 0 ? { kind: "empty-vault-recovery" } : { kind: "needs-repair", keys };
      } catch (err) {
        return { kind: "diagnostic", error: err instanceof Error ? err.message : String(err) };
      }
    },
    subscribe: (_args, context, invalidate) => {
      const vault = context.getCapability<VaultService>("vault.service");
      const keyspace = context.getCapability<KeyspaceService>("keyspace.service");
      const a = vault?.onLifecycleChange(() => invalidate()) ?? (() => {});
      const b = keyspace?.onActiveKeyChanged(() => invalidate()) ?? (() => {});
      return () => { a(); b(); };
    },
    invalidation: "immediate"
  });
}
