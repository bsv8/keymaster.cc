// packages/plugin-vault/src/vaultService.ts
// VaultService 实现。
// 关键不变量：
//   - 明文私钥只存在于受控 session capability 的短生命周期内部，调用结束即丢。
//   - 不持有全局明文缓存；每次受控能力调用都按需解密、按需释放。
//   - 状态机：booting -> uninitialized -> locked -> unlocked。
//   - 导出必须由 Vault 完成，因为只有 Vault 能在本地会话里受控处理明文私钥。
//   - importPrivateKey 必须拒绝重复 publicKeyHex；错误信息使用英文。
//   - 硬切换 002 收尾：`vault_keys` canonical store 主键 = publicKeyHex。
//     新建 / 导入 key 时必须**先**派生 publicKeyHex 再落库；不存在
//     "先 uuid、再回填身份"的路径。`crypto.randomUUID()` 不再被 vault
//     用作 key 域主键。
//   - emit key.created / key.deleted 时 payload 只携带 publicKeyHex。
//
// 硬切换 002 收尾：unlock 完成边界收紧——"unlocked" 对 UI / 业务
// 插件的语义是"keyspace ready 边界已完成，业务可以安全读取 key-scoped
// storage"。具体顺序：password 校验 -> 派生 vault session key ->
// keyspace.onVaultUnlocked -> setStatus("unlocked") + emit。
// 失败时回退到 locked 并清空会话。
//
// 硬切换 003 收尾：
//   - 系统不再生成、缓存、回写、透传 `fingerprint` 字段。
//   - 短公钥属于 UI 显示格式，**不**在 vault 层派生。展示时由 UI
//     调 `formatShortPublicKey(publicKeyHex)` 现算。
//   - 旧库残留 `fingerprint` 仍可能存在于 `vault_keys` 记录上，读取时
//     忽略，回写时也不再续命。

import type { MessageBus } from "@keymaster/runtime";
import { reportFatalError } from "@keymaster/runtime";
import {
  EVENT_ACTIVE_KEY_CHANGED,
  ActiveKeySessionRevokedError,
  KeyPersistedButActivationFailedError,
  type ActiveKeyState,
  type KeyIdentity,
  type KeyRef,
  type PluginLogger,
  type ProviderSealedMessageRecord,
  type VaultService,
  type VaultStatus,
  type CoordinatorCommandResult
} from "@keymaster/contracts";
import type { VaultSessionState } from "@keymaster/contracts";
import { type AppMsgMessage } from "@keymaster/contracts";
import {
  aesGcmKeyFromRawBits,
  assertWebCryptoAvailable,
  deriveKey,
  encryptVerifier,
  hexToBytes
} from "./crypto.js";
import { publicKeyHexToP2pkhAddress } from "./p2pkhAddress.js";
import { encodeKeyBackup } from "./keyBackup.js";
import { decodeKeyBackup } from "./keyBackup.js";
import { deriveKeyIdentity, generatePrivateKeyHex } from "./keyIdentity.js";
import {
  buildVaultMeta as coordinatorBuildVaultMeta,
  decryptVaultKeyMaterialForMigration as coordinatorDecryptVaultKeyMaterialForMigration,
  encryptVaultKeyMaterial as coordinatorEncryptVaultKeyMaterial,
  deriveVaultPasswordKey as coordinatorDeriveVaultPasswordKey,
  migrateVaultKeysToV2Aad as coordinatorMigrateVaultKeysToV2Aad,
  resolveVaultPasswordKey as coordinatorResolveVaultPasswordKey,
  verifyVaultPasswordKey as coordinatorVerifyVaultPasswordKey
} from "./vaultCoordinator.js";
import {
  createSessionCryptoEngine,
  type SessionCryptoClientOptions
} from "./sessionCryptoClient.js";
import { vaultDb, type VaultKeyRecord, type VaultMetaRecord } from "./vaultDb.js";
import type { KeyspaceHandle } from "./keyspaceService.js";
import type { ActiveKeyCrypto } from "@keymaster/contracts";

interface VaultKeyMaterial {
  hex: string;
  wif?: string;
}

// 透传 contracts 中的 KeyPersistedButActivationFailedError：
// plugin-vault 内部旧实现 / 测试仍可直接 import 本文件的符号，
// 行为与直接 import contracts 完全一致。设计缘由见 contracts/src/vault.ts。
export { KeyPersistedButActivationFailedError };

/**
 * "首 Key 已落库但未自动 active"待展示 notice。
 *
 * 设计缘由（硬切换 009 收尾 + 硬切换 002 收尾）：之前这条 notice 走
 * messageBus `vault.created.persisted` 事件 + 页面级订阅，但消息总线
 * 事件是瞬时的，用户从 LockedShell 跳到首页时，VaultSettingsPage
 * 通常尚未挂载，订阅方收不到事件，notice 消失。
 *
 * 修复后改用可查询的 vault state：
 *   - `createVaultWithInitialKey` 命中 `KeyPersistedButActivationFailedError`
 *     时写入本 notice；
 *   - AppShell / 顶栏在挂载时通过 `getInitialActivationNotice()` 读取并展示
 *     提示横幅；
 *   - 用户手动切 active 后（active 变成这把 key）、用户 lock 后、或
 *     显式调 `clearInitialActivationNotice()` 后，notice 自动清空。
 */
export interface InitialActivationNotice {
  publicKeyHex: string;
  label: string;
}

/** Vault 标签最大长度。超出时拒绝写入。 */
const LABEL_MAX_LENGTH = 64;
/** generateKey 默认能力。 */
const DEFAULT_CAPABILITIES: string[] = ["p2pkh"];
/** generateKey 记录元数据：审计 / 回归测试使用。 */
const GENERATED_FORMAT = "generated";
const GENERATED_SOURCE = "vault-generated";

/**
 * 首启"新建钱包"默认标签：`Key YYYY-MM-DD HH:mm`。
 * 收敛在 Vault 内部：shell / VaultSettingsPage 复用同一格式。
 */
