import { acquireCoordinatorAuthorityLock, type CoordinatorAuthorityLock } from "./coordinatorAuthorityLock.js";
import { createUpgradeGate } from "webloom-framework/advanced";
import type { UpgradeGate, UpgradeSession, UpgradeIoLease } from "webloom-framework";
import { COORDINATOR_SERVICE_CONTRACT_VERSION, type CoordinatorAuthorityRecovery, type CoordinatorVaultStatus } from "@keymaster/contracts";
import { createFinalIoAudit, type FinalIoAuditOperation } from "./finalIoAudit.js";
export interface CoordinatorWorkerAuthorityPorts {
  buildId: string; protocolVersion: string; identifierSuffix(): string;
  session(): { sessionEpoch: string; runGeneration: string; vaultStatus: CoordinatorVaultStatus };
  admission: { acquire(exclusive: boolean, signal?: AbortSignal): Promise<{ release(): void }> };
}
export interface CoordinatorAuthorityRecord {
  /** 记录格式版本，便于未来迁移而不把未知值当成当前权威。 */
  version: 1;
  /** 当前 Coordinator Worker 启动身份。 */
  authorityInstanceId: string;
  /** 当前 Worker 内单调递增的运行世代；不是跨 Worker 的持久版本。 */
  handoverGeneration: number;
  /** 当前 Worker 构建产物标识。 */
  buildId: string;
  /** 当前升级控制协议版本。 */
  protocolVersion: string;
  /** 当前 Worker 已进入最终 I/O 边界但尚未结束的内存租约。 */
  activeIoLeases: Record<string, {
    operation: "read" | "write";
    acquiredAt: number;
    /** 固定的最终 I/O 入口名，只用于当前运行时诊断。 */
    auditOperation?: FinalIoAuditOperation;
  }>;
}
export interface CoordinatorFinalIoLease {
  leaseId: string;
  /** 释放时必须使用取得 lease 时捕获的身份，不能读取当前 Worker 的新身份。 */
  authorityInstanceId: string;
  handoverGeneration: number;
  release(): Promise<void>;
}
export interface CoordinatorSharedReadLease {
  ioLease: CoordinatorFinalIoLease;
  authorityInstanceId: string;
  handoverGeneration: number;
  references: number;
}
/** 跨物理 Worker authority 与最终 I/O 租约只依赖公共会话事实。 */
export function createCoordinatorWorkerAuthority(ports: CoordinatorWorkerAuthorityPorts) {
  function makeCoordinatorAuthorityInstanceId(): string {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `coordinator:${crypto.randomUUID()}`;
      }
    } catch {
      // Worker 启动身份只用于区分本次内存实例；缺失 Web Crypto 时仍保持唯一格式。
    }
    return `coordinator:${Date.now().toString(36)}:${ports.identifierSuffix()}`;
  }

  let coordinatorAuthorityInstanceId = makeCoordinatorAuthorityInstanceId();

  let coordinatorHandoverGeneration = 0;

  let coordinatorAuthorityRecord: CoordinatorAuthorityRecord | undefined;

  let coordinatorAuthorityLock: CoordinatorAuthorityLock | undefined;

  let coordinatorAuthorityRecovery: CoordinatorAuthorityRecovery | undefined;

  let coordinatorAuthorityRecoveryOperationNames: string[] = [];

  let coordinatorAuthorityClaimTail: Promise<void> = Promise.resolve();

  let coordinatorSharedReadLease: CoordinatorSharedReadLease | undefined;

  let coordinatorSharedReadLeaseTail: Promise<void> = Promise.resolve();

  let coordinatorUpgradeGate: UpgradeGate | undefined;

  let coordinatorUpgradeSession: UpgradeSession | undefined;

  function coordinatorUpgradeError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
  }

  async function readCoordinatorAuthorityRecord(): Promise<CoordinatorAuthorityRecord | undefined> {
    // authority record 的诊断字段只存在当前 Worker 内存；真正的跨 Worker
    // 唯一性由 Keymaster 自己持有的 origin 级 authority Web Lock 保证，不能
    // 从 Local/S3 业务 K-V 恢复一把已经失去上下文的临时锁。
    return coordinatorAuthorityRecord;
  }

  async function claimCoordinatorAuthority(): Promise<void> {
    if (!coordinatorAuthorityLock) {
      coordinatorAuthorityLock = await acquireCoordinatorAuthorityLock();
    }
    // authority lock 会保持到当前 Worker 退场；这里的随机身份和内存世代
    // 供旧页面/旧授权拒绝以及本地 gate 做迟到检查，不把活动 I/O 写入业务桶。
    coordinatorHandoverGeneration += 1;
    coordinatorAuthorityRecord = {
      version: 1,
      authorityInstanceId: coordinatorAuthorityInstanceId,
      handoverGeneration: coordinatorHandoverGeneration,
      buildId: ports.buildId,
      protocolVersion: ports.protocolVersion,
      activeIoLeases: {},
    };
    coordinatorAuthorityRecovery = undefined;
    coordinatorAuthorityRecoveryOperationNames = [];
    return;
  }

  let coordinatorAuthorityClaimInFlight: Promise<void> | undefined;

  function scheduleCoordinatorAuthorityClaim(): Promise<void> {
    if (coordinatorAuthorityClaimInFlight) return coordinatorAuthorityClaimInFlight;
    const run = coordinatorAuthorityClaimTail.then(
      () => claimCoordinatorAuthority(),
      () => claimCoordinatorAuthority(),
    );
    coordinatorAuthorityClaimInFlight = run;
    coordinatorAuthorityClaimTail = run.then(() => undefined, () => undefined);
    run.then(
      () => { if (coordinatorAuthorityClaimInFlight === run) coordinatorAuthorityClaimInFlight = undefined; },
      () => { if (coordinatorAuthorityClaimInFlight === run) coordinatorAuthorityClaimInFlight = undefined; },
    );
    return run;
  }

  async function ensureCoordinatorAuthorityClaim(): Promise<void> {
    await coordinatorAuthorityClaimTail;
    if (
      coordinatorAuthorityRecord?.authorityInstanceId === coordinatorAuthorityInstanceId
      && coordinatorAuthorityRecord.handoverGeneration === coordinatorHandoverGeneration
    ) return;

    await scheduleCoordinatorAuthorityClaim();
    if (
      coordinatorAuthorityRecord?.authorityInstanceId !== coordinatorAuthorityInstanceId
      || coordinatorAuthorityRecord.handoverGeneration !== coordinatorHandoverGeneration
    ) throw coordinatorUpgradeError("upgrade.authority_stale", "Coordinator authority claim is stale");
  }

  async function assertCoordinatorAuthorityCurrent(): Promise<void> {
    await ensureCoordinatorAuthorityClaim();
    const current = await readCoordinatorAuthorityRecord();
    if (
      !coordinatorAuthorityLock
      || !current
      || current.authorityInstanceId !== coordinatorAuthorityInstanceId
      || current.handoverGeneration !== coordinatorHandoverGeneration
      || current.buildId !== ports.buildId
      || current.protocolVersion !== ports.protocolVersion
    ) {
      throw coordinatorUpgradeError("upgrade.authority_stale", "Coordinator authority is no longer current");
    }
  }

  function makeCoordinatorFinalIoLeaseId(): string {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return `coordinator-io:${crypto.randomUUID()}`;
      }
    } catch {
      // leaseId 只是防止两个释放操作误删彼此的内存记录；身份与世代仍会校验。
    }
    return `coordinator-io:${Date.now().toString(36)}:${ports.identifierSuffix()}`;
  }

  async function acquireCoordinatorFinalIoLeaseExclusive(
    operation: "read" | "write",
    auditOperation?: FinalIoAuditOperation,
  ): Promise<CoordinatorFinalIoLease> {
    // I/O 租约只表示当前 Worker 内存中的排空计数；WebLoom 已经在浏览器
    // 级别负责 typed transport，但不负责跨构建互斥。Keymaster authority
    // Web Lock 已在 Worker claim 阶段取得并持续持有；这里再确认它存在，
    // 才允许进入最终 I/O。
    await assertCoordinatorAuthorityCurrent();
    const record = coordinatorAuthorityRecord;
    if (!record) throw coordinatorUpgradeError("upgrade.authority_unavailable", "Coordinator runtime authority is unavailable");
    const leaseId = makeCoordinatorFinalIoLeaseId();
    record.activeIoLeases[leaseId] = {
      operation,
      acquiredAt: Date.now(),
      ...(auditOperation ? { auditOperation } : {}),
    };
    let released = false;
    return {
      leaseId,
      authorityInstanceId: record.authorityInstanceId,
      handoverGeneration: record.handoverGeneration,
      release: async () => {
        if (released) return;
        released = true;
        delete record.activeIoLeases[leaseId];
      },
    };
  }

  function withCoordinatorSharedReadLeaseMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = coordinatorSharedReadLeaseTail.then(operation, operation);
    coordinatorSharedReadLeaseTail = run.then(() => undefined, () => undefined);
    return run;
  }

  function hasCurrentCoordinatorSharedReadLease(): boolean {
    return coordinatorSharedReadLease !== undefined
      && coordinatorSharedReadLease.references > 0
      && coordinatorSharedReadLease.authorityInstanceId === coordinatorAuthorityInstanceId
      && coordinatorSharedReadLease.handoverGeneration === coordinatorHandoverGeneration;
  }

  async function acquireCoordinatorFinalIoLease(
    operation: "read" | "write",
    auditOperation?: FinalIoAuditOperation,
  ): Promise<CoordinatorFinalIoLease> {
    if (operation === "write") return acquireCoordinatorFinalIoLeaseExclusive(operation, auditOperation);
    return withCoordinatorSharedReadLeaseMutation(async () => {
      const existing = coordinatorSharedReadLease;
      const authorityInstanceId = coordinatorAuthorityInstanceId;
      const handoverGeneration = coordinatorHandoverGeneration;
      if (
        existing
        && existing.authorityInstanceId === authorityInstanceId
        && existing.handoverGeneration === handoverGeneration
      ) {
        existing.references += 1;
        let released = false;
        return {
          leaseId: `${existing.ioLease.leaseId}:${existing.references}`,
          authorityInstanceId,
          handoverGeneration,
          release: async () => {
            if (released) return;
            released = true;
            await withCoordinatorSharedReadLeaseMutation(async () => {
              existing.references = Math.max(0, existing.references - 1);
              if (existing.references !== 0) return;
              if (coordinatorSharedReadLease === existing) coordinatorSharedReadLease = undefined;
              await existing.ioLease.release();
            });
          },
        };
      }

      // 只会在测试 reset / 本地重建后遇到不匹配对象；旧对象的在途请求仍
      // 持有自己的引用，等它们 finally 释放，不能在这里强行改写新世代。
      const ioLease = await acquireCoordinatorFinalIoLeaseExclusive("read", auditOperation);
      const shared: CoordinatorSharedReadLease = {
        ioLease,
        authorityInstanceId: ioLease.authorityInstanceId,
        handoverGeneration: ioLease.handoverGeneration,
        references: 1,
      };
      coordinatorSharedReadLease = shared;
      let released = false;
      return {
        leaseId: `${ioLease.leaseId}:1`,
        authorityInstanceId: ioLease.authorityInstanceId,
        handoverGeneration: ioLease.handoverGeneration,
        release: async () => {
          if (released) return;
          released = true;
          await withCoordinatorSharedReadLeaseMutation(async () => {
            shared.references = Math.max(0, shared.references - 1);
            if (shared.references !== 0) return;
            if (coordinatorSharedReadLease === shared) coordinatorSharedReadLease = undefined;
            await shared.ioLease.release();
          });
        },
      };
    });
  }

  async function ensureCoordinatorUpgradeSession(): Promise<void> {
    await ensureCoordinatorAuthorityClaim();
    if (
      coordinatorUpgradeGate
      && coordinatorUpgradeSession
      && coordinatorUpgradeGate.authorityInstanceId === coordinatorAuthorityInstanceId
      && coordinatorUpgradeGate.handoverGeneration === coordinatorHandoverGeneration
      && coordinatorUpgradeGate.state === "active"
      && !coordinatorUpgradeSession.revoked
    ) return;

    coordinatorUpgradeGate?.close("Coordinator upgrade session replaced");
    const gate = createUpgradeGate({
      protocolVersion: ports.protocolVersion,
      buildId: ports.buildId,
      authorityInstanceId: coordinatorAuthorityInstanceId,
      handoverGeneration: coordinatorHandoverGeneration,
      supportedContractVersions: [COORDINATOR_SERVICE_CONTRACT_VERSION],
      mode: "cold-switch",
    });
    const connectionId = `coordinator-final-io:${coordinatorAuthorityInstanceId}:${coordinatorHandoverGeneration}`;
    const handshake = gate.handshake({
      connectionId,
      protocolVersion: ports.protocolVersion,
      buildId: ports.buildId,
      authorityInstanceId: coordinatorAuthorityInstanceId,
      handoverGeneration: coordinatorHandoverGeneration,
      supportedContractVersions: [COORDINATOR_SERVICE_CONTRACT_VERSION],
    });
    if (!handshake.accepted) {
      gate.close("Coordinator upgrade handshake rejected");
      throw coordinatorUpgradeError("upgrade.handshake_rejected", `Coordinator upgrade handshake rejected: ${handshake.reason}`);
    }
    coordinatorUpgradeGate = gate;
    coordinatorUpgradeSession = handshake.session;
  }

  async function withCoordinatorFinalIoLease<T>(
    operation: "read" | "write",
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
    options: {
      walletMigration?: boolean;
      allowLocalLock?: boolean;
      allowLocalOwnerTransition?: boolean;
      /** 当前 control 已完成本地桶清理，Root 会在 lease 释放后销毁。 */
      allowLocalBindingDiscard?: boolean;
      auditOperation?: FinalIoAuditOperation;
      /** 是否登记当前 Worker 的内存 admission 计数；默认 true。 */
      durableLease?: boolean;
    } = {},
  ): Promise<T> {
    const walletAdmission = await ports.admission.acquire(options.walletMigration === true, signal);
    try { return await withCoordinatorFinalIoLeaseAdmitted(operation, signal, run, options); } finally { walletAdmission.release(); }
  }

  async function withCoordinatorFinalIoLeaseAdmitted<T>(operation: "read" | "write", signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>, options: { walletMigration?: boolean; allowLocalLock?: boolean; allowLocalOwnerTransition?: boolean; allowLocalBindingDiscard?: boolean; auditOperation?: FinalIoAuditOperation; durableLease?: boolean }): Promise<T> {
    await ensureCoordinatorUpgradeSession();
    // 共享 read lease 只表示当前 Worker 已持有 Keymaster 的 origin 级
    // authority lock 并通过本地检查；高频只读请求无需重复登记内存计数。
    if (operation !== "read" || !hasCurrentCoordinatorSharedReadLease()) {
      await assertCoordinatorAuthorityCurrent();
    }
    const gate = coordinatorUpgradeGate;
    const session = coordinatorUpgradeSession;
    if (!gate || !session) throw coordinatorUpgradeError("upgrade.gate_unavailable", "Coordinator upgrade gate is unavailable");
    const initialSessionEpoch = ports.session().sessionEpoch;
    const initialRunGeneration = ports.session().runGeneration;
    const lease: UpgradeIoLease = gate.admit({ session, operation, signal });
    let ioLease: CoordinatorFinalIoLease | undefined;
    let audit: ReturnType<ReturnType<typeof createFinalIoAudit>["begin"]> | undefined;
    let operationError: unknown;
    try {
      lease.assertActive();
      // 本地 UpgradeGate 和内存 I/O lease 负责当前 Worker 的 admission/drain；
      // 跨 Worker 的唯一性由 Keymaster authority lock 保证。没有这把锁时
      // assertCoordinatorAuthorityCurrent 已经 fail closed，不能降级继续跑。
      if (options.durableLease !== false) {
        ioLease = await acquireCoordinatorFinalIoLease(operation, options.auditOperation);
      }
      lease.assertActive();
      audit = options.auditOperation ? finalIoAudit.begin(options.auditOperation) : undefined;
      const result = await run(lease.signal);
      // 某些有意完成锁定的 Vault 操作会在 callback 内关闭旧 gate，并由
      // performGlobalLock 建立新的 locked gate。此时旧 lease 被本地安全锁定
      // 撤销是预期结果；仍必须重新检查共享 authority，外部接管不能走这条
      // 放宽路径。
      const localLockReplacedGate = options.allowLocalLock === true
        && gate.state === "closed"
        && coordinatorUpgradeGate !== gate
        && (ports.session().vaultStatus === "locked" || ports.session().vaultStatus === "uninitialized");
      const localOwnerTransitionReplacedGate = options.allowLocalOwnerTransition === true
        && gate.state === "closed"
        && coordinatorUpgradeGate !== gate
        && ports.session().vaultStatus === "unlocked"
        && (ports.session().sessionEpoch !== initialSessionEpoch || ports.session().runGeneration !== initialRunGeneration);
      // 单 Key 本地存储没有「丢弃目录绑定」这一过渡态：Root 要么有效要么已被撤销。
      const localBindingDiscard = false;
      if (!localLockReplacedGate && !localOwnerTransitionReplacedGate && !localBindingDiscard) lease.assertActive();
      // Root 销毁会在 finally 中、本地 lease 释放后执行；不读取业务桶里的
      // 临时 authority 记录。
      if (!localBindingDiscard) await assertCoordinatorAuthorityCurrent();
      audit?.finish("completed");
      return result;
    } catch (error) {
      operationError = error;
      audit?.finish(operation === "write" ? "unknown" : "failed");
      throw error;
    } finally {
      let releaseError: unknown;
      try {
        await ioLease?.release();
      } catch (error) {
        releaseError = error;
      }
      lease.release();
      if (releaseError && operationError === undefined) throw releaseError;
      if (releaseError) {
        console.error("[coordinator] final I/O lease release failed", releaseError);
      }
    }
  }

  function closeCoordinatorUpgradeSession(reason: string): void {
    coordinatorUpgradeGate?.close(reason);
    coordinatorUpgradeGate = undefined;
    coordinatorUpgradeSession = undefined;
  }

  const finalIoAudit = createFinalIoAudit();
  return {
    makeCoordinatorAuthorityInstanceId,
    get coordinatorAuthorityInstanceId() { return coordinatorAuthorityInstanceId; }, set coordinatorAuthorityInstanceId(value: typeof coordinatorAuthorityInstanceId) { coordinatorAuthorityInstanceId = value; },
    get coordinatorHandoverGeneration() { return coordinatorHandoverGeneration; }, set coordinatorHandoverGeneration(value: typeof coordinatorHandoverGeneration) { coordinatorHandoverGeneration = value; },
    get coordinatorAuthorityRecord() { return coordinatorAuthorityRecord; }, set coordinatorAuthorityRecord(value: typeof coordinatorAuthorityRecord) { coordinatorAuthorityRecord = value; },
    get coordinatorAuthorityLock() { return coordinatorAuthorityLock; }, set coordinatorAuthorityLock(value: typeof coordinatorAuthorityLock) { coordinatorAuthorityLock = value; },
    get coordinatorAuthorityRecovery() { return coordinatorAuthorityRecovery; }, set coordinatorAuthorityRecovery(value: typeof coordinatorAuthorityRecovery) { coordinatorAuthorityRecovery = value; },
    get coordinatorAuthorityRecoveryOperationNames() { return coordinatorAuthorityRecoveryOperationNames; }, set coordinatorAuthorityRecoveryOperationNames(value: typeof coordinatorAuthorityRecoveryOperationNames) { coordinatorAuthorityRecoveryOperationNames = value; },
    get coordinatorAuthorityClaimTail() { return coordinatorAuthorityClaimTail; }, set coordinatorAuthorityClaimTail(value: typeof coordinatorAuthorityClaimTail) { coordinatorAuthorityClaimTail = value; },
    get coordinatorSharedReadLease() { return coordinatorSharedReadLease; }, set coordinatorSharedReadLease(value: typeof coordinatorSharedReadLease) { coordinatorSharedReadLease = value; },
    get coordinatorSharedReadLeaseTail() { return coordinatorSharedReadLeaseTail; }, set coordinatorSharedReadLeaseTail(value: typeof coordinatorSharedReadLeaseTail) { coordinatorSharedReadLeaseTail = value; },
    get coordinatorUpgradeGate() { return coordinatorUpgradeGate; }, set coordinatorUpgradeGate(value: typeof coordinatorUpgradeGate) { coordinatorUpgradeGate = value; },
    get coordinatorUpgradeSession() { return coordinatorUpgradeSession; }, set coordinatorUpgradeSession(value: typeof coordinatorUpgradeSession) { coordinatorUpgradeSession = value; },
    coordinatorUpgradeError,
    readCoordinatorAuthorityRecord,
    claimCoordinatorAuthority,
    get coordinatorAuthorityClaimInFlight() { return coordinatorAuthorityClaimInFlight; }, set coordinatorAuthorityClaimInFlight(value: typeof coordinatorAuthorityClaimInFlight) { coordinatorAuthorityClaimInFlight = value; },
    scheduleCoordinatorAuthorityClaim,
    ensureCoordinatorAuthorityClaim,
    assertCoordinatorAuthorityCurrent,
    makeCoordinatorFinalIoLeaseId,
    acquireCoordinatorFinalIoLeaseExclusive,
    withCoordinatorSharedReadLeaseMutation,
    hasCurrentCoordinatorSharedReadLease,
    acquireCoordinatorFinalIoLease,
    ensureCoordinatorUpgradeSession,
    withCoordinatorFinalIoLease,
    withCoordinatorFinalIoLeaseAdmitted,
    closeCoordinatorUpgradeSession,
    finalIoAudit,
  };
}
