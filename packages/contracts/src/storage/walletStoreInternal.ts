// Trusted Worker assembly contract; never published as a plugin capability.
/** 元数据仓库中的记录;不含字节。 */
export interface WalletObjectMeta {
  path: string;
  size: number;
  lastModified: string;
  /** 单调 revision;条件写与 batch CAS 都基于它。 */
  revision: number;
  contentType?: string;
}

export interface WalletObject extends WalletObjectMeta {
  bytes: Uint8Array;
}

/** 单次写入的条件。 */
export interface WalletWriteCondition {
  /** 仅当当前 revision 等于该值时替换。 */
  ifRevision?: number;
  /** 仅当目标不存在时创建。 */
  ifNoneMatch?: true;
}

export type WalletPutResult = WalletObjectMeta;

/** 一次原子提交中的单条操作。 */
export type WalletBatchOperation =
  | { type: "put"; path: string; bytes: Uint8Array; contentType?: string }
  | { type: "delete"; path: string };

export interface WalletBatchCondition {
  path: string;
  /** 缺失对象视为 revision 0。 */
  ifRevision?: number;
  ifNoneMatch?: true;
}

export interface WalletBatchInput {
  operations: WalletBatchOperation[];
  /** 全部条件同时成立才写入。 */
  conditions?: WalletBatchCondition[];
}

export interface WalletBatchResult {
  /** 本次事务涉及的路径,按操作顺序。 */
  paths: string[];
  /** 事务提交时间(ISO-8601)。 */
  committedAt: string;
}

export interface WalletStore {
  /** 只读冷启动:meta 记录。 */
  readMeta(): Promise<WalletObject | undefined>;
  /** 读取唯一 KeyHold 的原始字节。 */
  readKeyHold(): Promise<Uint8Array | undefined>;
  /** 读取一个对象;不存在返回 undefined。 */
  get(path: string, options?: { ifRevision?: number; signal?: AbortSignal }): Promise<WalletObject | undefined>;
  /** 按 revision 读取一段字节,供 Range/流式读取使用。 */
  getRange(path: string, range: { offset: number; length: number }, options?: { ifRevision?: number }): Promise<WalletObject | undefined>;
  /** 游标分页列举;只读元数据,永不返回字节。 */
  list(input?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{
    objects: WalletObjectMeta[];
    nextCursor?: string;
  }>;
  /** 写入单个对象,支持同事务内的条件创建与版本比较。 */
  put(path: string, bytes: Uint8Array, options?: WalletWriteCondition & { contentType?: string; signal?: AbortSignal }): Promise<WalletPutResult>;
  /** 删除单个对象;不存在视为成功。 */
  delete(path: string, options?: { ifRevision?: number; signal?: AbortSignal }): Promise<void>;
  /** 同一事务内批量提交;全部条件同时成立才写入。 */
  batch(input: WalletBatchInput, options?: { signal?: AbortSignal }): Promise<WalletBatchResult>;
  /** 原子清空新格式全部数据,并产生新的钱包身份世代。 */
  resetWallet(options?: { signal?: AbortSignal }): Promise<{ walletGeneration: string; clearedAt: string }>;
  /**
   * 浏览器持久化授权与配额。
   *
   * `navigator.storage` 只能由本引擎访问:上层要报告「数据是否已被浏览器
   * 持久化保护」,但不允许绕过存储层直接探测配额。
   */
  persistence(): Promise<{ persisted: boolean; usageBytes?: number; quotaBytes?: number }>;
  /** 关闭连接;后续请求 fail closed。 */
  close(): void;
}


/** Vault 冷启动前的私有端口；不授予列举、Range、删除或连接管理能力。 */
export type WalletVaultKeyStore = Pick<WalletStore, "get" | "put">;
/** 初始化必须保留单事务提交；该端口只由可信 Worker 装配发放。 */
export type WalletVaultLifecycleStore = Pick<WalletStore, "readMeta" | "batch" | "resetWallet">;
/** Vault 初始化记录固定路径，与 Coordinator 设置仓储隔离。 */
export const WALLET_INITIALIZATION_PATH = ".keymaster/system/wallet/initialization/current";
