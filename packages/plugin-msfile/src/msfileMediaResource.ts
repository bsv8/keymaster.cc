// 播放器 session 的 Resource Store 适配。
// React 不直接订阅 session；Resource Store 负责失效、重渲染和 active-key
// 生命周期，session 本身仍只保存在内存中，不进入 DB 或 Coordinator 事件。

import type { MsFileService } from "@keymaster/contracts";
import type { ResourceRegistry } from "@keymaster/contracts";
import {
  createMsFileMediaSession,
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
  prefetchBlocks: number;
}

let configuredService: MsFileService | undefined;
const sessions = new Map<string, MsFileMediaSession>();
const disposalTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sessionFor(args: readonly string[]): MsFileMediaSession {
  const token = args[0];
  if (!token || !configuredService) throw new Error("MSFile media resource is not configured");
  const pendingDisposal = disposalTimers.get(token);
  if (pendingDisposal !== undefined) {
    clearTimeout(pendingDisposal);
    disposalTimers.delete(token);
  }
  const existing = sessions.get(token);
  if (existing) return existing;
  const seedHashHex = args[1];
  const supplierPublicKeyHex = args[2];
  const fileSizeText = args[3];
  const declaredMediaType = args[4] ?? "";
  const prefetchBlocks = Number(args[5]);
  if (!seedHashHex || !supplierPublicKeyHex || !fileSizeText || !Number.isSafeInteger(prefetchBlocks)) {
    throw new Error("MSFile media resource arguments are invalid");
  }
  let fileSizeBytes: bigint;
  try { fileSizeBytes = BigInt(fileSizeText); } catch { throw new Error("MSFile media file size is invalid"); }
  const service = configuredService;
  const session = createMsFileMediaSession({
    seedHashHex,
    supplierPublicKeyHex,
    fileSizeBytes,
    declaredMediaType,
    reader: {
      readSeed: async ({ signal }) => extractMsFileReadBytes(await service.readSeed({ supplierPublicKeyHex, seedHashHex, signal }), seedHashHex),
      readBlock: async ({ blockHashHex, signal }) => extractMsFileReadBytes(await service.readBlock({ supplierPublicKeyHex, blockHashHex, signal }), blockHashHex),
    },
  }, { prefetchBlocks });
  sessions.set(token, session);
  return session;
}

export function msFileMediaResourceArgs(input: MsFileMediaResourceInput): readonly string[] {
  return [
    input.taskToken,
    input.seedHashHex,
    input.supplierPublicKeyHex,
    input.fileSizeBytes.toString(),
    input.declaredMediaType,
    String(input.prefetchBlocks),
  ];
}

export function getMsFileMediaSession(taskToken: string): MsFileMediaSession | undefined {
  return sessions.get(taskToken);
}

/**
 * 首页任务结束时主动释放。保留一个很短的 grace period，兼容 React
 * StrictMode 的同步重挂载；过期后从 registry map 移除，避免每次查询永久
 * 留下一个已 disposed session。
 */
export function disposeMsFileMediaSession(taskToken: string): void {
  const session = sessions.get(taskToken);
  if (!session || disposalTimers.has(taskToken)) return;
  const timer = setTimeout(() => {
    disposalTimers.delete(taskToken);
    if (sessions.get(taskToken) !== session) return;
    sessions.delete(taskToken);
    void session.dispose();
  }, 100);
  disposalTimers.set(taskToken, timer);
}

/** 插件 disable 时释放所有仍被 Resource Store 记录持有的媒体资源。 */
export function disposeAllMsFileMediaSessions(): void {
  for (const timer of disposalTimers.values()) clearTimeout(timer);
  disposalTimers.clear();
  for (const session of sessions.values()) void session.dispose();
  sessions.clear();
}

export function registerMsFileMediaResource(resources: ResourceRegistry, service: MsFileService): void {
  configuredService = service;
  resources.register<MsFileMediaSnapshot, readonly string[]>({
    id: MSFILE_MEDIA_RESOURCE_ID,
    scope: "active-key",
    key: (args) => [MSFILE_MEDIA_RESOURCE_ID, args[0] ?? "none"],
    load: async (args) => sessionFor(args).snapshot(),
    subscribe: (args, _context, invalidate) => sessionFor(args).subscribe(invalidate),
    equals: (previous, next) => previous === next,
    invalidation: "immediate",
  });
}
