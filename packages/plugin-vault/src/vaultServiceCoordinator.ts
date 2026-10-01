// packages/plugin-vault/src/vaultServiceCoordinator.ts
// VaultService Coordinator Facade —— 单 Key 钱包的唯一页面侧入口。
//
// 设计边界（docs/存储.md）：
//   - 这里没有 Key 列表、没有选择、没有切换，也没有第二把 Key 的入口。系统里
//     只有一把钱包 Key，公开信息通过 getCurrentKey() 读取。
//   - 身份生命周期（创建/导入/解锁/锁定/改密/重置）走 storage.control 的钱包
//     通道：Coordinator 在一个 IndexedDB 事务内提交 KeyHold、meta 与必要初始
//     系统数据，页面不自己拼装多步流程，也不写任何持久数据。
//   - 只读状态全部来自已经提交的 SessionStateMirror；facade 不拥有独立真值、
//     不持有私钥、不排队任务、不持有 timer。

import type {
  ActiveKeyCrypto,
  CoordinatorCommandResult,
  CoordinatorValueResult,
  CoordinatorVaultKeyView,
  CoordinatorVaultOperation,
  CoordinatorVaultOperationResultFor,
  EcdsaSignatureFormat,
  KeyRef,
  VaultCoordinatorControl,
  VaultLifecycleSnapshot,
  VaultService,
  VaultStatus,
  WalletColdStartSnapshot,
  WalletInitializePlan,
  WalletInitializeResult,
  WalletKeySummary,
} from "@keymaster/contracts";
import type { CoordinatorStorageControl, CoordinatorStorageControlResultFor } from "@keymaster/contracts";
import type { SessionStateMirror, SessionStateSnapshot } from "./sessionStateMirror.js";

/** Vault facade 所需的 Coordinator contract 子集。 */
export type CoordinatorClientLike = VaultCoordinatorControl;

export interface VaultServiceCoordinatorDeps {
  coordinatorClient: CoordinatorClientLike;
  sessionStateMirror: SessionStateMirror;
}

function commandResultMessage(result: CoordinatorCommandResult, fallback: string): string {
  if ("message" in result) return result.message;
  if (result.status === "blocked") return typeof result.reason === "string" ? result.reason : result.reason.fallback;
  return `${fallback}: ${result.status}`;
}

function unwrapValueResult<T>(result: CoordinatorValueResult<T>, operation: string): T {
  if (result.status === "ok") return result.value;
  throw new Error(commandResultMessage(result, `${operation} failed`));
}

function mapVaultStatus(status: SessionStateSnapshot["vaultStatus"]): VaultStatus {
  switch (status) {
    // Coordinator 的 fatal 仍是一次真实的钱包状态；页面侧映射为 locked，
    // 具体原因由 StorageUnavailableGuard 的 uninitialized/locked/corrupt/
    // unsupported 分类展示。
    case "booting": return "booting";
    case "uninitialized": return "uninitialized";
    case "locked": return "locked";
    case "unlocked": return "unlocked";
    default: return "locked";
  }
}

