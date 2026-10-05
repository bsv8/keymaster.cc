// packages/contracts/src/vault.ts
// Vault 契约：唯一钱包 Key 的存储 + 内存解密统一入口。
// 关键安全约束：明文私钥只允许在 Worker 内存中短暂存在。
//
// 单 Key 本地存储（docs/存储.md）后的根身份：
//   - 同一 Origin 只有一个钱包 Key，没有 Key 列表、没有选择、没有切换。
//   - KeyHold 固定存放在 `key.json`，解析后不跨出 Worker 边界。
//   - 句柄绑定钱包身份世代、会话 epoch 与 Worker 运行世代；锁定、改密、
//     重置和 Worker 重启都会让旧句柄与迟到结果失效。
//   - 钱包已有 Key 时，创建/导入入口不能覆盖它；更换身份必须先重置钱包。
//   - 短公钥属于 UI 显示格式，由 UI 调 `formatShortPublicKey(publicKeyHex)`
//     现算，不是 KeyRef 字段。
//   - `address` 与 `network` 只是兼容展示字段，不是身份真值；业务插件需要
//     地址时从 P2PKH resource 派生，网络由具体 plugin / resource 持有。

import { defineCapability, type LifecycleScope, type PluginConsumer } from "webloom-framework";
import type { ActiveKeyCrypto } from "./activeKeyCrypto.js";
import type { CoordinatorCommandResult } from "./sessionCoordinator.js";

export type BsvNetwork = "main" | "test";

/** 唯一钱包 Key 的公开元数据。
 *
 * `publicKeyHex` 是平台唯一身份根字段，ready 记录必填。它同时是 `key.json`
 * 里的声明值与公钥派生结果，两者必须一致。
 */
export interface KeyRef {
  /** 平台公开身份根字段：压缩公钥 hex；ready 记录必填。 */
  publicKeyHex: string;
  /** 人类可读标签。 */
  label: string;
  /** 私钥格式，例如 "generated"、"wif-mainnet"、"bsv8-key-envelope"。 */
  format: string;
  /** 私钥支持的能力列表，例如 ["p2pkh"]。 */
  capabilities: string[];
  /** 创建时间 ISO 字符串。 */
  createdAt: string;
  /** 导入来源，可选。 */
  source?: string;
  /**
   * 兼容字段：派生出来的 BSV 主网地址。**不是身份真值。** 业务插件需要地址
   * 时应从 P2PKH resource 按 `publicKeyHex + network` 派生。
   */
  address?: string;
  /**
   * 兼容字段：导入时推断的网络。**不是身份真值。** 网络由具体 plugin /
   * resource 持有。
   */
  network?: BsvNetwork;
}

/** Vault 服务的唯一 typed capability 身份。 */
export const VAULT_SERVICE_CAPABILITY = defineCapability<VaultService>({
  kind: "local",
  id: "vault.service",
  version: "1",
});

/** Vault 状态机。
 *
 * - `booting`：Coordinator 还没给出结论。
 * - `uninitialized`：本 Origin 还没有钱包 Key，只能创建或导入。
 * - `locked`：钱包已初始化，正常冷启动停在这里，等待 Key 密码。
 * - `unlocked`：唯一 Key 的解密材料已在 Worker 内存，会话可用。
 *
 * 业务插件只在 `unlocked` 之后才允许读写 key-scoped storage。
 */
export type VaultStatus = "booting" | "uninitialized" | "locked" | "unlocked";

export interface KeyIdentity {
  publicKeyHex: string;
  label: string;
  capabilities: string[];
  createdAt: string;
}

export interface VaultLifecycleSnapshot {
  /** 已解锁 Key 的公开元数据；与公钥同一提交点，锁定时省略。 */
  activeKeyIdentity?: KeyIdentity;
  status: VaultStatus;
  /** 唯一钱包 Key 的公钥；未初始化或锁定时省略。 */
  activePublicKeyHex?: string;
  /** 会话世代；每次解锁、锁定和 Worker 重启都变化。 */
  sessionEpoch: string;
  /**
   * Worker 运行世代。
   *
   * 纯本地钱包不再持有跨浏览器 Key 锁，但授权句柄必须绑定本次 Worker 运行：
   * 重启后所有旧 grant 失效，需要重新发放。
   */
  runGeneration: string;
  /** 生命周期快照修订号，页面用它丢弃乱序事件。 */
  vaultLifecycleRevision: number;
  /** 当前钱包身份世代；重置后变化，各 Tab 据此使旧授权失效。 */
  walletGeneration?: string;
}

/**
 * Versioned ciphertext envelope for plugin-owned local secrets.
 * The fields are intentionally opaque to consumers; plaintext never belongs
 * in the public Vault or protocol contracts.
 */
