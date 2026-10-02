// 只读存储浏览契约。
//
// 访问链路固定为：存储浏览页面 → 平台专属只读代理 → Coordinator → WalletStore。
// 浏览能力是一条独立的平台能力，不借用也不扩大 Connect App grant：普通插件与
// 第三方 App 永远拿不到根浏览权限，命名空间栅栏与模块文件接口继续有效。
//
// 页面只接收用于展示的逻辑路径、字节大小、版本和预览内容；数据库连接、底层
// 仓库、完整对象键和任何存储句柄都不进入 wire。
import { defineCapability } from "webloom-framework";
import type { SessionEpoch } from "../sessionCoordinator.js";

/** 浏览对象元数据一页的默认上限；与 WalletStore 元数据分页一致。 */
export const STORAGE_BROWSE_DEFAULT_LIMIT = 200;
/** 浏览对象元数据一页的硬上限；不得超过 WalletStore 底层上限。 */
export const STORAGE_BROWSE_MAX_LIMIT = 1000;
/** 单次预览最多返回的原始字节数；由 Worker 强制，页面不可绕过。 */
export const STORAGE_BROWSE_PREVIEW_MAX_BYTES = 1024 * 1024;
/** 浏览游标的存活时间；游标是运行态句柄，不持久化。 */
export const STORAGE_BROWSE_CURSOR_TTL_MS = 10 * 60 * 1000;
/** 单个浏览会话最多同时保留的游标数。 */
export const STORAGE_BROWSE_MAX_CURSORS_PER_SESSION = 64;
/** Worker 内同时进行的大对象预览读取上限。 */
export const STORAGE_BROWSE_PREVIEW_CONCURRENCY = 2;

/** 浏览判定的预览格式。 */
export type StoragePreviewFormat =
  /** 完整 JSON；可格式化与折叠。 */
  | "json"
  /** 损坏 JSON：只提供原文与解析失败提示。 */
  | "json-broken"
  /** Markdown：默认渲染，可切换源码。 */
  | "markdown"
  /** 已确认的纯文本：等宽显示，可切换自动换行。 */
  | "text"
  /** 零字节。 */
  | "empty"
  /** K-V value 对象，且信封、版本与载荷哈希均已通过校验。 */
  | "kv-value"
  /** K-V value 对象，但信封损坏、哈希不符或版本不支持。 */
  | "kv-invalid"
  /** 二进制或无法判断的格式；只提供原文，不做结构化呈现。 */
  | "binary"
  /** 因超出预览上限而只返回了截取内容。 */
  | "truncated";

/** 单个对象的只读元数据；永远不含字节。 */
export interface StorageBrowseEntry {
  /** 完整逻辑路径，例如 `contacts/address-book/<公钥>.json`。 */
  path: string;
  /** 字节数。 */
  size: number;
  /** 最近修改时间，ISO-8601。 */
  lastModified: string;
  /** 抽象版本标签；预览以此作条件读取。 */
  revision: string;
  /** 写入时声明的内容类型；没有声明时省略。 */
  contentType?: string;
}

/** 某一目录前缀内的一页对象元数据。 */
export interface StorageBrowsePage {
  /** 本页实际返回的对象数。 */
  entries: StorageBrowseEntry[];
  /** 下一页游标；本页折叠后可能没有新增子项，但仍可继续加载。 */
  nextCursor?: string;
}

/** 已打开的浏览会话句柄。 */
export interface StorageBrowseSession {
  /** 不透明会话 id；只能回传给同一页面端口使用。 */
  browseSessionId: string;
  /** 发放时的钱包身份世代；重置后旧句柄永久失效。 */
  walletGeneration: string;
  /** 发放时的会话世代；锁定或改密后失效。 */
  sessionEpoch: SessionEpoch;
  /** 发放时的 Worker 运行世代；Worker 重启后失效。 */
  runGeneration: string;
}

/**
 * 打开浏览会话的请求；不含任何调用方自报的身份。
 *
 * 请求体是空的，这是刻意的：会话归属哪个运行单元只能由 Coordinator 从它已验证的
 * 端口/peer 上下文判定。任何「调用方声明自己是谁」的字段都只是可以填对的字符串，
 * 因此 wire 上不存在这种字段。
 */
export type StorageBrowseOpenRequest = Record<string, never>;

/** 列举一页对象元数据的请求。 */
export interface StorageBrowseListRequest {
  /** 目录前缀；空串表示逻辑根。显示用 `/` 在 RPC 中表示为空串。 */
  prefix: string;
  /** 上一页返回的游标；首页省略。 */
  cursor?: string;
  /** 页大小；Worker 校验并夹到硬上限。 */
  limit?: number;
}

