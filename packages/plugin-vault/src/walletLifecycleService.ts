// 单 Key 钱包生命周期服务。
//
// 这是「创建/导入、解锁、锁定、改密、改名、导出 KeyHold、重置」的唯一实现，
// 由 Coordinator Worker 持有。页面只能通过受限命令驱动它，拿不到私钥、
// 也不决定写入授权。
//
// 三个关键约束在这里落地：
//   - 初始化是**一次** WalletStore.batch：KeyHold、.keymaster/meta 和必要初始
//     系统记录同事务提交，事务完成才算成功；取消或失败不留半成品。
//   - 每个句柄绑定钱包身份世代、会话 epoch 和 Worker 运行世代；重置、锁定和
//     Worker 重启都会改变其中一项，旧句柄和迟到结果在这里被拒绝。
//   - 重置先撤销授权，再原子清空新格式数据；失败不报告完成，且旧授权不因
//     失败而自动恢复。

import type {
  StorageErrorCode,
  WalletColdStartSnapshot,
  WalletInitializePhase,
  WalletInitializePlan,
  WalletInitializeResult,
  WalletKeySummary,
  WalletLifecycleEvent,
  WalletLifecycleService,
  WalletMetaV1,
  WalletUnlockResult,
  WalletUserFacingError,
} from "@keymaster/contracts";
import {
  KEYHOLD_LIMITS,
  WALLET_CURRENT_SCHEMA_VERSION,
  WALLET_META_FORMAT,
  WALLET_META_PATH,
  validateWalletMeta,
} from "@keymaster/contracts";
import * as secp256k1 from "@noble/secp256k1";
import type { WalletVaultLifecycleStore } from "@keymaster/contracts/storage-internal";
import type { WalletKeyRepository } from "./walletKeyRepository.js";
import { createKeyHoldDocument, serializeKeyHoldDocument } from "./keyholdDocument.js";
import { StorageRuntimeError, storageErrorCode, WALLET_INITIALIZATION_PATH } from "@keymaster/contracts/storage-internal";

/** 解锁后建立的会话世代前缀。 */
const SESSION_EPOCH_PATTERN = /^[0-9a-f-]{36}$/u;

export interface WalletLifecycleDeps {
  /** 正式本地介质。 */
  store: WalletVaultLifecycleStore;
  /** 固定路径的单 Key 仓储；只用于解锁、改密、改名和导出。 */
  keys: WalletKeyRepository;
  /** 生成新的钱包身份世代。 */
  generateWalletGeneration: () => string;
  /** 生成会话 epoch。 */
  generateSessionEpoch: () => string;
  /** 生成公开地址（用于 Key 摘要展示）。 */
  deriveAddress: (publicKeyHex: string) => string | undefined;
  /**
   * 撤销运行期授权。
   *
   * 重置与锁定必须先撤销会话、grant 与任务权限，再动数据；否则迟到的写入
   * 可能在清空之后落到新钱包里。
   */
  revokeGrants: (reason: "lock" | "reset") => void;
  /** 授予全新运行期绑定（会话 epoch 变化）。 */
  establishSession: (input: { sessionEpoch: string; walletGeneration: string; publicKeyHex: string }) => void;
  /**
   * Coordinator Worker 内部回调：在私钥被清零之前接管一份副本。
   *
   * 单 Key 模型下 Worker 仍要用明文私钥完成 Vault 本地秘密封装与 P2PKH、
   * Channel、Peer Record 签名，而私钥不能穿过页面 RPC，也不能交给插件。
   * 生命周期服务因此在 `initialize` / `unlock` 的提交成功之后、清零之前把
   * 副本交给 Worker 自己注入的回调；该回调不进入 Contracts，也不参与 RPC。
   * 交接的是**独占副本**：本服务紧接着就清零自己的缓冲区，若把同一块内存
   * 交出去，Worker 侧的会话私钥会一起变成全零。未注入时行为与纯存储语义
   * 一致，私钥随即被清零。
   */
  adoptUnlockedKey?: (input: {
    identity: import("@keymaster/contracts").KeyIdentity;
    privateKeyBytes: Uint8Array;
    publicKeyHex: string;
    walletGeneration: string;
    sessionEpoch: string;
  }) => void;
  /** 广播生命周期事件给各 Tab。 */
  publish: (event: WalletLifecycleEvent) => void;
  /** 当前时钟；可注入以便测试。 */
  now?: () => number;
  /** 当前运行世代。 */
  runGeneration: () => string;
  /** 当前会话 epoch；锁定状态下为空串。 */
  currentSessionEpoch: () => string;
  /** 删除一个已撤销 App 的独立目录；只作用于该目录。 */
  clearAppRoot: (appStorageName: string) => Promise<void>;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function privateKeyFromHex(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new StorageRuntimeError("storage_identity_required", "Imported private key material is invalid");
  }
  return Uint8Array.from(normalized.match(/.{2}/gu)!, (pair) => Number.parseInt(pair, 16));
}