export interface VaultSealedSecret {
  /** 当前使用唯一 Key 私钥按用途 HKDF 派生的 v3 envelope。 */
  version: 3;
  /** 密文密钥来源版本；消费者不得自行替换为密码派生密钥。 */
  keySource: "active-key-hkdf-v1";
  saltHex: string;
  nonceHex: string;
  ciphertextHex: string;
}

/** 使用唯一 Key 私钥的按用途派生密钥封装插件本地秘密。 */
export interface VaultLocalSecretService {
  seal(scope: string, plaintext: Uint8Array): Promise<VaultSealedSecret>;
  open(scope: string, sealed: VaultSealedSecret): Promise<Uint8Array>;
}

/** Vault 服务：由 plugin-vault 实现并以 "vault.service" capability 暴露。
 *
 * 这是单 Key 产品的唯一钱包入口：没有 Key 列表、没有 `getKey`、没有
 * `deleteKey`、没有备份导入导出、没有 active 切换。替换身份只能走
 * Vault 内部重置 UI 之后的重新创建或导入。
 */
export interface VaultService {
  /** 当前状态。 */
  status(): VaultStatus;

  /**
   * 唯一钱包 Key 的公开信息；未初始化或尚未解密时返回 undefined。
   *
   * 不存在 `listKeys` / `getKey`：系统里只有一把 Key，调用方按
   * 只读钱包状态能力 或本方法取公开信息即可。
   */
  getCurrentKey(): Promise<KeyRef | undefined>;

  /** 本 Origin 是否已有钱包 Key（无论锁定与否）。 */
  hasVault(): Promise<boolean>;

  /** 用 Key 密码解锁唯一 Key。 */
  unlock(password: string): Promise<CoordinatorCommandResult>;
  /** 锁定，丢弃内存中的明文并撤销所有授权。 */
  lock(): Promise<CoordinatorCommandResult>;
  /**
   * 校验 Key 密码，不改变 Vault 状态。
   *
   * 需要密码的流程（appView 会话、改密确认）统一走这里；业务插件不复制
   * 一套密码校验逻辑。未初始化状态必须 fail closed。
   */
  verifyPassword(password: string): Promise<void>;

  /** 硬切换 001：宿主 teardown 时调用。幂等：可重复调用；可容忍部分资源已清。 */
  dispose?(): void;

  /**
   * 返回受控 active key capability。调用方不能拿到 raw private key。
   */
  createActiveKeyCrypto(publicKeyHex: string): Promise<ActiveKeyCrypto>;
  /**
   * 为独立 appView session 创建专属 worker capability。
   * appView 不能复用 Keymaster 当前 session capability。
   */
  createAppViewSession(input: {
    sessionId: string;
    publicKeyHex: string;
    password: string;
  }): Promise<ActiveKeyCrypto>;
  /** 销毁单个 appView session。 */
  disposeAppViewSession(sessionId: string, reason?: string): void;
  /** 销毁全部 appView session。 */
  disposeAllAppViewSessions(reason?: string): void;
}


/** 只读已提交的钱包状态，不授予签名或存储权限。 */
export interface VaultWalletState {
  snapshot(): Readonly<VaultLifecycleSnapshot>;
  /** 同步交付基线；之后交付变化。退订幂等且撤权后仍可调用。 */
  subscribe(handler: (snapshot: Readonly<VaultLifecycleSnapshot>) => void): () => void;
}
export interface VaultWalletStateAccess {
  bind(consumer: PluginConsumer, scope: LifecycleScope): VaultWalletState;
}
export const VAULT_WALLET_STATE_CAPABILITY = defineCapability<VaultWalletStateAccess>({ kind: "local", id: "vault.wallet-state", version: "1" });

/** 身份读取不是授权；操作还必须使用 Vault/Storage 发放的句柄。 */
export function requireUnlockedWalletIdentity(snapshot: Readonly<VaultLifecycleSnapshot>): KeyIdentity {
  if (snapshot.status !== "unlocked" || !snapshot.activePublicKeyHex) throw new Error("Active key is unavailable");
  const identity = snapshot.activeKeyIdentity;
  return identity ? { ...identity, capabilities: [...identity.capabilities] }
    : { publicKeyHex: snapshot.activePublicKeyHex, label: "", capabilities: [], createdAt: "" };
}
/** 同一公钥再次解锁、Worker 重启、钱包重置都属于不同会话。 */
export function sameWalletSession(a: Readonly<VaultLifecycleSnapshot>, b: Readonly<VaultLifecycleSnapshot>): boolean {
  return a.status === b.status && a.activePublicKeyHex === b.activePublicKeyHex
    && a.sessionEpoch === b.sessionEpoch && a.runGeneration === b.runGeneration && a.walletGeneration === b.walletGeneration;
}
