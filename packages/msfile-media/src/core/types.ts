// @keymaster/msfile-media 的无 UI、无网络实现契约。
// 所有字段带中文语义，调用方不需要根据英文名称猜测生命周期含义。

export type MediaSourceMode = "vod" | "live";

export type MsFileMediaPhase =
  | "idle"
  | "reading-seed"
  | "parsing-header"
  | "buffering"
  | "playing"
  | "paused"
  | "ended"
  | "failed"
  | "cancelled"
  | "stopped"
  | "disposed";

/** 可被浏览器播放器绑定的最小媒体元素能力；Core 不依赖 DOM。 */
export interface MsFileMediaElementLike {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
}

/** MSFile 数据面的最小读取器，不接收金额、grant、session 或 App 身份。 */
export interface MsFileMediaBlockReader {
  /** 读取并返回完整、已验证的 Seed attachment。 */
  readSeed(input: { signal: AbortSignal }): Promise<Uint8Array>;
  /** 按已知 Hash 读取一个完整、已验证的 256 KiB Block。 */
  readBlock(input: { blockHashHex: string; signal: AbortSignal }): Promise<Uint8Array>;
}

export interface MsFileVodSourceInput {
  /** Seed 的 32 字节小写 hex Hash。 */
  seedHashHex: string;
  /** 本次 session 固定使用的供应商压缩公钥。 */
  supplierPublicKeyHex: string;
  /** Stat 返回的精确文件字节数。 */
  fileSizeBytes: bigint;
  /** 供应商声明的 MIME；仅白名单类型进入原生播放，容器/Codec 由浏览器解析。 */
  declaredMediaType: string;
  /** 已由 plugin-msfile 绑定到金额和 transport 的 reader。 */
  reader: MsFileMediaBlockReader;
}

/** 旧 MSE 后端的兼容选项；当前原生 Range 路径不读取。 */
export interface MsFileVodSourceOptions {
  prefetchBlocks?: number;
  parallelReads?: number;
  maxProbeBlocks?: number;
}

/** 旧 BlockSource 的兼容快照；当前 RangeSource 使用自己的快照。 */
export interface MsFileVodSourceSnapshot {
  initialized: boolean;
  disposed: boolean;
  blockWindowOccupancy: number;
  blockWindowLimit: number;
  activeReadCount: number;
  readCount: number;
  verifiedBlockCount: number;
  fileSizeBytes?: bigint;
}

/** Debug 记录中的安全标量；禁止放入媒体字节、Hash、凭据或付款原文。 */
export type MsFileMediaDebugValue = string | number | boolean | null;

/** 默认开启的播放器内存诊断记录；保留 session 上下文/失败事件和最近一段有界事件。 */
export interface MsFileMediaDebugEntry {
  /** 当前 session 内单调递增的事件序号。 */
  sequence: number;
  /** 相对 session 创建时刻的毫秒数，便于判断卡顿发生在哪一步。 */
  elapsedMs: number;
  /** 事件来源，例如 session、sw、range、media.native。 */
  scope: string;
  /** 稳定动作名；用于搜索和比较两次复现。 */
  action: string;
  /** 已脱敏的动作状态，不包含媒体内容及身份/付款数据。 */
  details: Readonly<Record<string, MsFileMediaDebugValue>>;
}

export interface MsFileMediaSnapshot {
  /** 当前播放器状态；UI 应显示该状态而不是自行推断。 */
  phase: MsFileMediaPhase;
  mode: MediaSourceMode;
  /** 已确认的容器名称，例如 mp3、wave、mp4、webm、matroska。 */
  container?: string;
  /** 已确认的 Codec 参数字符串。 */
  codecs: readonly string[];
  durationSeconds?: number;
  currentTimeSeconds: number;
  /** 当前播放位置之后已可播放的秒数。 */
  bufferedSeconds: number;
  /** 原始 MSFile Block 的驻留/在途数量。 */
  blockWindowOccupancy: number;
  blockWindowLimit: number;
  /** 原生 Range 当前活动的 HTTP 请求数。 */
  activeRequestCount?: number;
  /** 原生 Range 当前正在共享的 Block Promise 数。 */
  inFlightBlockCount?: number;
  /** 仅用于诊断显示，不能被误写成“已播放”。 */
  verifiedBlockCount: number;
  readBlockCount: number;
  error?: { code: string; message: string };
  /** 默认开启、容量有界的诊断轨迹；UI 可直接展示并复制。 */
  debug: {
    enabled: boolean;
    entries: readonly MsFileMediaDebugEntry[];
  };
}

export interface MsFileMediaSession {
  snapshot(): MsFileMediaSnapshot;
  subscribe(listener: () => void): () => void;
  attach(element: MsFileMediaElementLike): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  /** 旧 MSE 后端兼容入口；新原生 Range session 不使用。 */
  setPrefetchBlocks?(value: number): void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface MediaInitialization {
  /** 扩展时间轴适配器使用的完整 MIME（含 codecs 参数）。 */
  mimeType: string;
  /** 初始化段；不是完整媒体文件。 */
  data?: Uint8Array;
  durationSeconds?: number;
}

export interface MediaSegment {
  /** 单调递增的 segment 序号。 */
  sequence: number;
  /** 时间轴起点，单位秒。 */
  timestampSeconds: number;
  /** segment 播放时长，单位秒。 */
  durationSeconds: number;
  /** 已验证且只属于本 segment 的编码媒体字节。 */
  data: Uint8Array;
  /** 是否可作为 seek 后的安全起点。 */
  keyframe?: boolean;
  /** 时间轴发生跳变，播放器需清理旧窗口。 */
  discontinuity?: boolean;
}

/** VOD/Live 共用的未来流接口；Core 状态机不依赖固定 EOF。 */
export interface MediaTimelineSource {
  readonly mode: MediaSourceMode;
  initialization(signal: AbortSignal): Promise<MediaInitialization>;
  segments(signal: AbortSignal): AsyncIterable<MediaSegment>;
  seek?(seconds: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