/** 请求文件预览的输入。 */
export interface StorageBrowsePreviewRequest {
  /** 完整逻辑路径；必须是真实存在的对象，不接受目录。 */
  path: string;
  /** 期望版本；列表里记录的版本。与当前版本不一致即返回版本冲突。 */
  ifRevision?: string;
}

/** K-V value 对象的解码结果；原始信封字节仍可切换查看。 */
export interface StorageBrowseKvPayload {
  /** valueId；来自已校验的信封头。 */
  valueId: string;
  /** partition；来自已校验的信封头。 */
  partition: string;
  /** 载荷语义身份；JSON 载荷与二进制载荷分别用前缀区分。 */
  payloadFingerprint: string;
  /** true 表示载荷是 JSON，可按 JSON 预览。 */
  json: boolean;
  /** JSON 载荷的文本；非 JSON 载荷省略。 */
  jsonText?: string;
}

/** 文件预览结果；字节最多为 {@link STORAGE_BROWSE_PREVIEW_MAX_BYTES}。 */
export interface StorageBrowsePreview {
  /** 完整逻辑路径。 */
  path: string;
  /** 判定出的预览格式。 */
  format: StoragePreviewFormat;
  /** 预览字节；始终是独立副本，可安全 transfer。 */
  bytes: Uint8Array;
  /** 对象的完整大小，与 bytes.length 无关。 */
  totalSize: number;
  /** 本次实际返回的字节数。 */
  returnedSize: number;
  /** true 表示内容因上限被截断，不得执行结构化解析或渲染。 */
  truncated: boolean;
  /** 实际读取到的版本；与请求的 ifRevision 不同时表示已变化。 */
  revision: string;
  /** 最近修改时间，ISO-8601。 */
  lastModified: string;
  /** 写入时声明的内容类型。 */
  contentType?: string;
  /** K-V 解码结果；仅 format 为 kv-value 时出现。 */
  kvPayload?: StorageBrowseKvPayload;
  /** K-V 信封被拒的原因代码；仅 format 为 kv-invalid 时出现。 */
  kvError?: "envelope-invalid" | "version-unsupported" | "hash-mismatch" | "payload-unsupported";
}

/** 平台只读浏览能力。 */
export interface StorageBrowseService {
  /** 打开一个绑定当前三种世代的临时浏览句柄。 */
  openSession(request: StorageBrowseOpenRequest): Promise<StorageBrowseSession>;
  /**
   * 列举一页对象元数据；只读元数据，不返回字节。
   *
   * 请求里没有浏览句柄：调用方拿到的是页面侧已经绑定好句柄的服务，句柄由实现
   * 自己管理并随世代失效重建。句柄只出现在 Coordinator RPC 层（见
   * {@link CoordinatorStorageBrowseData}），因此页面永远拿不到它。
   */
  list(request: StorageBrowseListRequest, options?: { signal?: AbortSignal }): Promise<StorageBrowsePage>;
  /** 请求文件预览；Worker 强制字节上限与版本条件。 */
  preview(request: StorageBrowsePreviewRequest, options?: { signal?: AbortSignal }): Promise<StorageBrowsePreview>;
  /** 关闭浏览会话并释放它的全部游标与在途请求。 */
  closeSession(browseSessionId: string): Promise<void>;
}

/**
 * 浏览服务用到的钱包只读面。
 *
 * 它只有元数据列举和单对象读取两个方法，没有任何写入；这是「浏览动作不得写入
 * 钱包」在类型上的保证，而不是靠调用方自觉。
 */
export interface StorageBrowseWallet {
  /** 游标分页列举；只读元数据，永不返回字节。 */
  list(input?: { prefix?: string; cursor?: string; limit?: number; signal?: AbortSignal }): Promise<{
    objects: Array<{ path: string; size: number; lastModified: string; revision: number; contentType?: string }>;
    nextCursor?: string;
  }>;
  /** 读取一个对象；不存在返回 undefined。 */
  get(path: string, options?: { signal?: AbortSignal }): Promise<{
    path: string;
    size: number;
    lastModified: string;
    revision: number;
    contentType?: string;
    bytes: Uint8Array;
  } | undefined>;
}

/** 存储浏览能力标识；只发给受信任的平台运行单元。 */
export const STORAGE_BROWSE_SERVICE_CAPABILITY = defineCapability<StorageBrowseService>({
  kind: "local",
  id: "storage.browse-service",
  version: "1",
});