function defaultInitialKeyLabel(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `Key ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/**
 * 施工单 2026-06-30 001 收口：meta 形状校验。
 * 返回 null 表示通过；返回字符串表示具体缺哪个字段/类型不对。
 * 用于启动期（bootstrap）判坏"可读但形状错"的持久化数据,避免被
 * 静默放行到 unlock 阶段才炸。
 */
function validateMetaShape(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return "meta is not an object";
  const m = meta as Record<string, unknown>;
  if (m.id !== "singleton") return `meta.id must be "singleton", got ${JSON.stringify(m.id)}`;
  if (typeof m.saltB64 !== "string" || m.saltB64.length === 0) {
    return "meta.saltB64 missing or empty";
  }
  if (typeof m.verifierSaltB64 !== "string" || m.verifierSaltB64.length === 0) {
    return "meta.verifierSaltB64 missing or empty";
  }
  if (typeof m.verifierIvB64 !== "string" || m.verifierIvB64.length === 0) {
    return "meta.verifierIvB64 missing or empty";
  }
  if (typeof m.verifierCipherB64 !== "string" || m.verifierCipherB64.length === 0) {
    return "meta.verifierCipherB64 missing or empty";
  }
  if (typeof m.createdAt !== "string" || m.createdAt.length === 0) {
    return "meta.createdAt missing or empty";
  }
  return null;
}

/**
 * 施工单 2026-06-30 001 收口：vault_key 形状校验。
 * 必要字段（密码学材料 + 元数据）缺失一律视为损坏,启动期 fatal。
 * 硬切换 002：record 必带 `publicKeyHex`（canonical 主键） + 已加密
 * 私钥材料 + 元数据；缺一不可。
 */
function validateKeyShape(record: unknown): string | null {
  if (!record || typeof record !== "object") return "key record is not an object";
  const r = record as Record<string, unknown>;
  if (typeof r.publicKeyHex !== "string" || r.publicKeyHex.length === 0) {
    return "key.publicKeyHex missing or empty";
  }
  if (typeof r.label !== "string" || r.label.length === 0) {
    return `key(${String(r.publicKeyHex)}).label missing or empty`;
  }
  if (r.network !== "main" && r.network !== "test") {
    return `key(${String(r.publicKeyHex)}).network must be "main" or "test", got ${JSON.stringify(r.network)}`;
  }
  if (typeof r.format !== "string" || r.format.length === 0) {
    return `key(${String(r.publicKeyHex)}).format missing or empty`;
  }
  if (!Array.isArray(r.capabilities) || r.capabilities.length === 0) {
    return `key(${String(r.publicKeyHex)}).capabilities missing or empty`;
  }
  if (typeof r.createdAt !== "string" || r.createdAt.length === 0) {
    return `key(${String(r.publicKeyHex)}).createdAt missing or empty`;
  }
  if (typeof r.cipherSaltB64 !== "string" || r.cipherSaltB64.length === 0) {
    return `key(${String(r.publicKeyHex)}).cipherSaltB64 missing or empty`;
  }
  if (typeof r.cipherIvB64 !== "string" || r.cipherIvB64.length === 0) {
    return `key(${String(r.publicKeyHex)}).cipherIvB64 missing or empty`;
  }
  if (typeof r.cipherB64 !== "string" || r.cipherB64.length === 0) {
    return `key(${String(r.publicKeyHex)}).cipherB64 missing or empty`;
  }
  return null;
}

export interface VaultServiceDeps {
  messageBus: MessageBus;
  keyspace?: KeyspaceHandle;
  sessionCryptoEngineOptions?: SessionCryptoClientOptions;
  /**
   * 硬切换 002：业务插件注入的 logger。
   * vault 关键轨迹（unlock / lock / key created / deleted / active changed /
   * identity failed）走统一日志。不传时不记日志。
   */
  logger?: PluginLogger;
}

export function createVaultService(deps: VaultServiceDeps): VaultService {
  const statusListeners = new Set<(s: VaultStatus) => void>();
  let status: VaultStatus = "booting";
  type SessionCryptoEngine = Awaited<ReturnType<typeof createSessionCryptoEngine>>;
  interface VaultSessionStateInternal extends VaultSessionState {
    activeCrypto: SessionCryptoEngine | null;
  }
  let vaultSession: VaultSessionStateInternal | null = null;
  /** 当前 key 列表的内存缓存（identity 字段已就绪），避免每次都 await IndexedDB。 */
  let keyCache: KeyRef[] | null = null;
  /**
   * 当前创建过的 active-key capability 句柄。
   *
   * 设计缘由：锁定 / 删除材料 / dispose 时必须能够主动让旧 capability
   * 失效，而不是只依赖调用方“别再用”。
   */
  const activeKeyCryptoLeases = new Set<{
    publicKeyHex: string;
    revoke: (reason: string) => void;
  }>();
  const appViewSessions = new Map<
    string,
    {
      publicKeyHex: string;
      crypto: SessionCryptoEngine;
    }
  >();
  /**
   * "首 Key 已落库但未自动 active"待展示 notice。
   * 见 {@link InitialActivationNotice}。
   */
  let pendingActivationNotice: InitialActivationNotice | null = null;
  /** notice 变化订阅器。 */
  const noticeListeners = new Set<(n: InitialActivationNotice | null) => void>();
  /** messageBus 事件订阅的清理句柄。bootstrap 后挂载，setStatus(unlocked) 时启用。 */
  let activeChangeUnsub: (() => void) | null = null;

  function setPendingActivationNotice(next: InitialActivationNotice | null) {
    if (
      next === pendingActivationNotice ||
      (next && pendingActivationNotice && next.publicKeyHex === pendingActivationNotice.publicKeyHex)
    ) {
      return;
    }
    pendingActivationNotice = next;
    for (const l of noticeListeners) l(next);
  }

  function revokeActiveKeyCryptoLeases(publicKeyHex?: string, reason = "vault lifecycle"): void {
    for (const lease of Array.from(activeKeyCryptoLeases)) {
      if (publicKeyHex && lease.publicKeyHex !== publicKeyHex) continue;
      try {
        lease.revoke(reason);
      } catch {
        /* noop */
      } finally {
        activeKeyCryptoLeases.delete(lease);
      }
    }
  }

  function disposeAppViewSession(sessionId: string, reason = "appView session disposed"): void {
    const session = appViewSessions.get(sessionId);
    if (!session) return;
    appViewSessions.delete(sessionId);
    try {
      session.crypto.dispose(reason);
    } catch {
      /* noop */
    }
  }

  function disposeAllAppViewSessions(reason = "appView session disposed"): void {
    for (const sessionId of Array.from(appViewSessions.keys())) {
      disposeAppViewSession(sessionId, reason);
    }
  }

  async function createAndInstallSessionActiveCrypto(
    record: VaultKeyRecord,
    passwordKey: CryptoKey,
    sessionId?: string
  ): Promise<void> {
    if (!vaultSession) {
      throw new Error("Vault is locked");
    }
    const activeCrypto = await createActiveCryptoForRecord(record, passwordKey, sessionId);
    setSessionActiveCrypto(record.publicKeyHex, activeCrypto);
  }

  async function installCurrentSessionActiveCrypto(passwordKey: CryptoKey): Promise<void> {
    if (!vaultSession) {
      return;
    }
    const activePublicKeyHex = deps.keyspace?.active().activePublicKeyHex;
    let record: VaultKeyRecord | undefined;
    if (activePublicKeyHex) {
      record = await vaultDb.getKey(activePublicKeyHex);
    }
    if (!record) {
      const records = await vaultDb.listKeys();
      if (records.length === 0) {
        return;
      }
      record = [...records].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    }
    if (!record) {
      return;
    }
    await createAndInstallSessionActiveCrypto(record, passwordKey);
  }

  function startVaultSession(): void {
    const activePublicKeyHex = deps.keyspace?.active().activePublicKeyHex;
    vaultSession = {
      sessionId: crypto.randomUUID(),
      kind: "keymaster",
      publicKeyHex: activePublicKeyHex,
      revoked: false,
      activeCrypto: null
    };
  }

  function clearVaultSession(reason = "vault session cleared"): void {
    revokeActiveKeyCryptoLeases(undefined, reason);
    if (vaultSession) {
      vaultSession.revoked = true;
      try {
        vaultSession.activeCrypto?.dispose(reason);
      } catch {
        /* noop */
      }
    }
    keyCache = null;
    setPendingActivationNotice(null);
    if (activeChangeUnsub) {
      activeChangeUnsub();
      activeChangeUnsub = null;
    }
    vaultSession = null;
  }

  async function createActiveCryptoForRecord(
    record: VaultKeyRecord,
    passwordKey: CryptoKey,
    sessionId?: string
  ): Promise<SessionCryptoEngine> {
    const identity = await recordToIdentity(record);
    return createSessionCryptoEngine(
      {
        sessionId: sessionId ?? crypto.randomUUID(),
        publicKeyHex: record.publicKeyHex,
        passwordKey,
        encryptedPrivateKey: {
          publicKeyHex: record.publicKeyHex,
          cipherVersion: record.cipherVersion ?? "v1",
          cipherSaltB64: record.cipherSaltB64,
          cipherIvB64: record.cipherIvB64,
          cipherB64: record.cipherB64
        },
        label: identity.label,
        capabilities: identity.capabilities,
        createdAt: identity.createdAt
      },
      deps.sessionCryptoEngineOptions ?? {
        allowLocalEngineForTests: Boolean(
          (globalThis as { process?: { env?: { VITEST?: string } } }).process?.env?.VITEST
        )
      }
    );
  }

  function wrapActiveKeyCrypto(
    record: VaultKeyRecord,
    engine: SessionCryptoEngine,
    onDispose?: (reason: string) => void
  ): ActiveKeyCrypto {
    return {
      getIdentity() {
        return engine.getIdentity();
      },
      async signDigest(input) {
        return engine.signDigest(input);
      },
      async deriveP2pkhAddress(input) {
        return engine.deriveP2pkhAddress(input);
      },
      sealSendInput(input) {
        return engine.sealSendInput(input);
      },
      async openSealed(rec: ProviderSealedMessageRecord) {
        return engine.openSealed(rec);
      },
      async exportEncryptedKeyBackup(input) {
        if (input.publicKeyHex !== record.publicKeyHex) {
          throw new Error("session_key_mismatch");
        }
        const backup = encodeKeyBackup({
          backupVersion: 1,
          sourceVaultMeta: (await vaultDb.getMeta())!,
          keyRecord: record
        });
        return {
          publicKeyHex: record.publicKeyHex,
          backup: new TextEncoder().encode(backup).buffer
        };
      },
      dispose(reason = "dispose") {
        try {
          engine.dispose(reason);
        } finally {
          onDispose?.(reason);
        }
      }
    };
  }

  function setSessionActiveCrypto(publicKeyHex: string, activeCrypto: SessionCryptoEngine): void {
    if (!vaultSession) {
      throw new Error("Vault is locked");
    }
    try {
      vaultSession.activeCrypto?.dispose("active key replaced");
    } catch {
      /* noop */
    }
    vaultSession.publicKeyHex = publicKeyHex;
    vaultSession.activeCrypto = activeCrypto;
  }

  function setStatus(next: VaultStatus) {
    if (next === "locked" || next === "uninitialized") {
      clearVaultSession("vault status changed");
      deps.logger?.info({
        scope: "vault.lifecycle",
        event: "vault.locked",
        message: "Vault locked"
      });
    } else if (next === "unlocked") {
      deps.logger?.info({
        scope: "vault.lifecycle",
        event: "vault.unlocked",
        message: "Vault unlocked"
      });
      // 解锁后挂载 active 变化监听：如果用户随后手动把 notice 那把 key
      // 设为 active，自动清除 notice。
      if (!activeChangeUnsub) {
        const handler = (state: ActiveKeyState) => {
          if (
            pendingActivationNotice &&
            state.activePublicKeyHex === pendingActivationNotice.publicKeyHex
          ) {
            setPendingActivationNotice(null);
          }
        };
        activeChangeUnsub = deps.messageBus.subscribe(EVENT_ACTIVE_KEY_CHANGED, handler);
      }
    }
    status = next;
    for (const l of statusListeners) l(next);
  }

  async function bootstrap() {
    // 施工单 2026-06-30 001 硬切换：关键持久化异常不再静默降级为
    // uninitialized。区分四类场景：
    //   - 正常首启：meta 不存在 -> uninitialized。
    //   - meta 存在但读取抛错 / 形状错误 -> reportFatalError,不动
    //     VaultStatus；UI 由 fatal crash page 接管。
    //   - meta 存在 + listKeys 抛错 / 任何一条 key 记录形状错误 ->
    //     reportFatalError。
    //   - meta 存在 + keys 列表为空（0-key 护栏）：清 meta + uninitialized。
    // 设计缘由：旧实现把"本地数据损坏"伪装成"像第一次启动",误导用户
    // 也让排障失真。系统已经"不可信",继续走 LockedShell 欢迎页是
    // 错误语义。
    try {
      assertWebCryptoAvailable();
    } catch (err) {
      // WebCrypto 缺失：这是致命环境问题(main.tsx checkEnvironment
      // 应已拦下);这里作为最后一道防线升级 fatal。
      reportFatalError({
        phase: "vault.bootstrap",
        scope: "vault-service",
        source: "app-bundle",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cause: err
      });
      return;
    }
    let meta: Awaited<ReturnType<typeof vaultDb.getMeta>>;
    try {
      meta = await vaultDb.getMeta();
    } catch (err) {
      // 打开/读取 meta 失败：meta 是否存在都不可知,不能伪装成首启。
      // 升级 fatal,UI 切到崩溃页。
      reportFatalError({
        phase: "vault.bootstrap",
        scope: "vault-service",
        source: "app-bundle",
        message:
          "Failed to read vault meta from IndexedDB. The local runtime is no longer trusted.",
        stack: err instanceof Error ? err.stack : undefined,
        cause: err
      });
      return;
    }
    if (!meta) {
      // 正常首启:进入 uninitialized。
      setStatus("uninitialized");
      return;
    }
    // 关键记录形状校验：meta 存在但任何必要字段缺失/类型不对,
    // 都意味着"本地有系统数据,但当前代码不能可信使用它"。
    // 这一类"形状错误"在旧实现里被静默放行,直到后续 unlock / 业务
    // 读取时才炸——现在统一在启动期升级为 fatal。
    const metaShapeError = validateMetaShape(meta);
    if (metaShapeError) {
      reportFatalError({
        phase: "vault.bootstrap",
        scope: "vault-service",
        source: "app-bundle",
        message:
          `vault_meta record is corrupt: ${metaShapeError}. ` +
          "The local runtime is no longer trusted.",
        cause: { meta }
      });
      return;
    }
    // 硬切换 005 收尾：meta 存在但 vault_keys 已空是异常态——
    // 不允许进入"locked / unlocked 但 0 key"的假状态。直接清理 meta
    // 并收敛到 uninitialized，让用户进入首启 welcome。
    let keys: Awaited<ReturnType<typeof vaultDb.listKeys>>;
    try {
      keys = await vaultDb.listKeys();
    } catch (err) {
      // meta 存在但读 keys 失败:这意味着"本地有系统数据,但当前代码
      // 不能可信使用它"——不能再伪装成首启,直接 fatal。
      reportFatalError({
        phase: "vault.bootstrap",
        scope: "vault-service",
        source: "app-bundle",
        message:
          "Failed to read vault keys from IndexedDB. The local runtime is no longer trusted.",
        stack: err instanceof Error ? err.stack : undefined,
        cause: err
      });
      return;
    }
    // 关键记录形状校验：每条 key 记录都满足当前代码前提才允许进入
    // locked。硬切换 002 收尾：canonical record 必须带 publicKeyHex + 加密
    // 材料 + 元数据；缺一不可。
    for (const k of keys) {
      const keyShapeError = validateKeyShape(k);
      if (keyShapeError) {
        reportFatalError({
          phase: "vault.bootstrap",
          scope: "vault-service",
          source: "app-bundle",
          message:
            `vault_keys record is corrupt: ${keyShapeError}. ` +
            "The local runtime is no longer trusted.",
          cause: { publicKeyHex: k.publicKeyHex, record: k }
        });
        return;
      }
    }
    if (keys.length === 0) {
      try {
        await vaultDb.deleteMeta();
      } catch (delErr) {
        // 删 meta 失败:这是 0-key 护栏的内部步骤,既不是"真"首启也不是
        // "数据损坏"——降级时 DB 里残留 meta,下次 bootstrap 会再走这
        // 条护栏。先把当前状态收敛到 uninitialized 即可,不再升级 fatal。
        console.error("vaultDb.deleteMeta during empty-bootstrap failed", delErr);
      }
      setStatus("uninitialized");
      return;
    }
    setStatus("locked");
  }

  bootstrap();

  function recordToRef(record: VaultKeyRecord): KeyRef {
    return {
      publicKeyHex: record.publicKeyHex,
      label: record.label,
      address: record.address || undefined,
      network: record.network,
      format: record.format,
      capabilities: record.capabilities,
      createdAt: record.createdAt,
      source: record.source
    };
  }

  async function recordToIdentity(record: VaultKeyRecord): Promise<KeyIdentity> {
    return {
      publicKeyHex: record.publicKeyHex,
      label: record.label,
      capabilities: record.capabilities,
      createdAt: record.createdAt
    };
  }

  async function refreshKeyCache() {
    const records = await vaultDb.listKeys();
    keyCache = records.map(recordToRef);
  }

  /**
   * 硬切换 002：从 importPrivateKey 抽出的统一私钥持久化内部函数。
   * 负责：trim 标签 / 校验长度 / 派生公钥身份 / 重复检查 / 加密私钥 /
   * 写入 vault_keys / 清 keyCache / 通知 keyspace 新 Key / 发布 key.created。
   *
   * 设计缘由：importPrivateKey 与 generateKey 的差异只在私钥材料来源；
   * 加密、身份、active 切换、事件语义必须完全一致——任何一处复制实现
   * 都会让"用户能安全生成新 Key"的承诺与"用户能导入私钥"的现有行为
   * 出现偏差。
   *
   * 硬切换 002 收尾：入参不再分配 uuid；canonical record 主键 =
   * `publicKeyHex`，必为派生结果；`crypto.randomUUID()` 不再被用作
   * key 域主键。
   */
  async function persistPrivateKey(input: {
    material: VaultKeyMaterial;
    label: string;
    format: string;
    capabilities: string[];
    source?: string;
    passwordKey: CryptoKey;
    encryptVaultKeyMaterial: (publicKeyHex: string, material: VaultKeyMaterial) => Promise<{
      cipherVersion: "v2";
      cipherSaltB64: string;
      cipherIvB64: string;
      cipherB64: string;
    }>;
  }): Promise<KeyRef> {
    // 1) 锁定守卫：locked 状态 fail closed，避免在外层调用方
    //    看不到错误就泄漏。
    // 2) 标签校验：trim / 非空 / 长度上限。空标签和超长标签在入口
    //    一律拒绝，错误信息使用英文。
    const label = input.label.trim();
    if (!label) throw new Error("Label is required");
    if (label.length > LABEL_MAX_LENGTH) {
      throw new Error(`Label must be at most ${LABEL_MAX_LENGTH} characters`);
    }
    // 3) 派生公钥身份并按 publicKeyHex 重复检查。
    const identity = deriveKeyIdentity(hexToBytes(input.material.hex));
    const existing = await vaultDb.getKey(identity.publicKeyHex);
    if (existing) {
      throw new Error("Key already exists");
    }
    // 4) 加密私钥材料。原始 hex/WIF 不会落盘，也不会出现在 KeyRef。
    const encrypted = await input.encryptVaultKeyMaterial(identity.publicKeyHex, input.material);
    // 硬切换 002 收尾：`address` / `network` 写空 + main 仅作兼容
    // 字段保留——它们不是 owner 真值、不是 key 根身份；新代码禁
    // 止依赖这两字段做身份 / 地址 / 资产判断。
    const record: VaultKeyRecord = {
      publicKeyHex: identity.publicKeyHex,
      label,
      address: "",
      network: "main",
      format: input.format,
      capabilities: input.capabilities,
      createdAt: new Date().toISOString(),
      source: input.source,
      ...encrypted
    };
    // 5) DB 写入必须发生在 notify / emit 之前——失败时 keyspace
    //    不会误把不存在的 key 选为 active，订阅者也不会收到
    //    "key.created" 但 DB 里没有的虚假事件。
    await vaultDb.putKey(record);
    const ref = recordToRef(record);
    keyCache = null;
    // 6) 先通知 keyspace（内部把新 key 注册为 active），再 emit key.created；
    //    订阅者看到的 active 已切好。
    //
    // 硬切换 002 收尾：如果 keyspace 通知失败，DB 已经有这把 key，但 active
    // 没切。抛 `KeyPersistedButActivationFailedError` 让 UI 进入"已保存但
    // 未 active"的成功/警告态，**不**发 "key.created"——否则订阅者从
    // 事件 handler 读 keyspace.active() 会看到与 payload publicKeyHex
    // 不一致的状态（payload 是新 key，active 是旧 key）。
    //
    // 硬切换 004 收尾：必须 await notifyKeyCreated。keyspace 内部会
    // 先 await quiesceNamespace(prev.active) 把旧 key 的后台任务停稳，
    // 然后才切 active；同步不 await 等于把旧 key 的 history-backfill
    // 留在内存里继续跑，新 active 的 namespace DB 一旦被业务插件打开，
    // 旧 task 仍可能撞 `database connection is closing`——和手动
    // setActive 的同类竞态。
    if (deps.keyspace) {
      try {
        await deps.keyspace.notifyKeyCreated(await recordToIdentity(record));
      } catch (notifyErr) {
        throw new KeyPersistedButActivationFailedError({
          key: ref,
          cause: notifyErr
        });
      }
    }
    // 7) 仅在 active 切换成功后才发 key.created。
    await createAndInstallSessionActiveCrypto(record, input.passwordKey);
    deps.messageBus.publish("key.created", {
      publicKeyHex: identity.publicKeyHex,
      label
    });
    deps.logger?.info({
      scope: "vault.key",
      event: "key.created",
      message: "Vault key created",
      data: { publicKeyHex: identity.publicKeyHex, label },
      keyScope: { publicKeyHex: identity.publicKeyHex }
    });
    return ref;
  }

  return {
    status() {
      return status;
    },
    onStatusChange(handler) {
      statusListeners.add(handler);
      return () => statusListeners.delete(handler);
    },
    getSessionState() {
      if (!vaultSession) return null;
      return {
        sessionId: vaultSession.sessionId,
        kind: vaultSession.kind,
        publicKeyHex: vaultSession.publicKeyHex,
        revoked: vaultSession.revoked
      };
    },

    /**
     * 读取"首 Key 已落库但未自动 active"notice。
     *
     * 返回的是当前快照；不会因读取而清除。清除必须显式调
     * `clearInitialActivationNotice()`，或在 `setActive` 把该 key 切为
     * active / `lock()` 时由 vault 内部清掉。
     */
    getInitialActivationNotice() {
      return pendingActivationNotice;
    },

    /** 显式清除 notice。 */
    clearInitialActivationNotice() {
      setPendingActivationNotice(null);
    },

    /** 订阅 notice 变化（设置 / 清除），用于 UI 实时刷新。 */
    onInitialActivationNoticeChange(handler) {
      noticeListeners.add(handler);
      // 立即把当前值喂给订阅方，避免新挂载时漏掉已存在的 notice。
      handler(pendingActivationNotice);
      return () => noticeListeners.delete(handler);
    },

    async hasVault() {
      return Boolean(await vaultDb.getMeta());
    },

    /**
     * 硬切换 008：createVault 同样需要 ready 边界。首次创建时 keyspace
     * 内部无 key（listActiveCandidates 为空 -> mode="all"）；但仍必须
     * 显式调用 onVaultUnlocked 让 keyspace 触发 setActiveInternal("all")
     * 并保持状态机一致，再 setStatus + emit。
     *
     * 失败回滚（硬切换 008 收尾）：
     *   - meta 已写入 DB
     *   - keyspace.onVaultUnlocked 抛错时，必须把 meta 也删掉，回退到
     *     "uninitialized" 状态。否则出现"内存说未初始化、存储里
     *     已有 Vault meta"的不一致——bootstrap 会把状态读到 locked
     *     而 UI 期望 uninitialized，导入 / 解锁链路都会错位。
     *   - in-memory 会话材料必须清空，与 uninitialized 状态匹配。
     */
    async createVault(password) {
      if (status !== "uninitialized") {
        throw new Error("Vault already exists");
      }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(password, salt);
      const verifier = await encryptVerifier(key);
      const meta = coordinatorBuildVaultMeta({ salt, verifier });
      await vaultDb.putMeta(meta);
      startVaultSession();
      try {
        // 与 unlock 一致：先把 keyspace 推到 ready 状态，再宣布 unlocked。
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
        await installCurrentSessionActiveCrypto(key);
      } catch (err) {
        // 设计缘由：createVault 失败时必须把 meta 也删掉，保证"状态 =
        // uninitialized"与"存储里没有 Vault"一致。删除 meta 失败时仍
        // 把状态回退、抛出原始错误——不掩盖 keyspace 错误的根因。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error("vaultDb.deleteMeta failed during createVault rollback", deleteErr);
        }
        clearVaultSession();
        setStatus("uninitialized");
        throw err;
      }
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: meta.createdAt });
    },

    /**
     * 硬切换 009：首启"新建钱包"高层能力。
     *
     * 内部顺序（**严格按此执行，不能调 this.createVault()**）：
     *   1) 校验 status === "uninitialized"（其余状态 fail closed）。
     *   2) 写 meta + 把派生 key/salt 放入内存（不调 setStatus）。
     *   3) 调 `deps.keyspace.onVaultUnlocked()` 让 keyspace 进入 ready 状态
     *      （与 unlock 的 ready 边界保持一致）。
     *   4) 调 `generateKey({ label, capabilities })`：复用私钥生成 /
     *      身份派生 / 加密落库 / active 切换 / `key.created` 事件。
     *   5) **只有 generateKey 成功后才** `setStatus("unlocked")` + emit
     *      `vault.unlocked`。这一步是修复硬切换 009 收尾的核心——
     *      App.tsx 会在看到 `unlocked` 时立刻切到 UnlockedShell，P2PKH
     *      service 也会在 `vault.unlocked` 事件后启动自己的解锁链路。
     *      提前宣布 unlocked 会让主界面在"首 Key 尚未落库"的中间态
     *      渲染，违反施工单"主界面应已带首 Key"的硬切换语义。
     *   6) 失败回滚：
     *        a) 步骤 2/3 失败（meta 写入 / keyspace ready）—— 与
     *           createVault 一致：删 meta、清空内存会话、抛原错，**不**
     *           宣布 unlocked，状态保持 uninitialized。
     *        b) generateKey 抛 `KeyPersistedButActivationFailedError` —
     *           首 Key 已落库但 active 没切上。**先**保存
     *           `InitialActivationNotice` 给 UI 在主界面展示，**再**
     *           `setStatus("unlocked")` 让用户能进入已解锁主界面手动
     *           切 active；抛 `KeyPersistedButActivationFailedError` 给
     *           调用方（shell 端不必再处理：unlocked 状态已发出，App
     *           会自动切到 UnlockedShell）。
     *        c) generateKey 抛其它错（首 Key 未落库）—— 删 meta、清空
     *           内存会话、状态回到 "uninitialized"、抛原错，**不**宣布
     *           unlocked。
     *
     * 设计缘由：
     *   - "新建钱包"必须与"创建空 Vault"语义解耦；本方法是面向 shell
     *     的唯一首启入口，导入私钥仍走 `createVault`。
     *   - 把事务边界收敛在 Vault 内部，shell 端不需要知道"失败时 meta
     *     要不要回滚"或"内存会话要不要清理"。
     *   - 不复用 `this.createVault()`，因为它的 setStatus("unlocked") +
     *     publish("vault.unlocked") 副作用会导致主界面在首 Key 落库前
     *     就被渲染。
     */
    async createVaultWithInitialKey(input) {
      if (status !== "uninitialized") {
        throw new Error("Vault already exists");
      }
      // 1) 准备 meta + 内存会话。**不**调 setStatus("unlocked")。
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(input.password, salt);
      const verifier = await encryptVerifier(key);
      const meta = coordinatorBuildVaultMeta({ salt, verifier });
      await vaultDb.putMeta(meta);
      startVaultSession();
      // 2) keyspace ready 边界（与 createVault / unlock 一致）。
      try {
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
        await installCurrentSessionActiveCrypto(key);
      } catch (err) {
        // keyspace ready 失败：与 createVault 同样的回滚——删 meta、
        // 清空内存会话、抛原错。状态保持 uninitialized（从未切到 unlocked）。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error(
            "vaultDb.deleteMeta failed during createVaultWithInitialKey rollback",
            deleteErr
          );
        }
        clearVaultSession();
        throw err;
      }
      // 3) 生成首 Key。复用 generateKey 走 persistPrivateKey 统一路径。
      const label = (input.label ?? defaultInitialKeyLabel()).trim();
      let firstKeyRef: KeyRef;
      try {
        firstKeyRef = await persistPrivateKey({
          material: { hex: generatePrivateKeyHex() },
          label,
          format: GENERATED_FORMAT,
          capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
          source: GENERATED_SOURCE,
          passwordKey: key,
          encryptVaultKeyMaterial: (publicKeyHex, material) =>
            coordinatorEncryptVaultKeyMaterial(key, publicKeyHex, material)
        });
      } catch (err) {
        if (err instanceof KeyPersistedButActivationFailedError) {
          // 已落库但未自动 active：保存 notice，让 UI 在已解锁主界面
          // 展示"首 Key 已保存，请手动切 active"。**仍**宣布 unlocked，
          // 让用户能进入主界面手动修复——首 Key 已经安全落库，回滚
          // 反而会隐藏真实状态。
          setPendingActivationNotice({
            publicKeyHex: err.key.publicKeyHex,
            label: err.key.label
          });
          setStatus("unlocked");
          deps.messageBus.publish("vault.unlocked", { at: new Date().toISOString() });
          throw err;
        }
        // 首 Key 未落库：DB 里只有刚建好的空 Vault，必须把它清掉，
        // 回到 uninitialized 状态，避免"已创建空 Vault 但没有 Key"
        // 的脏状态泄漏到下次 bootstrap。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error(
            "vaultDb.deleteMeta failed during createVaultWithInitialKey rollback",
            deleteErr
          );
        }
        clearVaultSession();
        setStatus("uninitialized");
        throw err;
      }
      // 4) 完整成功：宣布 unlocked + emit。这是"新建钱包"的真正完成点。
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: meta.createdAt });
      return firstKeyRef;
    },

    /**
     * 硬切换 010：首启"导入私钥"高层能力。
     *
     * 内部顺序（**严格按此执行，不能调 this.createVault()**）：
     *   1) 校验 status === "uninitialized"（其余状态 fail closed）。
     *   2) 写 meta + 把派生 key/salt 放入内存（不调 setStatus）。
     *   3) 调 `deps.keyspace.onVaultUnlocked()` 让 keyspace 进入 ready
     *      状态（与 unlock 的 ready 边界保持一致）。
     *   4) 调 `importPrivateKey({ label, material, format, capabilities,
     *      source })`：复用 `persistPrivateKey` 内部函数——身份派生 /
     *      查重 / 加密落库 / active 切换 / `key.created` 事件。
     *   5) **只有 importPrivateKey 成功后才** `setStatus("unlocked")` +
     *      emit `vault.unlocked`。这样 App.tsx 看到 unlocked 时这把导入
     *      key 已经落库，避免主界面在"首 Key 尚未落库"的中间态渲染。
     *   6) 失败回滚：
     *        a) 步骤 2/3 失败（meta 写入 / keyspace ready）—— 与
     *           createVault 一致：删 meta、清空内存会话、抛原错，**不**
     *           宣布 unlocked，状态保持 uninitialized。
     *        b) importPrivateKey 抛 `KeyPersistedButActivationFailedError`
     *           — 首 Key 已落库但 active 没切上。**先**保存
     *           `InitialActivationNotice` 给 UI 在主界面展示，**再**
     *           `setStatus("unlocked")` 让用户能进入已解锁主界面手动切
     *           active；抛 `KeyPersistedButActivationFailedError` 给调用
     *           方（shell 端不必再处理：unlocked 状态已发出，App 会自动
     *           切到 UnlockedShell）。
     *        c) importPrivateKey 抛其它错（首 Key 未落库；常见：label
     *           为空 / 长度超限 / 重复 publicKeyHex / DB 写入失败）——
     *           删 meta、清空内存会话、状态回到 "uninitialized"、抛原
     *           错，**不**宣布 unlocked。
     *
     * 设计缘由：
     *   - 首启"导入私钥"必须与"创建空 Vault"语义解耦；本方法是面向
     *     shell 的唯一首启入口，**不**再让"导入私钥"走 createVault()
     *     + 跳 `/import` 的旧路径——那会制造"有锁屏密码但 0 key"的空
     *     Vault 状态。
     *   - 把事务边界收敛在 Vault 内部，shell 端不需要知道"失败时 meta
     *     要不要回滚"或"内存会话要不要清理"。
     *   - 不复用 `this.createVault()`，因为它的 setStatus("unlocked") +
     *     publish("vault.unlocked") 副作用会导致主界面在首 Key 落库前
     *     就被渲染。
     *   - 本方法与 `createVaultWithInitialKey` 对称：两者都是
     *     "首启一次性建 Vault + 落首 Key + 切 active"；区别仅在
     *     "首 Key 是 Vault 内部生成"还是"由调用方解析外部材料后传入"。
     *   - 调用方语义：调用本方法前，**私钥材料必须已经解析成功**——
     *     解析失败不允许进入本方法。解析失败必须停在首启导入向导里，
     *     不写 vault_meta，状态保持 uninitialized。
     */
    async createVaultWithImportedKey(input) {
      if (status !== "uninitialized") {
        throw new Error("Vault already exists");
      }
      // 1) 准备 meta + 内存会话。**不**调 setStatus("unlocked")。
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(input.vaultPassword, salt);
      const verifier = await encryptVerifier(key);
      const meta = coordinatorBuildVaultMeta({ salt, verifier });
      await vaultDb.putMeta(meta);
      startVaultSession();
      // 2) keyspace ready 边界（与 createVault / unlock 一致）。
      try {
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
        await installCurrentSessionActiveCrypto(key);
      } catch (err) {
        // keyspace ready 失败：与 createVault 同样的回滚——删 meta、
        // 清空内存会话、抛原错。状态保持 uninitialized（从未切到 unlocked）。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error(
            "vaultDb.deleteMeta failed during createVaultWithImportedKey rollback",
            deleteErr
          );
        }
        clearVaultSession();
        throw err;
      }
      // 3) 持久化首把导入 Key。复用 importPrivateKey -> persistPrivateKey
      //    统一路径：身份派生 / 查重 / 加密落库 / active 切换 / 事件。
      let firstKeyRef: KeyRef;
      try {
        firstKeyRef = await persistPrivateKey({
          label: input.key.label,
          material: input.key.material,
          format: input.key.format,
          capabilities: input.key.capabilities,
          source: input.key.source,
          passwordKey: key,
          encryptVaultKeyMaterial: (publicKeyHex, material) =>
            coordinatorEncryptVaultKeyMaterial(key, publicKeyHex, material)
        });
      } catch (err) {
        if (err instanceof KeyPersistedButActivationFailedError) {
          // 已落库但未自动 active：保存 notice，让 UI 在已解锁主界面
          // 展示"首 Key 已保存，请手动切 active"。**仍**宣布 unlocked，
          // 让用户能进入主界面手动修复——首 Key 已经安全落库，回滚
          // 反而会隐藏真实状态。
          setPendingActivationNotice({
            publicKeyHex: err.key.publicKeyHex,
            label: err.key.label
          });
          setStatus("unlocked");
          deps.messageBus.publish("vault.unlocked", { at: new Date().toISOString() });
          throw err;
        }
        // 首 Key 未落库：DB 里只有刚建好的空 Vault，必须把它清掉，
        // 回到 uninitialized 状态，避免"已创建空 Vault 但没有 Key"
        // 的脏状态泄漏到下次 bootstrap。
        try {
          await vaultDb.deleteMeta();
        } catch (deleteErr) {
          console.error(
            "vaultDb.deleteMeta failed during createVaultWithImportedKey rollback",
            deleteErr
          );
        }
        clearVaultSession();
        setStatus("uninitialized");
        throw err;
      }
      // 4) 完整成功：宣布 unlocked + emit。这是"首启导入"的真正完成点。
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: meta.createdAt });
      return firstKeyRef;
    },

    /**
     * 硬切换 002：unlock 的完成边界。
     * 目标顺序（必须严格按此执行）：
     *   1) 校验 meta / password
     *   2) 派生会话 key / salt 并放入内存
     *   3) deps.keyspace.onVaultUnlocked()：选择 active key（single 模式）
     *   4) setStatus("unlocked") + emit "vault.unlocked"
     * 业务主界面（UnlockedShell / P2PKH widget）只在 status === "unlocked" 后
     * 渲染，keyspace 也已 ready，避免 widget 抢跑触发 "Key storage is not ready"。
     * 失败时必须清理会话 key / salt 并回退到 locked，避免 UI 仍停
     * 在 locked 但内存里有解锁态材料。
     *
     * 硬切换 005 收尾：unlock 收尾前再次校验 vault_keys 不为 0；空列表
     * 是异常态（meta 还在但 0 key），按"meta 残留"路径收敛到
     * uninitialized 而不是 unlocked——这是与 bootstrap 路径一致的护栏。
     */
    async unlock(password) {
      const meta = await vaultDb.getMeta();
      if (!meta) throw new Error("Vault not initialized");
      const { key, encoding, verifierVersion } = await coordinatorResolveVaultPasswordKey(password, meta);
      startVaultSession();
      try {
        await coordinatorMigrateVaultKeysToV2Aad({
          meta,
          records: await vaultDb.listKeys(),
          decryptRecord: (record) => coordinatorDecryptVaultKeyMaterialForMigration(key, record, encoding),
          encryptRecord: (publicKeyHex, material) =>
            coordinatorEncryptVaultKeyMaterial(key, publicKeyHex, material),
          putMeta: (nextMeta) => vaultDb.putMeta(nextMeta),
          putMetaAndKeys: (nextMeta, records) => vaultDb.putMetaAndKeys(nextMeta, records),
          forceReencrypt: encoding === "base64" || verifierVersion === "v1",
          sourceEncoding: encoding,
          sourceVerifierVersion: verifierVersion,
          replacementVerifier: verifierVersion === "v1" ? await encryptVerifier(key) : undefined
        });
        // 硬切换 005 收尾：unlock 收尾前若 vault_keys 已空，按"meta 残留"
        // 路径收敛到 uninitialized——直接清空内存会话、删 meta，不再走
        // keyspace.onVaultUnlocked / setStatus("unlocked")。
      const remaining = await vaultDb.listKeys();
      if (remaining.length === 0) {
          if (deps.keyspace) {
            try {
              await deps.keyspace.onVaultLocked();
            } catch (err) {
              console.error("keyspace.onVaultLocked during empty-unlock failed", err);
            }
          }
          try {
            await vaultDb.deleteMeta();
          } catch (delErr) {
            console.error("vaultDb.deleteMeta during empty-unlock failed", delErr);
          }
          clearVaultSession();
          keyCache = null;
          setStatus("uninitialized");
          return { status: "accepted" } satisfies CoordinatorCommandResult;
        }
        // 1) keyspace 选择 active key：必须发生在 setStatus/emit 之前，
        //    否则业务插件看到 unlocked 时 active 仍是初始化期状态。
        if (deps.keyspace) {
          await deps.keyspace.onVaultUnlocked();
        }
        await installCurrentSessionActiveCrypto(key);
      } catch (err) {
        // 设计缘由：ready 边界由状态机保证；keyspace.onVaultUnlocked 失败
        // 即抛到这里。**必须**先清空
        // in-memory 会话（session key / salt / keyCache），再
        // setStatus("locked")，避免 UI 看到 locked 但内存里仍持有
        // 已解锁私钥材料；这条 fail-closed 与注释保持一致。
        clearVaultSession();
        keyCache = null;
        setPendingActivationNotice(null);
        setStatus("locked");
        throw err;
      }
      // 3) 业务可见的 unlocked：必须放到 keyspace ready 之后。
      setStatus("unlocked");
      deps.messageBus.publish("vault.unlocked", { at: new Date().toISOString() });
      return { status: "accepted" } satisfies CoordinatorCommandResult;
    },

    async lock() {
      // 硬切换 004：lock 的顺序收紧——setStatus("locked") 之后，先
      // await keyspace.onVaultLocked()（平台级锁屏清理屏障：cancelByKey
      // + await 旧 task 退出 + 关闭 namespace DB handle），再 publish
      // `vault.locked`。
      //
      // 设计缘由：`vault.locked` 的语义被收紧为"平台级资源已停稳"——
      // 业务插件订阅者不再承担"我必须先 cancel 才安全"的职责。如果
      // keyspace.onVaultLocked 抛错，必须冒泡——禁止在这里 catch 后
      // 伪装成成功锁屏；调用方（AppShell）会把未发布的 vault.locked
      // 视作"锁屏尚未完成"。
      setStatus("locked");
      if (deps.keyspace) {
        await deps.keyspace.onVaultLocked();
      }
      deps.messageBus.publish("vault.locked", { at: new Date().toISOString() });
      return { status: "accepted" } satisfies CoordinatorCommandResult;
    },

    /**
     * 硬切换 6.5：修改锁屏密码。
     *
     * 事务边界：
     *   1) 先校验旧密码，失败则 fail closed，不改状态、不改数据；
     *   2) 旧密码正确后先 lock()，把当前会话和 session worker 全部销毁；
     *   3) 临时派生新密码密钥，重加密所有 canonical key；
     *   4) 单个 IndexedDB 原子事务更新 vault_meta + vault_keys；
     *   5) 成功后保持 locked，不自动重新解锁。
     */
    async changePassword(input: { oldPassword: string; newPassword: string }) {
      if (status !== "unlocked") {
        throw new Error("Vault must be unlocked");
      }
      const oldPassword = input.oldPassword;
      const newPassword = input.newPassword;
      if (!oldPassword) {
        throw new Error("Old password is required");
      }
      if (!newPassword) {
        throw new Error("New password is required");
      }
      if (newPassword.length < 8) {
        throw new Error("Password must be at least 8 characters");
      }
      const meta = await vaultDb.getMeta();
      if (!meta) {
        throw new Error("Vault not initialized");
      }
      const oldKey = await coordinatorVerifyVaultPasswordKey(oldPassword, meta);
      // 旧密码已确认正确，进入 maintenance：先锁定并收回当前 session。
      await this.lock();
      disposeAllAppViewSessions("vault password changed");
      const targetSalt = crypto.getRandomValues(new Uint8Array(16));
      const targetKey = await coordinatorDeriveVaultPasswordKey(newPassword, targetSalt);
      const targetVerifier = await encryptVerifier(targetKey);
      const records = await vaultDb.listKeys();
      const rotatedRecords: VaultKeyRecord[] = [];
      for (const record of records) {
        const material = await coordinatorDecryptVaultKeyMaterialForMigration(oldKey, record);
        const identity = deriveKeyIdentity(hexToBytes(material.hex));
        if (identity.publicKeyHex !== record.publicKeyHex) {
          throw new Error(
            `vault key ${record.publicKeyHex} failed identity verification during password rotation`
          );
        }
      const encrypted = await coordinatorEncryptVaultKeyMaterial(
        targetKey,
        record.publicKeyHex,
        material
      );
        rotatedRecords.push({
          ...record,
          ...encrypted
        });
      }
      const nextMeta = coordinatorBuildVaultMeta({
        salt: targetSalt,
        verifier: targetVerifier,
        createdAt: meta.createdAt,
        cryptoVersion: "v2"
      });
      await vaultDb.putMetaAndKeys(nextMeta, rotatedRecords);
      keyCache = null;
    },

    /**
     * 硬切换 005 收尾：已解锁壳层守卫调用——"0 key 异常态"恢复入口。
     *
     * 触发场景：AppShell 检测到 vault.status === "unlocked" 且
     * keyspace.active().activePublicKeyHex 缺失且 listKeys 为空。
     * 此时必须把状态收敛到 uninitialized（不是 locked），让用户进
     * 入首启 welcome 而不是撞上"已经看到主界面但永远没有 key"。
     *
     * 实现：复用 finalizeEmptyVaultAfterLastKeyDeletion 的同构清理
     * 流程——清空内存会话、触发 keyspace.onVaultLocked、删 meta、
     * 状态收敛到 uninitialized。但与"删完最后一把 key"不同的是
     * 本方法**不**在 finally 块里抛错——壳层守卫的目标是
     * "即使有残留也能从 uninitialized 入口继续"，与
     * finalizeEmptyVaultAfterLastKeyDeletion 严格"meta 必须删干净"
     * 的语义有差异。
     *
     * 设计缘由：bootstrap 路径里已经做了"meta 存在但 0 key 就清 meta"
     * 的护栏；本方法在 unlocked 状态补做一次同源护栏。两条路径都
     * 收敛到 uninitialized。
     */
    async recoverEmptyVaultToUninitialized() {
      // 1) 校验：仅在 unlocked + 0 key 时允许触发。其它状态抛错拒绝。
      if (status !== "unlocked") {
        throw new Error("recoverEmptyVaultToUninitialized requires unlocked state");
      }
      const remaining = await vaultDb.listKeys();
      if (remaining.length > 0) {
        throw new Error("recoverEmptyVaultToUninitialized requires zero keys");
      }
      // 2) 通知 keyspace 收尾。硬切换 004：await keyspace.onVaultLocked()
      // —— await 旧 task 退出 + 关闭 namespace DB。
      if (deps.keyspace) {
        try {
          await deps.keyspace.onVaultLocked();
        } catch (err) {
          console.error("keyspace.onVaultLocked during recover failed", err);
        }
      }
      disposeAllAppViewSessions("vault recovered to uninitialized");
      // 3) 清空内存会话。
      clearVaultSession();
      keyCache = null;
      setPendingActivationNotice(null);
      if (activeChangeUnsub) {
        activeChangeUnsub();
        activeChangeUnsub = null;
      }
      // 4) 删 meta，状态收敛到 uninitialized。
      try {
        await vaultDb.deleteMeta();
      } catch (delErr) {
        // meta 删除失败仍要把状态收敛：UI 至少能切回 welcome 让用户重试。
        console.error("vaultDb.deleteMeta during recover failed", delErr);
      }
      setStatus("uninitialized");
    },

    /**
     * 硬切换 001：vault service 自我清理。
     * 幂等：host teardown 多次调用安全。当前动作是清空内存中的 status listener
     * 与 active-change 订阅。
     */
  dispose() {
      revokeActiveKeyCryptoLeases(undefined, "dispose");
      disposeAllAppViewSessions("dispose");
      if (activeChangeUnsub) {
        activeChangeUnsub();
        activeChangeUnsub = null;
      }
      statusListeners.clear();
      noticeListeners.clear();
    },

    /**
     * 硬切换 002：仅校验锁屏密码，不改变 Vault 状态。
     *
     * 实现要点：
     *   1) 从 `vault_meta` 读 verifier。无 meta（uninitialized / booting）
     *      时直接抛 `Vault not initialized`——没有 verifier 可校验，
     *      fail closed。
     *   2) 用传入密码 + meta.salt 派生临时 key，仅用于比对 verifier；
     *      派生出的 key **不**写入常驻会话槽，调用结束就丢。
     *   3) `verifyVerifier` 失败抛 `Invalid password`，与 `unlock` 错误
     *      文案一致以便 UI 统一处理。
     *   4) **不**调用 setStatus、**不**修改会话材料 / `keyCache`、
     *      **不**触发 pre-v7 记录 AAD 升级、**不**发任何 messageBus 事件。
     *      keyspace.deleteKey 调用本方法后再走 prepareDeleteKey / 删
     *      namespace DB / 删私钥材料的主流程。
     */
    async verifyPassword(password) {
      const meta = await vaultDb.getMeta();
      if (!meta) throw new Error("Vault not initialized");
      await coordinatorVerifyVaultPasswordKey(password, meta);
      // 不动会话材料 / keyCache / status / cache
      // / 不 emit 任何事件。
    },

    /**
     * 硬切换 001 收口：Vault 统一执行 active key 切换。
     *
     * 设计缘由：
     *   - UI 先验密码、再单独调 keyspace.setActive 的旧流程有两条真值
     *     来源；这里把密码校验、目标 key 解密校验、keyspace 切换与旧
     *     capability 回收收敛到一个 Vault API。
     *   - 成功前不会破坏当前 active key；失败时仍保留旧 key 可用。
     */
    async activateKey(input: { publicKeyHex: string; password: string }) {
      if (status !== "unlocked") {
        throw new Error("Vault must be unlocked");
      }
      if (!input.publicKeyHex) {
        throw new Error("publicKeyHex is required");
      }
      if (!input.password) {
        throw new Error("Password is required");
      }
      const meta = await vaultDb.getMeta();
      if (!meta) {
        throw new Error("Vault not initialized");
      }
      const passwordKey = await coordinatorVerifyVaultPasswordKey(input.password, meta);
      const record = await vaultDb.getKey(input.publicKeyHex);
      if (!record) {
        throw new Error(`Unknown key ${input.publicKeyHex}`);
      }
      const material = await coordinatorDecryptVaultKeyMaterialForMigration(passwordKey, record);
      const identity = deriveKeyIdentity(hexToBytes(material.hex));
      if (identity.publicKeyHex !== record.publicKeyHex) {
        throw new Error(
          `vault key ${record.publicKeyHex} failed identity verification during active switch`
        );
      }
      const previousActive = deps.keyspace?.active().activePublicKeyHex;
      if (deps.keyspace) {
        if (!previousActive) {
          throw new Error("Vault is locked");
        }
        if (previousActive === input.publicKeyHex) {
          await createAndInstallSessionActiveCrypto(record, passwordKey);
          return { status: "accepted" } satisfies CoordinatorCommandResult;
        }
        await deps.keyspace.setActive(input.publicKeyHex);
      }
      await createAndInstallSessionActiveCrypto(record, passwordKey);
      revokeActiveKeyCryptoLeases(previousActive, "active key changed");
      return { status: "accepted" } satisfies CoordinatorCommandResult;
    },

    /**
     * 硬切换 002：删完最后一把 Key 后的"空 Vault 收尾"。
     *
     * 实现要点：
     *   1) **再次**确认 `vault_keys` 已空。这是 fail-closed 防御：
     *      keyspace 判断剩余 0 是基于自己的 listKeys，本方法直接查
     *      底层 vaultDb，避免任何中间层判断错误导致误删 meta。
     *      若仍有 key 抛 `Vault still has keys`，不动任何状态。
     *   2) 清理内存会话：会话材料 / `keyCache` 必须先置空，避免后续
     *      异步路径还能解密私钥。
     *   3) 触发会话结束清理：现有插件（如 p2pkh）依赖 `vault.locked`
     *      事件释放 namespace 资源；删空最后一把 key 时这条链路必须
     *      被走一次。这里先 emit `vault.locked` 再 setStatus，确保
     *      订阅者还能看到"会话结束"语义。`keyspace.onVaultLocked()`
     *      也被调用一次，释放打开的 namespace DB。
     *   4) 删除 `vault_meta`——下次 bootstrap 必须读到
     *      `uninitialized`，回到首启欢迎页。
     *   5) `setStatus("uninitialized")`，订阅者会重新挂载 LockedShell
     *      欢迎页。
     *
     * 失败处理：
     *   - 步骤 1 fail closed：抛 `Vault still has keys`，状态不变；
     *     这一步在清理内存之前抛错，所以 in-memory 会话和 status 都
     *     不会被动到，调用方拿到原始错误即可。
     *   - 步骤 2-4 任一失败：必须把 status 收敛到 `uninitialized`——
     *     原因：步骤 2 已经把会话材料 / `keyCache` 清空，
     *     步骤 3 已经发了 `vault.locked`；如果状态仍停在 `unlocked`，
     *     App 不会切回欢迎页，但后续任何受控 capability / sign 都会撞上
     *     `"Vault is locked"` 这种状态机错位错误。所以最终 setStatus
     *     必须在 `finally` 块中钉死，无论前面是否抛错。
     *     失败时 meta 可能仍在 DB 里（= 下次 bootstrap 读到 locked，
     *     与本次期望 uninitialized 不一致），错误文案必须明确说明
     *     `deleteMeta` 失败 + 状态已收敛 + 下次启动需诊断介入。
     */
    async finalizeEmptyVaultAfterLastKeyDeletion() {
      // 1) fail-closed：直接查底层 vaultDb 列表。listKeys 自身抛错时
      //    状态/内存都不动，原错沿错误栈冒泡。
      const remaining = await vaultDb.listKeys();
      if (remaining.length > 0) {
        throw new Error("Vault still has keys");
      }
      // 进入收尾流程后，无论后续步骤成功还是抛错，setStatus("uninitialized")
      // 都必须执行——避免 in-memory 已清空、status 仍 unlocked 的错位态。
      let finalizeError: unknown = null;
      try {
        // 2) 清理内存会话——必须在删 meta 之前，避免任何异步路径
        //    在 meta 已删但会话还在的情况下尝试 decryptMaterial。
        clearVaultSession();
        keyCache = null;
        setPendingActivationNotice(null);
        if (activeChangeUnsub) {
          activeChangeUnsub();
          activeChangeUnsub = null;
        }
        // 3) 触发会话结束清理：让依赖 vault.locked 的业务插件释放
        //    namespace 资源；keyspace 自己也走一次 onVaultLocked 把
        //    打开的 namespace DB 关掉、active 清回 all。
        //
        // 硬切换 004：await keyspace.onVaultLocked()——平台级清理屏障，
        // resolve 时表示后台任务已退出、namespace DB 已关；之后再
        // publish `vault.locked`，让"会话结束"语义保持
        // "平台资源已停稳"的收紧含义。
        //
        // 硬切换 004 收尾：禁止在 finalize 里 catch keyspace.onVaultLocked()
        // 的错误后继续往下走。cancelByKey / namespace 关失败意味着
        // "平台资源没停稳"——继续 publish vault.locked + 删 meta 会
        // 把"清理失败"伪装成"会话成功结束"，留下旧 task 仍可能继续
        // 跑的风险，与施工单"锁屏清理屏障失败必须可见"的语义冲突。
        // 让错误冒泡到外层 catch：status 仍收敛到 uninitialized（finally），
        // 但调用方通过抛错看到 finalize 失败。
        if (deps.keyspace) {
          await deps.keyspace.onVaultLocked();
        }
        try {
          deps.messageBus.publish("vault.locked", { at: new Date().toISOString() });
        } catch (err) {
          console.error("publish vault.locked failed during finalize", err);
        }
        disposeAllAppViewSessions("vault emptied");
        // 4) 删除 vault_meta。如果失败，错误将被外层 catch 捕获，
        //    finally 仍会把 status 收敛到 uninitialized。
        await vaultDb.deleteMeta();
      } catch (err) {
        // 收尾失败——记下原错，让 finally 块先做状态收敛，
        // 然后在 finally 之后把错包装成更明确的错误再抛给调用方。
        finalizeError = err;
      } finally {
        // 5) 状态收敛：必须放在 finally 中。如果不收这一步，App 会
        //    仍按 unlocked 处理，但 in-memory 已经清空，UI 后续会撞上
        //    "Vault is locked"——这种状态机错位比"meta 残留"更难诊断。
        //    收掉后 UI 至少能切回欢迎页、让用户重试创建 / 导入流程。
        setStatus("uninitialized");
      }
      if (finalizeError !== null) {
        // 重新包装：调用方需要明确知道 finalize 哪个阶段失败、状态已
        // 收敛到 uninitialized。错误可能来源：
        //   - keyspace.onVaultLocked() 抛错（cancelByKey / namespace 关失败）
        //   - publish vault.locked 抛错（业务订阅者异常，理论上不致命）
        //   - vaultDb.deleteMeta 抛错（meta 残留，下次 bootstrap 可能
        //     读到 locked）
        // 不区分阶段统一报"platform-level cleanup failed"——具体根因
        // 在 console.error / 调用方日志里能看到，UI 至少能切回欢迎页
        // 重新走流程。
        const reason =
          finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
        throw new Error(
          `Empty-vault finalize failed (platform-level cleanup incomplete; ` +
            `state collapsed to uninitialized; next bootstrap may re-read locked): ${reason}`
        );
      }
    },

    async listKeys() {
      if (keyCache) return keyCache;
      await refreshKeyCache();
      return keyCache ?? [];
    },

    async getKey(publicKeyHex) {
      const r = await vaultDb.getKey(publicKeyHex);
      return r ? recordToRef(r) : undefined;
    },

    async findByAddress(address) {
      const r = await vaultDb.getKeyByAddress(address);
      return r ? recordToRef(r) : undefined;
    },

    async importPrivateKey(input: {
      password: string;
      label: string;
      material: VaultKeyMaterial;
      format: string;
      capabilities: string[];
      source?: string;
    }) {
      const meta = await vaultDb.getMeta();
      if (!meta) {
        throw new Error("Vault not initialized");
      }
      const passwordKey = await coordinatorVerifyVaultPasswordKey(input.password, meta);
      return persistPrivateKey({
        material: input.material,
        label: input.label,
        format: input.format,
        capabilities: input.capabilities,
        source: input.source,
        passwordKey,
        encryptVaultKeyMaterial: (publicKeyHex, material) =>
          coordinatorEncryptVaultKeyMaterial(passwordKey, publicKeyHex, material)
      });
    },

    /**
     * 硬切换 002：Vault 内部安全生成新 Key。
     * 私钥由 noble secp256k1 `utils.randomPrivateKey()` 产生，仅在
     * 局部闭包内存在；身份派生、加密、active 切换、事件发布全部复用
     * `persistPrivateKey` 这条统一路径。
     */
    async generateKey(input: { password: string; label: string; capabilities?: string[] }) {
      const meta = await vaultDb.getMeta();
      if (!meta) {
        throw new Error("Vault not initialized");
      }
      const passwordKey = await coordinatorVerifyVaultPasswordKey(input.password, meta);
      // 1) 锁定 fail closed。放在调用 noble 之前，避免产生私钥材料
      //    之后才发现需要清场。
      if (!vaultSession) {
        throw new Error("Vault is locked");
      }
      // 2) 在 Vault 内部生成 secp256k1 私钥 hex。noble 内部走
      //    crypto.getRandomValues，安全随机源。
      const hex = generatePrivateKeyHex();
      // 3) 共用持久化路径：把 material 喂给 importPrivateKey 同一套
      //    加密 / 身份派生 / 事件流程。生成记录写死
      //    format="generated"、source="vault-generated"、capabilities
      //    默认为 ["p2pkh"]，方便审计与回归测试。
      return persistPrivateKey({
        material: { hex },
        label: input.label,
        format: GENERATED_FORMAT,
        capabilities: input.capabilities ?? DEFAULT_CAPABILITIES,
        source: GENERATED_SOURCE,
        passwordKey,
        encryptVaultKeyMaterial: (publicKeyHex, material) =>
          coordinatorEncryptVaultKeyMaterial(passwordKey, publicKeyHex, material)
      });
    },

    async removeKey(_publicKeyHex) {
      // 硬切换 008 + 硬切换 002：删除流程必须经过 keyspace.deleteKey。
      // 业务插件直接调本方法会绕过 background.cancelByKey 与 namespace DB
      // 清理，必须抛错拒绝。
      throw new Error("Use keyspace.deleteKey instead");
    },

    /**
     * 硬切换 008 + 硬切换 002：实际删除私钥材料，但**不发** key.deleted 事件。
     * key.deleted 由 keyspace.deleteKey 在 namespace DB 全部删除成功后
     * 统一发一次，确保全流程只发一次。
     */
    async deleteKeyMaterial(publicKeyHex) {
      revokeActiveKeyCryptoLeases(publicKeyHex, "key material deleted");
      for (const [sessionId, session] of Array.from(appViewSessions.entries())) {
        if (session.publicKeyHex === publicKeyHex) {
          disposeAppViewSession(sessionId, "appView owner key deleted");
        }
      }
      await vaultDb.deleteKey(publicKeyHex);
      keyCache = null;
    },

    async exportKeyBackup(publicKeyHex: string): Promise<string> {
      const { sourceVaultMeta, keyRecord } = await vaultDb.readKeyBackupRecord(publicKeyHex);
      return encodeKeyBackup({
        backupVersion: 1,
        sourceVaultMeta,
        keyRecord
      });
    },

    async importKeyBackup(input: {
      backup: string;
      sourcePassword: string;
      targetPassword: string;
    }): Promise<KeyRef> {
      const backup = decodeKeyBackup(input.backup);
      let source: Awaited<ReturnType<typeof coordinatorResolveVaultPasswordKey>>;
      try {
        source = await coordinatorResolveVaultPasswordKey(input.sourcePassword, backup.sourceVaultMeta);
      } catch {
        throw new Error("Invalid source password");
      }
      if (backup.keyRecord.cipherVersion !== "v2") {
        throw new Error("Key backup must be v2");
      }
      const material = await coordinatorDecryptVaultKeyMaterialForMigration(
        source.key,
        backup.keyRecord,
        source.encoding
      );
      const identity = deriveKeyIdentity(hexToBytes(material.hex));
      if (identity.publicKeyHex !== backup.keyRecord.publicKeyHex) {
        throw new Error("Key backup public key mismatch");
      }
      const targetMeta = await vaultDb.getMeta();
      if (!targetMeta) {
        throw new Error("Vault not initialized");
      }
      const targetKey = await coordinatorVerifyVaultPasswordKey(input.targetPassword, targetMeta);
      const existing = await vaultDb.getKey(identity.publicKeyHex);
      if (existing) {
        throw new Error("Key already exists");
      }
      const encrypted = await coordinatorEncryptVaultKeyMaterial(
        targetKey,
        identity.publicKeyHex,
        material
      );
      const record: VaultKeyRecord = {
        publicKeyHex: identity.publicKeyHex,
        label: backup.keyRecord.label,
        address: backup.keyRecord.address,
        network: backup.keyRecord.network,
        format: backup.keyRecord.format,
        capabilities: backup.keyRecord.capabilities,
        createdAt: backup.keyRecord.createdAt,
        source: backup.keyRecord.source,
        ...encrypted
      };
      await vaultDb.putKey(record);
      keyCache = null;
      return recordToRef(record);
    },

    async createAppViewSession(input: {
      sessionId: string;
      publicKeyHex: string;
      password: string;
    }) {
      if (status !== "unlocked") {
        throw new Error("Vault must be unlocked");
      }
      if (!input.sessionId) {
        throw new Error("sessionId is required");
      }
      if (!input.publicKeyHex) {
        throw new Error("publicKeyHex is required");
      }
      if (!input.password) {
        throw new Error("Password is required");
      }
      const meta = await vaultDb.getMeta();
      if (!meta) {
        throw new Error("Vault not initialized");
      }
      const passwordKey = await coordinatorVerifyVaultPasswordKey(input.password, meta);
      const record = await vaultDb.getKey(input.publicKeyHex);
      if (!record) {
        throw new Error(`Unknown key ${input.publicKeyHex}`);
      }
      const material = await coordinatorDecryptVaultKeyMaterialForMigration(passwordKey, record);
      const identity = deriveKeyIdentity(hexToBytes(material.hex));
      if (identity.publicKeyHex !== record.publicKeyHex) {
        throw new Error(
          `vault key ${record.publicKeyHex} failed identity verification during appView session export`
        );
      }
      disposeAppViewSession(input.sessionId, "appView session replaced");
      const engine = await createActiveCryptoForRecord(record, passwordKey, input.sessionId);
      const crypto = wrapActiveKeyCrypto(record, engine, () => {
        appViewSessions.delete(input.sessionId);
      });
      appViewSessions.set(input.sessionId, {
        publicKeyHex: record.publicKeyHex,
        crypto: engine
      });
      return crypto;
    },

    disposeAppViewSession(sessionId: string, reason?: string) {
      disposeAppViewSession(sessionId, reason);
    },

    disposeAllAppViewSessions(reason?: string) {
      disposeAllAppViewSessions(reason);
    },

    async createActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto> {
      const record = await vaultDb.getKey(publicKeyHex);
      if (!record) {
        throw new Error(`Unknown key ${publicKeyHex}`);
      }
      const activePublicKeyHex = deps.keyspace?.active().activePublicKeyHex;
      if (deps.keyspace) {
        if (!activePublicKeyHex) {
          throw new Error("Vault is locked");
        }
        if (activePublicKeyHex !== publicKeyHex) {
          throw new Error("session_key_mismatch");
        }
      }
      if (!vaultSession || !vaultSession.activeCrypto) {
        throw new Error("Vault is locked");
      }
      if (vaultSession.publicKeyHex !== publicKeyHex) {
        throw new Error("session_key_mismatch");
      }
      const engine = vaultSession.activeCrypto;
      let revoked = false;
      const lease = {
        publicKeyHex,
        revoke: (reason: string) => {
          revoked = true;
        }
      };
      activeKeyCryptoLeases.add(lease);
      const ensureLive = (): void => {
        if (revoked) {
          throw new ActiveKeySessionRevokedError();
        }
      };
      return {
        getIdentity() {
          ensureLive();
          return engine.getIdentity();
        },
        async signDigest(input) {
          ensureLive();
          return engine.signDigest(input);
        },
        async deriveP2pkhAddress(input) {
          if (input.publicKeyHex !== publicKeyHex) {
            throw new Error("session_key_mismatch");
          }
          return engine.deriveP2pkhAddress(input);
        },
        sealSendInput(input) {
          ensureLive();
          return engine.sealSendInput(input);
        },
        async openSealed(rec: ProviderSealedMessageRecord) {
          ensureLive();
          return engine.openSealed(rec);
        },
        async exportEncryptedKeyBackup(input) {
          ensureLive();
          if (input.publicKeyHex !== publicKeyHex) {
            throw new Error("session_key_mismatch");
          }
          const backup = encodeKeyBackup({
            backupVersion: 1,
            sourceVaultMeta: (await vaultDb.getMeta())!,
            keyRecord: record
          });
          return {
            publicKeyHex,
            backup: new TextEncoder().encode(backup).buffer
          };
        },
        dispose(reason = "dispose") {
          if (revoked) return;
          revoked = true;
          activeKeyCryptoLeases.delete(lease);
        }
      };
    },

  };
}
