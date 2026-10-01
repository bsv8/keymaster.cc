import type { ApplicationBootstrapSnapshot, ApplicationBootstrapStatus, KeyspaceService, NoticeRecord, NoticeRegistry, ResourceRegistry, VaultService, VaultStatus } from "@keymaster/contracts";
import { APPLICATION_BOOTSTRAP_RESOURCE_ID } from "@keymaster/contracts";

/**
 * 单 Key 钱包下的壳层守卫结果。
 *
 * 没有「0 key 回退」和「Key 列表修复」这类分支：系统里只有一把 Key，
 * 已经 unlocked 却读不到公开身份就是状态不一致，必须阻断业务页而不是
 * 自动收敛或清空钱包。读失败同样 fail closed，不当成「没有 Key」。
 */
export type ShellGuardResource =
  | { kind: "normal" }
  | { kind: "needs-repair"; publicKeyHex?: string }
  | { kind: "diagnostic"; error: string };

export function registerShellResources(registry: ResourceRegistry, applicationBootstrap?: ApplicationBootstrapStatus): void {
  if (applicationBootstrap) {
    registry.register<ApplicationBootstrapSnapshot, readonly string[]>({
      id: APPLICATION_BOOTSTRAP_RESOURCE_ID,
      scope: "global",
      key: () => [APPLICATION_BOOTSTRAP_RESOURCE_ID],
      load: async () => applicationBootstrap.snapshot(),
      // ResourceDefinition 的 subscribe 只表达“资源已失效”；状态读取仍由
      // load 完成，避免 React 组件直接订阅业务 service。
      subscribe: (_args, _context, invalidate) => applicationBootstrap.subscribe(() => invalidate()),
      equals: (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
      invalidation: "immediate"
    });
  }
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
  registry.register<ShellGuardResource, readonly string[]>({
    id: "shell.guard", scope: "global", key: () => ["shell.guard"],
    load: async (_args, context) => {
      const vault = context.getCapability<VaultService>("vault.service");
      if (!vault || vault.status() !== "unlocked") return { kind: "normal" };
      try {
        const active = context.getCapability<KeyspaceService>("keyspace.service")?.active();
        const key = await vault.getCurrentKey();
        if (key) return { kind: "normal" };
        // 已解锁却读不到唯一 Key 的公开身份：KeyHold 已解密但身份投影缺失。
        return { kind: "needs-repair", publicKeyHex: active?.activePublicKeyHex };
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
