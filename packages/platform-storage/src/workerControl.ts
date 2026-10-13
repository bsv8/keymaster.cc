import type { CoordinatorClientRequest, CoordinatorResponse, CoordinatorVaultStatus } from "@keymaster/contracts";
import type { VaultWorkerWalletControl } from "@keymaster/contracts";
export interface StorageWorkerControlPorts {
  root: Pick<ReturnType<typeof import("./workerRoot.js").createStorageWorkerRoot>, "root" | "failed" | "status" | "ensure" | "emit">;
  wallet: VaultWorkerWalletControl;
  session(): { sessionEpoch: string };
  commit(patch: { sessionEpoch?: string; vaultStatus?: CoordinatorVaultStatus; walletGeneration?: string; activePublicKeyHex?: string }): void;
  cleanupPending(): unknown; recoveryOperations(): readonly string[]; unavailable(message: string): Error;
  lock(reason: string): Promise<void>; revokeBinding(reason: string): Promise<void>; discardBinding(): void;
  publishSession(cause: "unlock" | "lock" | "change-password" | "reset-wallet"): void;
  io: { run<T>(kind: "read" | "write", signal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>, options: { auditOperation: "storage.control"; allowLocalLock: boolean; allowLocalOwnerTransition: boolean; allowLocalBindingDiscard: boolean; durableLease: boolean }): Promise<T> };
}
/** Storage 控制面管理介质投影；钱包命令调用 Vault 公开控制接口。 */
export function createStorageWorkerControl(ports: StorageWorkerControlPorts) {
  function clearStorageRequestSecrets(request: { kind: string }): void {
    if (request.kind === "storage.control") {
      const control = (request as Extract<CoordinatorClientRequest, { kind: "storage.control" }>).control;
      if (control.type === "unlock") {
        control.password = "";
      }
      if (control.type === "initialize") {
        control.plan.firstKey.password = "";
        if (control.plan.firstKey.kind === "import") {
          control.plan.firstKey.material.hex = "";
          control.plan.firstKey.material.wif = undefined;
        }
      }
      if (control.type === "change-key-password") {
        control.oldPassword = "";
        control.newPassword = "";
      }
    }
  }

  async function executeStorageControl(
    request: Extract<CoordinatorClientRequest, { kind: "storage.control" }>,
    signal?: AbortSignal,
    peerId?: string,
  ): Promise<CoordinatorResponse> {
    if (signal?.aborted) throw ports.unavailable("Storage control request was cancelled");
    const control = request.control;
    const ok = (operationResult?: unknown): CoordinatorResponse => ({
      requestId: request.requestId,
      sessionEpoch: ports.session().sessionEpoch,
      ack: { status: "ok" },
      ...(operationResult === undefined ? {} : { operationResult }),
    });

    if (control.type === "status") {
      if (ports.root.failed) {
        void ports.wallet.closeHardware();
        const detail = ports.recoveryOperations().length > 0
          ? `; active final I/O=${ports.recoveryOperations().join(",")}`
          : "";
        return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "error", message: `Storage startup failed${detail}`, code: "storage_unavailable" } };
      }
      // 未初始化钱包还没有平台 Root；状态是纯投影，直接用冷启动结论回答。
      if (!ports.root.root) return ok(ports.root.status());
      const service = await ports.root.ensure().catch(() => undefined);
      return ok(service?.status() ?? ports.root.status());
    }

    if (control.type === "cold-start") {
      // 冷启动是纯只读的真值查询：它必须在没有平台根时也能回答，否则 uninitialized
      // 与 corrupt/unsupported 状态无法与「Root 装不上」区分开。
      const snapshot = await ports.wallet.coldStart();
      return ok(snapshot);
    }

    if (control.type === "summary") {
      // 摘要同属只读投影：没有 Root 时从冷启动结论和浏览器持久化授权直接
      // 构造，不把「尚未创建钱包」升级成存储故障。
      if (!ports.root.root) {
        return ok({
          status: ports.root.status(),
          medium: "indexeddb" as const,
          persistence: await ports.wallet.persistence(),
        });
      }
      const service = await ports.root.ensure();
      return ok(await service.summary());
    }

    if (ports.cleanupPending() && ["unlock", "initialize", "reset-wallet", "change-key-password"].includes(control.type)) {
      return { requestId: request.requestId, sessionEpoch: ports.session().sessionEpoch, ack: { status: "blocked", reason: { key: "vault.lock.cleanupBlocked", fallback: "钱包清理尚未完成，请重试清理后再解锁" } } };
    }

    if (control.type === "lock") {
      return ok(await ports.wallet.execute(control));
    }

    if (control.type === "initialize") {
      return ok(await ports.wallet.execute(control));
    }

    await ports.root.ensure();
    const result = await ports.wallet.execute(control);
    return ok(result);
  }

  function storageControlIoKind(control: Extract<CoordinatorClientRequest, { kind: "storage.control" }>["control"]): "read" | "write" {
    switch (control.type) {
      case "status":
      case "summary":
      case "cold-start":
        return "read";
      default:
        return "write";
    }
  }

  async function executeStorageControlAtFinalBoundary(
    request: Extract<CoordinatorClientRequest, { kind: "storage.control" }>,
    signal?: AbortSignal,
    peerId?: string,
  ): Promise<CoordinatorResponse> {
    // 解锁、锁定、改密与重置都会主动推进会话或钱包身份世代；这些有意的
    // 本地状态迁移必须允许当前 storage control 的 final lease 观察到新
    // gate，否则旧 lease 会把它们误判成「未知来源的本地锁」。
    const transitionsSession = request.control.type === "unlock"
      || request.control.type === "lock"
      || request.control.type === "change-key-password"
      || request.control.type === "initialize"
      || request.control.type === "reset-wallet";
    return ports.io.run(
      storageControlIoKind(request.control),
      signal,
      (leaseSignal) => executeStorageControl(request, leaseSignal, peerId),
      {
        auditOperation: "storage.control",
        allowLocalLock: transitionsSession,
        allowLocalOwnerTransition: transitionsSession,
        // 重置会撤销运行根并重新安装；初始化同样要换绑到新钱包身份世代。
        allowLocalBindingDiscard: request.control.type === "reset-wallet" || request.control.type === "initialize",
        durableLease: storageControlIoKind(request.control) === "write",
      },
    );
  }
  return { execute: executeStorageControlAtFinalBoundary, clearSecrets: clearStorageRequestSecrets };
}
