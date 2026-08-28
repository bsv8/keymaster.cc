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
  /** 供应商声明的 MIME，只作提示，不能代替魔数和容器解析。 */
  declaredMediaType: string;
  /** 已由 plugin-msfile 绑定到金额和 transport 的 reader。 */
  reader: MsFileMediaBlockReader;
}

export interface MsFileVodSourceOptions {
  /** 同时驻留的已验证 Block 上限；用户设置范围为 2–64。 */
  prefetchBlocks?: number;
  /** 同时 active 的远端 Block Read 数；默认 2。 */
  parallelReads?: number;
  /** 媒体头部探测允许触及的最多 Block 数；默认 8。 */
  maxProbeBlocks?: number;
}

export interface MsFileVodSourceSnapshot {
  initialized: boolean;
  disposed: boolean;
  /** 当前缓存/在途 Block 数，不是已播放 Block 数。 */
  blockWindowOccupancy: number;
  blockWindowLimit: number;
  activeReadCount: number;
  readCount: number;
  verifiedBlockCount: number;
  fileSizeBytes?: bigint;
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
  /** 仅用于诊断显示，不能被误写成“已播放”。 */
  verifiedBlockCount: number;
  readBlockCount: number;
  error?: { code: string; message: string };
}

export interface MsFileMediaSession {
  snapshot(): MsFileMediaSnapshot;
  subscribe(listener: () => void): () => void;
  attach(element: MsFileMediaElementLike): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): Promise<void>;
  /** 更新当前 session 的 Block 窗口；调小时只等待旧占用自然释放。 */
  setPrefetchBlocks(value: number): void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export interface MediaInitialization {
  /** MSE/WebCodecs 使用的完整 MIME（含 codecs 参数）。 */
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
