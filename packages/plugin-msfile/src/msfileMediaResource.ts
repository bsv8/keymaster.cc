// 播放器 session 的 Resource Store 适配。
// React 不直接订阅 session；Resource Store 负责失效、重渲染和 active-key
// 生命周期，session 本身仍只保存在内存中，不进入 DB 或 Coordinator 事件。

import type { MsFileService } from "@keymaster/contracts";
import type { ResourceRegistry } from "@keymaster/contracts";
import {
  createMsFileNativeMediaSession,
  type MsFileMediaSession,
  type MsFileMediaSnapshot,
} from "@keymaster/msfile-media/browser";
import { extractMsFileReadBytes } from "./fileAssembly.js";

export const MSFILE_MEDIA_RESOURCE_ID = "msfile.media.session";

export interface MsFileMediaResourceInput {
  /** 每次首页获取任务的内存 token；不把媒体字节放进 Resource Store。 */
  taskToken: string;
  seedHashHex: string;
  supplierPublicKeyHex: string;
  fileSizeBytes: bigint;
  declaredMediaType: string;
  /** 创建媒体 Session 时固定的并发快照；设置刷新不会重建既有 Session。 */
  mediaBlockReadConcurrency: number;
  globalSeedReadConcurrency: number;
  globalBlockReadConcurrency: number;
  globalStatConcurrency: number;
}

let configuredService: MsFileService | undefined;
interface MediaSessionEntry {
  version: number;
  session: MsFileMediaSession;
}

interface MediaSourceEntry {
  version: number;
  input: MsFileMediaResourceInput;
}

// Resource Store 只拿到 task token + 不透明版本号；Seed Hash、公钥和文件元数据
// 只保留在本页内存的 sourceInputs，避免把读取身份放进资源 key/快照。
const sourceInputs = new Map<string, MediaSourceEntry>();
const sessions = new Map<string, MediaSessionEntry>();
const disposalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionFor(args: readonly string[]): MsFileMediaSession {
  const token = args[0];
  if (!token || !configuredService) throw new Error("MSFile media resource is not configured");
  const version = args[1];
  const sourceEntry = sourceInputs.get(token);
  if (!sourceEntry || String(sourceEntry.version) !== version) throw new Error("MSFile media resource source is unavailable");
  const pendingDisposal = disposalTimers.get(token);
  if (pendingDisposal !== undefined) {
    clearTimeout(pendingDisposal);
    disposalTimers.delete(token);
  }
  const existing = sessions.get(token);
  if (existing?.version === sourceEntry.version) return existing.session;
  if (existing) {
    sessions.delete(token);
    void existing.session.dispose();
  }
  const { input } = sourceEntry;
  const {
    seedHashHex,
    supplierPublicKeyHex,
    fileSizeBytes,
    declaredMediaType,
    mediaBlockReadConcurrency,
    globalSeedReadConcurrency,
    globalBlockReadConcurrency,
    globalStatConcurrency,
  } = input;
  const service = configuredService;
  const session = createMsFileNativeMediaSession({
    seedHashHex,
    supplierPublicKeyHex,
    fileSizeBytes,
    declaredMediaType,
    reader: {
      readSeed: async ({ signal }) => extractMsFileReadBytes(await service.readSeed({ supplierPublicKeyHex, seedHashHex, signal }), seedHashHex),
      readBlock: async ({ blockHashHex, signal }) => extractMsFileReadBytes(await service.readBlock({ supplierPublicKeyHex, blockHashHex, signal }), blockHashHex),
    },
  }, {
    mediaBlockReadConcurrency,
    globalSeedReadConcurrency,
    globalBlockReadConcurrency,
    globalStatConcurrency,
  });
  sessions.set(token, { version: sourceEntry.version, session });
  return session;
}

export function msFileMediaResourceArgs(input: MsFileMediaResourceInput): readonly string[] {
  const previous = sourceInputs.get(input.taskToken);
  const sameSource = previous && previous.input.seedHashHex === input.seedHashHex &&
    previous.input.supplierPublicKeyHex === input.supplierPublicKeyHex &&
    previous.input.fileSizeBytes === input.fileSizeBytes &&
    previous.input.declaredMediaType === input.declaredMediaType;
  const version = sameSource ? previous.version : (previous?.version ?? 0) + 1;
  // 同一活动 Session 仍复用旧实例；但把最新配置保留在 sourceInputs，确保
  // 该 Session 之后被释放、再次创建时采用最新设置，而不是第一次渲染的快照。
  sourceInputs.set(input.taskToken, { version, input: { ...input } });
  return [input.taskToken, String(version)];
}

export function getMsFileMediaSession(taskToken: string): MsFileMediaSession | undefined {
  return sessions.get(taskToken)?.session;
}

/**
 * 首页任务结束时主动释放。保留一个很短的 grace period，兼容 React
 * StrictMode 的同步重挂载；过期后从 registry map 移除，避免每次查询永久
 * 留下一个已 disposed session。
 */
export function disposeMsFileMediaSession(taskToken: string, expectedSession?: MsFileMediaSession): void {
  const entry = sessions.get(taskToken);
  if (!entry || expectedSession && entry.session !== expectedSession || disposalTimers.has(taskToken)) return;
  const session = entry.session;
  const timer = setTimeout(() => {
    disposalTimers.delete(taskToken);
    if (sessions.get(taskToken)?.session !== session) return;
    sessions.delete(taskToken);
    sourceInputs.delete(taskToken);
    void session.dispose();
  }, 100);
  disposalTimers.set(taskToken, timer);
}

/** 用户显式取消或任务栅栏失效时立即撤销，不等待 React StrictMode grace。 */
export function disposeMsFileMediaSessionNow(taskToken: string, expectedSession?: MsFileMediaSession): void {
  const entry = sessions.get(taskToken);
  if (!entry || expectedSession && entry.session !== expectedSession) return;
  const timer = disposalTimers.get(taskToken);
  if (timer !== undefined) clearTimeout(timer);
  disposalTimers.delete(taskToken);
  sessions.delete(taskToken);
  sourceInputs.delete(taskToken);
  void entry.session.dispose();
}

/** 插件 disable 时释放所有仍被 Resource Store 记录持有的媒体资源。 */
export function disposeAllMsFileMediaSessions(): void {
  for (const timer of disposalTimers.values()) clearTimeout(timer);
  disposalTimers.clear();
  for (const { session } of sessions.values()) {
    void session.dispose();
  }
  sessions.clear();
  sourceInputs.clear();
}

export function registerMsFileMediaResource(resources: ResourceRegistry, service: MsFileService): void {
  configuredService = service;
  resources.register<MsFileMediaSnapshot, readonly string[]>({
    id: MSFILE_MEDIA_RESOURCE_ID,
    scope: "active-key",
    key: (args) => [MSFILE_MEDIA_RESOURCE_ID, args[0] ?? "none", args[1] ?? "none"],
    load: async (args) => sessionFor(args).snapshot(),
    subscribe: (args, _context, invalidate) => sessionFor(args).subscribe(invalidate),
    equals: (previous, next) => previous === next,
    invalidation: "immediate",
  });
}