function toKeyRef(view: CoordinatorVaultKeyView): KeyRef {
  return {
    publicKeyHex: view.publicKeyHex,
    label: view.label,
    format: view.format,
    capabilities: [...view.capabilities],
    createdAt: view.createdAt,
    ...(view.source === undefined ? {} : { source: view.source }),
    ...(view.address === undefined ? {} : { address: view.address }),
    ...(view.network === undefined ? {} : { network: view.network }),
  };
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToArrayBuffer(hex: string): ArrayBuffer {
  const matches = hex.match(/../gu);
  if (!matches) throw new Error("signature hex is invalid");
  const bytes = new Uint8Array(matches.length);
  for (let i = 0; i < matches.length; i += 1) bytes[i] = parseInt(matches[i]!, 16);
  return bytes.buffer;
}

// ============================================================
// 2. VaultService Coordinator Facade
// ============================================================

export class VaultServiceCoordinator implements VaultService {
  private readonly coordinatorClient: CoordinatorClientLike;
  private readonly mirror: SessionStateMirror;
  private readonly appViewRevocations = new Map<string, () => void>();
  private readonly lifecycleChangeHandlers = new Set<(snapshot: VaultLifecycleSnapshot) => void>();
  private lifecycleSnapshot: VaultLifecycleSnapshot = Object.freeze({
    status: "booting",
    sessionEpoch: "boot",
    runGeneration: "boot",
    vaultLifecycleRevision: 0,
  });

  constructor(deps: VaultServiceCoordinatorDeps) {
    this.coordinatorClient = deps.coordinatorClient;
    this.mirror = deps.sessionStateMirror;
    this.mirror.subscribe((snapshot) => {
      if (this.applyCoordinatorState(snapshot)) this.emitLifecycleChanged();
    });
  }

  /** 同步 Coordinator 的 Vault 真值；返回是否有观察者应获知的变化。 */
  private applyCoordinatorState(snapshot: Readonly<SessionStateSnapshot>): boolean {
    const nextStatus = mapVaultStatus(snapshot.vaultStatus);
    // 公钥只在 unlocked 时可见：锁定或未初始化时页面不应继续持有身份投影。
    const nextPublicKeyHex = snapshot.vaultStatus === "unlocked" ? snapshot.activePublicKeyHex : undefined;
    const previous = this.lifecycleSnapshot;
    const changed = previous.status !== nextStatus
      || previous.activePublicKeyHex !== nextPublicKeyHex
      || previous.sessionEpoch !== snapshot.sessionEpoch
      || previous.runGeneration !== snapshot.runGeneration
      || previous.walletGeneration !== snapshot.walletGeneration
      || previous.vaultLifecycleRevision !== snapshot.sessionRevision;
    if (!changed) return false;

    this.lifecycleSnapshot = Object.freeze({
      status: nextStatus,
      ...(nextPublicKeyHex === undefined ? {} : { activePublicKeyHex: nextPublicKeyHex }),
      sessionEpoch: snapshot.sessionEpoch,
      runGeneration: snapshot.runGeneration,
      vaultLifecycleRevision: snapshot.sessionRevision,
      ...(snapshot.walletGeneration === undefined ? {} : { walletGeneration: snapshot.walletGeneration }),
    });
    return true;
  }

  // ============================================================
  // 3. State Access
  // ============================================================

  status(): VaultStatus {
    return this.lifecycleSnapshot.status;
  }

  onLifecycleChange(handler: (snapshot: VaultLifecycleSnapshot) => void): () => void {
    this.lifecycleChangeHandlers.add(handler);
    handler({ ...this.lifecycleSnapshot });
    return () => { this.lifecycleChangeHandlers.delete(handler); };
  }

  getLifecycleSnapshot(): VaultLifecycleSnapshot {
    return { ...this.lifecycleSnapshot };
  }

  /** 本 Origin 是否已有钱包 Key（无论锁定与否）。 */
  async hasVault(): Promise<boolean> {
    return this.lifecycleSnapshot.status !== "uninitialized";
  }

  /** 冷启动快照：Worker 只读 meta 与固定 KeyHold，不解密私钥。 */
  async coldStart(): Promise<WalletColdStartSnapshot> {
    return this.storageControl({ type: "cold-start" });
  }

  // ============================================================
  // 4. Vault Operations
  // ============================================================

  /**
   * 创建或导入唯一钱包 Key。
   *
   * 页面不再分步「先建空 Vault 再加 Key」：KeyHold、`.keymaster/meta` 与必要
   * 初始系统数据由 Coordinator 在一个 IndexedDB 事务内提交，只有事务完成才
   * 返回成功。已有 Key 时必须 fail closed——更换身份要先 resetWallet。
   */
  async initialize(plan: WalletInitializePlan): Promise<WalletKeySummary> {
    const result: WalletInitializeResult = await this.storageControl({ type: "initialize", plan });
    if (!result.ok) {
      const { title, summary, action, code, phase } = result.error;
      throw new Error(action ? `${title}：${summary} ${action}` : `${title}：${summary}（${code}/${phase}）`);
    }
    return result.key;
  }

  async unlock(password: string): Promise<CoordinatorCommandResult> {
    return this.coordinatorClient.unlock(password);
  }

  async lock(): Promise<CoordinatorCommandResult> {
    return this.coordinatorClient.lock();
  }

  async changePassword(input: { oldPassword: string; newPassword: string }): Promise<void> {
    await this.vaultOperation({ type: "changePassword", ...input });
  }

  async verifyPassword(password: string): Promise<void> {
    await this.vaultOperation({ type: "verifyPassword", password });
  }

  async renameKey(label: string): Promise<void> {
    await this.vaultOperation({ type: "renameKey", label });
  }

  /**
   * 原样导出加密 KeyHold 文档。
   *
   * 这不是完整钱包备份：它只含 `key.json`，不含联系人、消息、设置等业务
   * 数据。文件保持既有加密格式。
   */
  async exportKeyHold(): Promise<Uint8Array> {
    return this.vaultOperation({ type: "exportKeyHold" });
  }

  async getCurrentKey(): Promise<KeyRef | undefined> {
    const view = await this.vaultOperation({ type: "getCurrentKey" });
    return view === undefined ? undefined : toKeyRef(view);
  }

  /**
   * 重置钱包：先撤销会话与授权，再原子清空新格式全部数据。
   *
   * 失败不报告完成，旧授权也不因失败自动恢复；成功后回到 uninitialized。
   * 这不撤销链上交易或服务端已经接受的操作。
   */
  async resetWallet(input: { confirmationLabel: string }): Promise<{ walletGeneration: string; clearedAt: string }> {
    return this.storageControl({ type: "reset-wallet", confirmationLabel: input.confirmationLabel });
  }

  // ============================================================
  // 5. Crypto Operations
  // ============================================================

  async createActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto> {
    return this.createCoordinatorCrypto(publicKeyHex);
  }

  async createAppViewSession(input: {
    sessionId: string;
    publicKeyHex: string;
    password: string;
  }): Promise<ActiveKeyCrypto> {
    if (this.lifecycleSnapshot.activePublicKeyHex !== input.publicKeyHex) {
      throw new Error("AppView crypto requires the wallet key");
    }
    // appView session 必须自己提供 Key 密码，不能借用页面当前会话的授权
    // 凭据。verifyPassword 不改变 Vault 状态。
    await this.verifyPassword(input.password);
    this.disposeAppViewSession(input.sessionId, "appView session replaced");
    const crypto = await this.createCoordinatorCrypto(input.publicKeyHex, input.sessionId);
    this.appViewRevocations.set(input.sessionId, () => crypto.dispose?.("appView session disposed"));
    return crypto;
  }

  disposeAppViewSession(sessionId: string, reason?: string): void {
    void reason;
    const revoke = this.appViewRevocations.get(sessionId);
    if (revoke) revoke();
    this.appViewRevocations.delete(sessionId);
  }

  disposeAllAppViewSessions(reason?: string): void {
    void reason;
    for (const revoke of this.appViewRevocations.values()) revoke();
    this.appViewRevocations.clear();
  }

  dispose?(): void {
    this.disposeAllAppViewSessions("vault service disposed");
    this.lifecycleChangeHandlers.clear();
  }

  // ============================================================
  // 6. Coordinator plumbing
  // ============================================================

  /**
   * 钱包生命周期控制面。
   *
   * storage.control 走独立的 storage 通道，不复用 session unlock/lock 命令：
   * 后者承担跨 Tab 会话广播与自动锁语义，而这里是「事务级钱包操作」，成功
   * 与否以 IndexedDB 事务完成为准。
   */
  private async storageControl<C extends CoordinatorStorageControl>(control: C): Promise<CoordinatorStorageControlResultFor<C>> {
    if (!this.coordinatorClient.getIsConnected()) throw new Error("Coordinator RPC unavailable");
    const result = await this.coordinatorClient.storageControl(control) as CoordinatorValueResult<unknown>;
    return unwrapValueResult(result, control.type) as CoordinatorStorageControlResultFor<C>;
  }

  private async vaultOperation<O extends CoordinatorVaultOperation>(operation: O): Promise<CoordinatorVaultOperationResultFor<O>> {
    if (!this.coordinatorClient.getIsConnected()) throw new Error("Coordinator RPC unavailable");
    return unwrapValueResult(await this.coordinatorClient.vaultOperation(operation), operation.type);
  }

  private async createCoordinatorCrypto(publicKeyHex: string, sessionId = `${publicKeyHex}:${Date.now()}`): Promise<ActiveKeyCrypto> {
    const client = this.coordinatorClient;
    if (!client.getIsConnected()) throw new Error("Coordinator crypto RPC unavailable");
    let revoked = false;
    // 会话状态、身份与运行世代任一变化，本地句柄立刻失效：锁定、钱包重置
    // 或 Worker 重启后，任何仍在飞行中的旧 capability 都不得再使用。
    const guard = () => {
      if (revoked) throw new Error("Active key session has been revoked");
      const snapshot = this.lifecycleSnapshot;
      if (snapshot.status !== "unlocked" || snapshot.activePublicKeyHex !== publicKeyHex) {
        throw new Error("Active key session has been revoked");
      }
      if (snapshot.runGeneration !== this.mirror.getSnapshot().runGeneration) {
        throw new Error("Active key session has been revoked");
      }
    };
    return {
      getIdentity: () => { guard(); return { publicKeyHex, label: "", capabilities: [], createdAt: "", sessionId }; },
      async signDigest(input) {
        guard();
        const r = await client.crypto!({ type: "signDigest", digestHex: bytesToHex(input.digest), format: input.format });
        if (r.ack.status !== "ok" || !r.result) throw new Error(commandResultMessage(r.ack, "Sign failed"));
        const result = r.result as { signatureHex: string; format: string };
        if (result.format !== "der" && result.format !== "compact") {
          throw new Error(`signDigest: unexpected format "${result.format}" from Coordinator`);
        }
        if (result.format !== input.format) {
          throw new Error(`signDigest format mismatch: requested "${input.format}", got "${result.format}"`);
        }
        return { publicKeyHex, format: result.format as EcdsaSignatureFormat, signature: hexToArrayBuffer(result.signatureHex) };
      },
      async deriveP2pkhAddress(input) {
        guard();
        const r = await client.crypto!({ type: "deriveP2pkhAddress", network: input.network });
        if (r.ack.status !== "ok" || !r.result) throw new Error(commandResultMessage(r.ack, "Derive failed"));
        return { publicKeyHex, address: (r.result as { address: string }).address };
      },
      exportEncryptedKeyBackup: async (input) => {
        guard();
        if (input.publicKeyHex !== publicKeyHex) throw new Error("session_key_mismatch");
        // 业务 capability 只暴露加密 KeyHold 文档；它不提供联系人、消息或
        // 设置等本地业务数据的导出，也不暴露明文私钥。
        const hold = await this.exportKeyHold();
        const buffer = new Uint8Array(hold.byteLength);
        buffer.set(hold);
        return { publicKeyHex, backup: buffer.buffer };
      },
      dispose: () => {
        if (revoked) return;
        revoked = true;
        this.appViewRevocations.delete(sessionId);
      },
    };
  }

  private emitLifecycleChanged(): void {
    for (const handler of this.lifecycleChangeHandlers) {
      try { handler({ ...this.lifecycleSnapshot }); } catch { /* noop */ }
    }
  }
}

// ============================================================
// 7. Factory Function
// ============================================================

export function createVaultServiceCoordinator(deps: VaultServiceCoordinatorDeps): VaultService {
  return new VaultServiceCoordinator(deps);
}