function errorCode(error: unknown): StorageErrorCode {
  return storageErrorCode(error) ?? "storage_provider_error";
}

/** 生成面向用户的失败结果；诊断信息脱敏后折叠展示。 */
function userFacingError(input: {
  phase: WalletInitializePhase;
  code: StorageErrorCode;
  summary: string;
  action?: string;
  diagnostic: string;
}): WalletUserFacingError {
  const titles: Record<WalletInitializePhase, string> = {
    validate: "输入无法识别",
    "derive-key": "无法派生钱包 Key",
    commit: "无法保存钱包",
    rollback: "钱包未完成初始化",
    complete: "初始化已完成",
  };
  return {
    title: titles[input.phase],
    summary: input.summary,
    ...(input.action === undefined ? {} : { action: input.action }),
    code: input.code,
    incidentId: crypto.randomUUID(),
    diagnostic: input.diagnostic,
    phase: input.phase,
  };
}

/** 构造绑定新钱包引擎的生命周期服务。 */
export function createWalletLifecycleService(deps: WalletLifecycleDeps): WalletLifecycleService & {
  /** 当前钱包身份世代；未初始化时为空串。 */
  walletGeneration(): string;
  /** 校验某个 grant 的世代是否仍然是当前的。 */
  isGrantLive(input: { walletGeneration: string; sessionEpoch: string; runGeneration: string }): boolean;
  /** 撤销指定 App 的授权并清空它的独立目录。 */
  revokeApp(appStorageName: string): Promise<void>;
} {
  const now = deps.now ?? (() => Date.now());
  const listeners = new Set<(event: WalletLifecycleEvent) => void>();
  let walletGeneration = "";

  const emit = (event: WalletLifecycleEvent): void => {
    for (const listener of [...listeners]) listener(event);
    deps.publish(event);
  };

  async function readMetaBytes(): Promise<WalletMetaV1 | undefined> {
    const record = await deps.store.readMeta();
    if (!record) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(record.bytes));
    } catch {
      return undefined;
    }
    try {
      return validateWalletMeta(parsed);
    } catch {
      return undefined;
    }
  }

  /**
   * 冷启动：只读 meta 与固定 KeyHold。
   *
   * 判定规则（缺一不可）：
   *   - 两项都不存在 → uninitialized；
   *   - meta 存在但标记未初始化、且没有 KeyHold → uninitialized（重置墓碑）；
   *   - 两项都在且合法 → ready；
   *   - 只有一项存在，或存在但不可解析 → corrupt；
   *   - meta 的 schemaVersion 高于当前实现 → unsupported。
   *
   * corrupt 与 unsupported 都不允许静默创建空钱包：那样会用默认值覆盖仍可能
   * 可恢复的数据。
   */
  async function coldStart(): Promise<WalletColdStartSnapshot> {
    const metaRecord = await deps.store.readMeta();
    let meta: WalletMetaV1 | undefined;
    let metaCorrupt = false;
    if (metaRecord) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metaRecord.bytes));
      } catch {
        metaCorrupt = true;
      }
      if (!metaCorrupt) {
        try {
          meta = validateWalletMeta(parsed);
        } catch {
          metaCorrupt = true;
        }
      }
    }

    let key: WalletColdStartSnapshot["key"];
    let keyPresent = false;
    let keyCorrupt = false;
    try {
      const keyHold = await deps.keys.read();
      if (keyHold) {
        keyPresent = true;
        key = { publicKeyHex: keyHold.document.publicKeyHex, label: keyHold.document.label };
      }
    } catch {
      keyPresent = true;
      keyCorrupt = true;
    }

    if (!metaRecord && !keyPresent) {
      walletGeneration = "";
      return { state: "uninitialized" };
    }
    // 重置会原子清空数据并留下一份 initialized:false 的 meta 作为墓碑。这个
    // 组合是「有意清空」的证据，不是损坏：判成 corrupt 会让用户重置后永远
    // 无法重新创建或导入，也违背「重置成功后回到未初始化状态」。
    if (meta && !meta.initialized && !keyPresent && !metaCorrupt && !keyCorrupt) {
      walletGeneration = "";
      return { state: "uninitialized" };
    }
    if (metaCorrupt || keyCorrupt || (metaRecord && !meta) || (!metaRecord && keyPresent) || (meta && !meta.initialized && keyPresent)) {
      walletGeneration = meta?.walletGeneration ?? "";
      return {
        state: "corrupt",
        ...(meta === undefined ? {} : { meta }),
        reason: metaCorrupt || keyCorrupt ? "wallet meta or key hold is unreadable" : "wallet initialization record is incomplete",
      };
    }
    if (!meta) {
      walletGeneration = "";
      return { state: "corrupt", reason: "wallet meta is missing" };
    }
    if (meta.schemaVersion > WALLET_CURRENT_SCHEMA_VERSION) {
      walletGeneration = meta.walletGeneration;
      return {
        state: "unsupported",
        meta,
        reason: `local schema v${meta.schemaVersion} is newer than this build`,
      };
    }
    if (!keyPresent) {
      walletGeneration = meta.walletGeneration;
      return { state: "corrupt", meta, reason: "key hold is missing" };
    }
    walletGeneration = meta.walletGeneration;
    return { state: "ready", meta, ...(key === undefined ? {} : { key }) };
  }

  /** Key 摘要的公钥/地址/能力组装。 */
  function summarize(input: {
    publicKeyHex: string;
    label: string;
    format: string;
    capabilities: string[];
    createdAt: string;
    source?: string;
  }): WalletKeySummary {
    return {
      publicKeyHex: input.publicKeyHex,
      label: input.label,
      address: deps.deriveAddress(input.publicKeyHex) ?? input.publicKeyHex,
      format: input.format,
      capabilities: input.capabilities,
      createdAt: input.createdAt,
      ...(input.source === undefined ? {} : { source: input.source }),
    };
  }

  /**
   * 创建或导入唯一 Key。
   *
   * KeyHold 字节、meta 与初始系统记录在**同一个** WalletStore.batch 内提交。
   * 失败或取消时整批 abort，IndexedDB 里不会留下可被当作完整钱包使用的
   * 半成品。
   */
  async function initialize(plan: WalletInitializePlan): Promise<WalletInitializeResult> {
    let draft: WalletInitializePlan["firstKey"];
    try {
      draft = plan.firstKey;
      if (!draft || (draft.kind !== "generate" && draft.kind !== "import")) {
        throw new StorageRuntimeError("storage_identity_required", "Wallet draft is invalid");
      }
      if (typeof draft.password !== "string" || draft.password.length === 0) {
        throw new StorageRuntimeError("storage_identity_required", "Key password is required");
      }
    } catch (caught) {
      return {
        ok: false,
        error: userFacingError({
          phase: "validate",
          code: errorCode(caught),
          summary: "未提供可用的钱包 Key 草稿。",
          action: "重新选择创建或导入，并设置 Key 密码。",
          diagnostic: caught instanceof Error ? caught.message : String(caught),
        }),
      };
    }

    // 已有 Key 的钱包不允许覆盖：只能走重置流程。
    //
    // 重置会留下 initialized:false 的 meta 墓碑，那是「有意清空」的证据而不是
    // 已存在的钱包。若把它当作已有钱包，用户重置后就再也无法创建或导入。
    const existing = await coldStart();
    if (existing.state !== "uninitialized") {
      return {
        ok: false,
        error: userFacingError({
          phase: "validate",
          code: "storage_conflict",
          summary: "当前钱包已存在唯一 Key。",
          action: "如需更换身份，请先重置钱包。",
          diagnostic: "wallet meta already exists",
        }),
      };
    }

    let privateKeyBytes: Uint8Array;
    let format: string;
    let source: string | undefined;
    try {
      if (draft.kind === "generate") {
        privateKeyBytes = secp256k1.utils.randomPrivateKey();
        format = "generated";
      } else {
        privateKeyBytes = privateKeyFromHex(draft.material.hex);
        format = draft.format;
        source = draft.source;
      }
    } catch (caught) {
      return {
        ok: false,
        error: userFacingError({
          phase: "validate",
          code: errorCode(caught),
          summary: "私钥材料无法识别。",
          action: "检查私钥或 KeyHold 文件后重新导入。",
          diagnostic: caught instanceof Error ? caught.message : String(caught),
        }),
      };
    }

    const createdAt = new Date(now()).toISOString();
    let keyHoldBytes: Uint8Array;
    let publicKeyHex: string;
    let documentLabel: string;
    try {
      const document = await createKeyHoldDocument(
        { label: draft.label, privateKey: privateKeyBytes },
        draft.password,
      );
      // 身份一致性校验：派生出的公钥必须与文档声明一致，否则拒绝提交。
      const derived = secp256k1.Point.fromPrivateKey(privateKeyBytes).toHex(true);
      if (derived !== document.publicKeyHex) {
        throw new StorageRuntimeError("storage_wallet_corrupt", "Derived public key does not match the key hold document");
      }
      publicKeyHex = document.publicKeyHex;
      documentLabel = document.label;
      const serialized = serializeKeyHoldDocument(document);
      if (new TextEncoder().encode(serialized).byteLength > KEYHOLD_LIMITS.maxSerializedBytes) {
        throw new StorageRuntimeError("storage_limit_exceeded", "Key hold exceeds its size limit");
      }
      keyHoldBytes = new TextEncoder().encode(serialized);
    } catch (caught) {
      privateKeyBytes.fill(0);
      return {
        ok: false,
        error: userFacingError({
          phase: "derive-key",
          code: errorCode(caught),
          summary: "无法用该密码加密钱包 Key。",
          action: "更换一个更强的 Key 密码后重试。",
          diagnostic: caught instanceof Error ? caught.message : String(caught),
        }),
      };
    }

    const walletIdentity = deps.generateWalletGeneration();
    const meta: WalletMetaV1 = {
      format: WALLET_META_FORMAT,
      version: 1,
      schemaVersion: WALLET_CURRENT_SCHEMA_VERSION,
      initialized: true,
      walletGeneration: walletIdentity,
      createdAt,
    };

    try {
      // 唯一的提交边界：KeyHold、meta 与初始化记录同事务落盘。
      // 条件创建保证并发初始化只有一个成功，另一方得到 conflict 而不是覆盖。
      await deps.store.batch({
        operations: [
          { type: "put", path: "key.json", bytes: keyHoldBytes, contentType: "application/json" },
          { type: "put", path: WALLET_META_PATH, bytes: encode(meta), contentType: "application/json" },
          {
            type: "put",
            path: WALLET_INITIALIZATION_PATH,
            bytes: encode({
              format: "keymaster.wallet-initialization",
              version: 1,
              initializedAt: createdAt,
              walletGeneration: walletIdentity,
            }),
            contentType: "application/json",
          },
        ],
        // 条件创建只判 KeyHold 是否缺席：这才是「唯一 Key 已被创建」的真值。
        // meta 不参与条件，因为重置会主动留下一份 initialized:false 的墓碑，
        // 把它也要求为缺席会让重置之后的初始化永远冲突。
        conditions: [{ path: "key.json", ifNoneMatch: true }],
      });
    } catch (caught) {
      privateKeyBytes.fill(0);
      const code = errorCode(caught);
      return {
        ok: false,
        error: userFacingError({
          phase: "commit",
          code,
          summary: code === "storage_conflict"
            ? "钱包已被其它标签页初始化。"
            : "保存钱包时本地存储失败。",
          ...(code === "storage_limit_exceeded"
            ? { action: "释放浏览器存储空间后重试。" }
            : code === "storage_conflict"
              ? { action: "刷新页面后查看当前钱包状态。" }
              : {}),
          diagnostic: caught instanceof Error ? caught.message : String(caught),
        }),
      };
    }

    walletGeneration = walletIdentity;
    const sessionEpoch = deps.generateSessionEpoch();
    // 初始化直接进入已解锁：用户刚设的密码在本会话内有效。
    deps.establishSession({ sessionEpoch, walletGeneration: walletIdentity, publicKeyHex });
    // 提交已经成功；此时才把私钥副本交给 Worker，随后本方法立即清零。
    // 交接必须是独占副本：Worker 会一直持有它到锁定或换 Key。
    deps.adoptUnlockedKey?.({
      identity: { publicKeyHex, label: documentLabel, capabilities: [...draft.capabilities], createdAt },
      privateKeyBytes: new Uint8Array(privateKeyBytes),
      publicKeyHex,
      walletGeneration: walletIdentity,
      sessionEpoch,
    });
    privateKeyBytes.fill(0);
    emit({ type: "initialized", walletGeneration: walletIdentity });
    emit({ type: "unlocked", sessionEpoch, walletGeneration: walletIdentity });

    return {
      ok: true,
      key: summarize({
        publicKeyHex,
        label: documentLabel,
        format,
        capabilities: draft.capabilities,
        createdAt,
        ...(source === undefined ? {} : { source }),
      }),
      walletGeneration: walletIdentity,
    };
  }

  /** 用 Key 密码解锁唯一 Key。 */
  async function unlock(password: string): Promise<WalletUnlockResult> {
    const snapshot = await coldStart();
    if (snapshot.state === "unsupported") {
      throw new StorageRuntimeError("storage_wallet_unsupported", "Local wallet schema is newer than this build");
    }
    if (snapshot.state === "corrupt") {
      throw new StorageRuntimeError("storage_wallet_corrupt", "Wallet data is incomplete or damaged");
    }
    if (snapshot.state === "uninitialized") {
      throw new StorageRuntimeError("storage_not_found", "No wallet has been created yet");
    }
    const unlocked = await deps.keys.unlock(password);
    try {
      const sessionEpoch = deps.generateSessionEpoch();
      // 每次解锁都换新 epoch：旧 grant、任务和句柄立即失效。
      deps.establishSession({
        sessionEpoch,
        walletGeneration: snapshot.meta?.walletGeneration ?? walletGeneration,
        publicKeyHex: unlocked.document.publicKeyHex,
      });
      // 认证通过后才把私钥副本交给 Worker；本方法随即清零，不向外泄漏。
      // 交接的是独占副本：下面的 finally 只清零本服务的缓冲区。
      deps.adoptUnlockedKey?.({
        identity: { publicKeyHex: unlocked.document.publicKeyHex, label: unlocked.document.label, capabilities: ["p2pkh"], createdAt: snapshot.meta?.createdAt ?? "" },
        privateKeyBytes: new Uint8Array(unlocked.privateKeyBytes),
        publicKeyHex: unlocked.document.publicKeyHex,
        walletGeneration: snapshot.meta?.walletGeneration ?? walletGeneration,
        sessionEpoch,
      });
      emit({ type: "unlocked", sessionEpoch, walletGeneration: snapshot.meta?.walletGeneration ?? walletGeneration });
      return {
        sessionEpoch,
        walletGeneration: snapshot.meta?.walletGeneration ?? walletGeneration,
        publicKeyHex: unlocked.document.publicKeyHex,
      };
    } finally {
      unlocked.privateKeyBytes.fill(0);
    }
  }

  /** 锁定：先撤销授权，再清空内存中的运行态。 */
  async function lock(): Promise<void> {
    deps.revokeGrants("lock");
    emit({ type: "locked" });
  }

  /**
   * 只校验 Key 密码，不改变任何状态。
   *
   * 校验路径与 `unlock` 完全一致（同一个 `key.json`、同一套 KeyHold 解密），
   * 但刻意不做三件事：不换会话世代、不建立会话、不授予任何 grant。解出的
   * 私钥在方法返回前立刻清零，因此本方法没有「密码验证会顺带解锁」的副作用。
   * 未初始化、损坏或 schema 过新都在这里 fail closed，而不是当成密码错误。
   */
  async function verifyPassword(password: string): Promise<void> {
    const snapshot = await coldStart();
    if (snapshot.state === "unsupported") {
      throw new StorageRuntimeError("storage_wallet_unsupported", "Local wallet schema is newer than this build");
    }
    if (snapshot.state === "corrupt") {
      throw new StorageRuntimeError("storage_wallet_corrupt", "Wallet data is incomplete or damaged");
    }
    if (snapshot.state === "uninitialized") {
      throw new StorageRuntimeError("storage_not_found", "No wallet has been created yet");
    }
    const verified = await deps.keys.unlock(password);
    // 密码已通过认证，但明文私钥不进入任何状态：本方法结束即丢弃。
    verified.privateKeyBytes.fill(0);
  }

  async function changePassword(input: { oldPassword: string; newPassword: string }): Promise<void> {
    if (typeof input.newPassword !== "string" || input.newPassword.length === 0) {
      throw new StorageRuntimeError("storage_identity_required", "New key password is required");
    }
    const updated = await deps.keys.changePassword({ oldPassword: input.oldPassword, newPassword: input.newPassword });
    // 改密后旧密码派生出的授权不应继续有效：换新会话 epoch。
    const sessionEpoch = deps.generateSessionEpoch();
    deps.establishSession({
      sessionEpoch,
      walletGeneration,
      publicKeyHex: updated.document.publicKeyHex,
    });
    emit({ type: "password-changed" });
    emit({ type: "unlocked", sessionEpoch, walletGeneration });
  }

  async function rename(label: string): Promise<void> {
    const updated = await deps.keys.rename(label);
    walletGeneration = walletGeneration || (await readMetaBytes())?.walletGeneration || "";
    emit({ type: "renamed", label: updated.document.label });
  }

  async function exportKeyHold(): Promise<Uint8Array> {
    return await deps.keys.export();
  }

  /**
   * 重置钱包：撤销授权后原子清空新格式数据。
   *
   * 顺序很重要：先撤销，之后迟到的写入在任何数据层检查之前就已经被拒。数据
   * 清空与新世代写入在同一事务内完成，失败时既不报告完成，也不会把旧授权
   * 带进下一次初始化。
   */
  async function resetWallet(input: { confirmationLabel: string }): Promise<{ walletGeneration: string; clearedAt: string }> {
    const snapshot = await coldStart();
    if (snapshot.state === "uninitialized") {
      throw new StorageRuntimeError("storage_not_found", "There is no wallet to reset");
    }
    const expected = snapshot.key?.label;
    if (typeof input.confirmationLabel !== "string" || input.confirmationLabel.length === 0
      || (expected !== undefined && input.confirmationLabel !== expected)) {
      throw new StorageRuntimeError("storage_identity_required", "Reset confirmation does not match the current key label");
    }
    // 先撤销会话、grant 与任务权限。
    deps.revokeGrants("reset");
    const cleared = await deps.store.resetWallet();
    walletGeneration = cleared.walletGeneration;
    emit({ type: "reset", walletGeneration: cleared.walletGeneration });
    return cleared;
  }

  return {
    coldStart,
    initialize,
    unlock,
    verifyPassword,
    lock,
    changePassword,
    rename,
    exportKeyHold,
    resetWallet,
    subscribe(listener: (event: WalletLifecycleEvent) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    walletGeneration(): string {
      return walletGeneration;
    },
    /**
     * grant 世代校验。
     *
     * 四个绑定项里任意一项与当前不符都判为失效：钱包世代（重置）、会话 epoch
     * （锁定/解锁）、运行世代（Worker 重启）。
     */
    isGrantLive(input: { walletGeneration: string; sessionEpoch: string; runGeneration: string }): boolean {
      if (!input.walletGeneration || input.walletGeneration !== walletGeneration) return false;
      if (!SESSION_EPOCH_PATTERN.test(input.sessionEpoch)) return false;
      if (input.sessionEpoch !== deps.currentSessionEpoch()) return false;
      if (input.runGeneration !== deps.runGeneration()) return false;
      return true;
    },
    /**
     * 撤销单个 App 授权。
     *
     * 这里只广播事件让页面丢弃该 App 的缓存授权，并调用 Coordinator 提供的
     * 清理回调删除它自己的目录；不影响其它 App、模块或平台记录。
     */
    async revokeApp(appStorageName: string): Promise<void> {
      await deps.clearAppRoot(appStorageName);
      emit({ type: "app-revoked", appStorageName });
    },
  };
}
