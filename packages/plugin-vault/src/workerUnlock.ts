import type { CoordinatorResponse, CoordinatorVaultStatus, SessionEpoch, WalletColdStartSnapshot, WalletLifecycleService } from "@keymaster/contracts";
export interface WorkerUnlockPorts {
  session(): { vaultStatus: CoordinatorVaultStatus; sessionEpoch: SessionEpoch };
  coldStart(): Promise<WalletColdStartSnapshot | undefined>;
  lifecycle(): WalletLifecycleService;
  completeBinding(): Promise<void>;
  storageFailed(error: unknown): void;
  clearFailedSession(): void;
  storageError(requestId: string, error: unknown): CoordinatorResponse;
}
/** Vault owns password validation and unlock result mapping; the authority commits runtime bindings. */
export async function executeWorkerUnlock(
  requestId: string,
  request: { kind: "unlock"; password: string; expectedSessionEpoch: SessionEpoch }
,
  deps: WorkerUnlockPorts
): Promise<CoordinatorResponse> {
  if (deps.session().vaultStatus === "unlocked") {
    return {
      requestId,
      sessionEpoch: deps.session().sessionEpoch,
      ack: { status: "already-unlocked" },
    };
  }

  if (deps.session().vaultStatus === "booting" || deps.session().vaultStatus === "fatal") {
    return {
      requestId,
      sessionEpoch: deps.session().sessionEpoch,
      ack: { status: "not-ready" },
    };
  }

  if (deps.session().vaultStatus === "uninitialized") {
    return {
      requestId,
      sessionEpoch: deps.session().sessionEpoch,
      ack: { status: "validation-error", message: "Vault not initialized" },
    };
  }

  try {
    // 冷启动只读固定 KeyHold：没有它说明尚未初始化，不能靠密码“解锁”。
    const coldStart = await deps.coldStart();
    if (!coldStart || coldStart.state !== "ready") {
      return {
        requestId,
        sessionEpoch: deps.session().sessionEpoch,
        ack: {
          status: coldStart?.state === "corrupt" || coldStart?.state === "unsupported"
            ? "error"
            : "validation-error",
          message: coldStart?.state === "corrupt"
            ? "Local wallet data is incomplete or damaged"
            : coldStart?.state === "unsupported"
              ? "Local wallet schema is newer than this build"
              : "Wallet is not initialized",
          ...(coldStart?.state === "corrupt"
            ? { code: "storage_wallet_corrupt" as const }
            : coldStart?.state === "unsupported"
              ? { code: "storage_wallet_unsupported" as const }
              : {}),
        },
      };
    }
    const lifecycle = deps.lifecycle();
    // 唯一 Key：密码由 `key.json` 自身的 KeyHold 文档验证，没有可选对象，
    // 也不需要任何跨浏览器租约锁。
    try {
      await lifecycle.unlock(request.password);
      // `adoptUnlockedKey` 已在私钥清零前写入会话状态与 KeyIdentity 摘要；
      // 只有运行绑定和业务运行单元也重新打开之后，页面才被允许进入业务。
      await deps.completeBinding();
      return {
        requestId,
        sessionEpoch: deps.session().sessionEpoch,
        ack: { status: "accepted" },
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      // 只有 KeyHold 密码本身验证失败才是 validation-error；存储不可用、
      // 数据损坏等情况必须保留原错误码，不能伪装成“密码错误”。
      // `storage_identity_required` 就是 key.json 解密 / 认证失败，即密码错误；
      // 其余 storage_* 必须保留原错误码，不能伪装成“密码错误”。
      if (code === "storage_identity_required") {
        return {
          requestId,
          sessionEpoch: deps.session().sessionEpoch,
          ack: { status: "validation-error", message: "Invalid password" },
        };
      }
      return {
        requestId,
        sessionEpoch: deps.session().sessionEpoch,
        ack: {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
          code: code as never,
        },
      };
    }
  } catch (err) {
    deps.storageFailed(err);
    // unlock 失败，回到 locked
    deps.clearFailedSession();

    return deps.storageError(requestId, err);
  }
}
