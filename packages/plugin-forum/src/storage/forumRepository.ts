// Forum 领域仓储。
//
// 布局（全部在已绑定的 `forum/` 模块根之下，不自行拼接物理路径）：
//   configs/<configId>.json          论坛配置
//   roots/<configId>.json            根验证证据
//   cache/<configId>-<op>-<parent>.json  索引缓存（标注离线/旧快照）
//   reading/<configId>.json          阅读位置
//   projections/<seedhash>.json      可重建的标题/摘要投影
//   publish/<taskId>.json            发布任务（写前日志）
//   drafts/<draftId>.json            未冻结的正文草稿
//
// 两条硬规则：
//   - 冻结后的正文只保存 seed hash；发布记录与索引缓存里都不再出现正文本体；
//   - raw 与 hash 原样保存，不经重新编码或大小写变换。

import type {
  ForumBudgetConfirmation,
  ForumConfig,
  ForumListOperation,
  ForumListPage,
  ForumNodeView,
  ForumPublishTask,
  ForumRootVerification,
} from "@keymaster/contracts";
import type { BorrowedOwnerFileStore } from "@keymaster/contracts";
import { FORUM_MARKDOWN_PARSER_VERSION } from "@keymaster/contracts";

export const FORUM_RECORD_FORMAT = "keymaster.forum";
export const FORUM_RECORD_VERSION = 1;
/** 单个记录文件的体积上限；索引缓存与任务记录都不该超过它。 */
export const FORUM_RECORD_MAX_BYTES = 1024 * 1024;

export interface ForumReadingPosition {
  readonly configId: string;
  readonly lastTxid?: string;
  readonly lastParentTxid?: string;
  readonly updatedAtMs: number;
}

/** 索引缓存条目。`stale` 为 true 时不得作为当前报价与付款的真值。 */
export interface ForumIndexCacheEntry {
  readonly configId: string;
  readonly operation: ForumListOperation;
  readonly parentTxid: string;
  readonly snapshotHeight: number;
  readonly mempoolRevision: number;
  readonly items: readonly ForumNodeView[];
  readonly nextCursor: string | null;
  readonly cachedAtMs: number;
  /** 离线或旧快照标记。 */
  readonly stale: boolean;
}

/** 专用资金记录；金额是规范十进制字符串，raw 原样保存。 */
export interface ForumDedicatedFundingRecord {
  readonly fundingId: string;
  readonly txid: string;
  readonly vout: number;
  readonly rawTxHex: string;
  readonly valueSatoshis: string;
  readonly address: string;
  readonly submissionId?: string;
}

export interface ForumDraftRecord {
  readonly draftId: string;
  readonly configId: string;
  readonly markdown: string;
  readonly updatedAtMs: number;
}

interface Envelope<T> {
  readonly format: typeof FORUM_RECORD_FORMAT;
  readonly version: number;
  readonly kind: string;
  readonly data: T;
}

export interface ForumRepository {
  listConfigIds(): Promise<readonly string[]>;
  readConfig(configId: string): Promise<ForumConfig | undefined>;
  writeConfig(config: ForumConfig): Promise<void>;
  deleteConfig(configId: string): Promise<void>;

  readRoot(configId: string): Promise<ForumRootVerification | undefined>;
  writeRoot(verification: ForumRootVerification): Promise<void>;

  readIndexCache(entry: { configId: string; operation: ForumListOperation; parentTxid: string }): Promise<ForumIndexCacheEntry | undefined>;
  writeIndexCache(entry: ForumIndexCacheEntry): Promise<void>;

  readReadingPosition(configId: string): Promise<ForumReadingPosition | undefined>;
  writeReadingPosition(position: ForumReadingPosition): Promise<void>;

  readProjections(seedHashHexes: readonly string[]): Promise<ReadonlyMap<string, ForumNodeViewProjection>>;
  writeProjection(projection: ForumNodeViewProjection): Promise<void>;
  deleteProjection(seedHashHex: string): Promise<void>;

  readTask(taskId: string): Promise<ForumPublishTask | undefined>;
  listTasks(configId?: string): Promise<readonly ForumPublishTask[]>;
  writeTask(task: ForumPublishTask): Promise<void>;
  deleteTask(taskId: string): Promise<void>;

  /* 专用资金记录：按发布任务存放，每个任务一笔，避免两个任务争同一个 UTXO。 */
  readDedicatedFunding(taskId: string): Promise<ForumDedicatedFundingRecord | undefined>;
  writeDedicatedFunding(taskId: string, record: ForumDedicatedFundingRecord): Promise<void>;
  deleteDedicatedFunding(taskId: string): Promise<void>;

  readDraft(draftId: string): Promise<ForumDraftRecord | undefined>;
  writeDraft(draft: ForumDraftRecord): Promise<void>;
  deleteDraft(draftId: string): Promise<void>;
}

export interface ForumNodeViewProjection {
  readonly seedHashHex: string;
  readonly title: string;
  readonly summary: string;
  readonly parserVersion: number;
  readonly bytes: string;
  readonly projectedAtMs: number;
}

/** 仓储只接收 Host 已绑定的 owner 文件句柄，物理路径由绑定决定。 */
export function createForumRepository(files: BorrowedOwnerFileStore, now: () => number = Date.now): ForumRepository {
  const readJson = async <T>(path: string, kind: string): Promise<T | undefined> => {
    const object = await files.get(path);
    if (object === undefined) return undefined;
    if (object.bytes.byteLength > FORUM_RECORD_MAX_BYTES) {
      throw new ForumRecordError("record-too-large", `${path} 超过 ${FORUM_RECORD_MAX_BYTES} 字节上限`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(object.bytes));
    } catch {
      // 损坏记录跳过：一条坏文件不应该让整个论坛不可用。
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const envelope = parsed as Partial<Envelope<T>>;
    if (envelope.format !== FORUM_RECORD_FORMAT || envelope.version !== FORUM_RECORD_VERSION) return undefined;
    if (envelope.kind !== kind) return undefined;
    return envelope.data;
  };

  const writeJson = async (path: string, kind: string, data: unknown): Promise<void> => {
    const envelope: Envelope<unknown> = { format: FORUM_RECORD_FORMAT, version: FORUM_RECORD_VERSION, kind, data };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > FORUM_RECORD_MAX_BYTES) {
      throw new ForumRecordError("record-too-large", `${path} 超过 ${FORUM_RECORD_MAX_BYTES} 字节上限`);
    }
    await files.put(path, bytes, { contentType: "application/json" });
  };

  return {
    async listConfigIds(): Promise<readonly string[]> {
      const page = await files.list({ prefix: "configs/" });
      return page.files
        .map((file) => /^configs\/(.+)\.json$/u.exec(file.path)?.[1])
        .filter((id): id is string => id !== undefined);
    },

    readConfig: (configId) => readJson<ForumConfig>(configPath(configId), "config"),

    async writeConfig(config: ForumConfig): Promise<void> {
      await writeJson(configPath(config.id), "config", config);
    },

    async deleteConfig(configId: string): Promise<void> {
      // 删除 Forum 配置不删除 MSFile 内容：正文真值不属于 Forum。
      await files.delete(configPath(configId));
      await files.delete(rootPath(configId)).catch(() => undefined);
      await files.delete(readingPath(configId)).catch(() => undefined);
    },

    readRoot: (configId) => readJson<ForumRootVerification>(rootPath(configId), "root"),

    writeRoot: (verification) => writeJson(rootPath(verification.configId), "root", verification),

    readIndexCache: (entry) => readJson<ForumIndexCacheEntry>(cachePath(entry.configId, entry.operation, entry.parentTxid), "index-cache"),

    writeIndexCache: (entry) =>
      writeJson(cachePath(entry.configId, entry.operation, entry.parentTxid), "index-cache", {
        ...entry,
        items: entry.items.map(stripRuntimeFields),
      }),

    readReadingPosition: (configId) => readJson<ForumReadingPosition>(readingPath(configId), "reading"),

    writeReadingPosition: (position) => writeJson(readingPath(position.configId), "reading", position),

    async readProjections(seedHashHexes): Promise<ReadonlyMap<string, ForumNodeViewProjection>> {
      const out = new Map<string, ForumNodeViewProjection>();
      for (const seedHashHex of seedHashHexes) {
        const record = await readJson<ForumNodeViewProjection>(projectionPath(seedHashHex), "projection");
        // 解析版本变化时旧投影失效，而不是被当作当前规则的产物。
        if (record !== undefined && record.parserVersion === FORUM_MARKDOWN_PARSER_VERSION) {
          out.set(seedHashHex, record);
        }
      }
      return out;
    },

    writeProjection: (projection) => writeJson(projectionPath(projection.seedHashHex), "projection", projection),

    deleteProjection: (seedHashHex) => files.delete(projectionPath(seedHashHex)).catch(() => undefined),

    readTask: (taskId) => readJson<ForumPublishTask>(taskPath(taskId), "task"),

    async listTasks(configId): Promise<readonly ForumPublishTask[]> {
      const page = await files.list({ prefix: "publish/" });
      const tasks: ForumPublishTask[] = [];
      for (const file of page.files) {
        const taskId = /^publish\/(.+)\.json$/u.exec(file.path)?.[1];
        if (taskId === undefined) continue;
        const task = await readJson<ForumPublishTask>(file.path, "task");
        if (task === undefined) continue;
        if (configId !== undefined && task.forumConfigId !== configId) continue;
        tasks.push(task);
      }
      tasks.sort((left, right) => right.createdAtMs - left.createdAtMs);
      return tasks;
    },

    writeTask: (task) => writeJson(taskPath(task.taskId), "task", task),

    deleteTask: (taskId) => files.delete(taskPath(taskId)).catch(() => undefined),

    readDedicatedFunding: (taskId) => readJson<ForumDedicatedFundingRecord>(fundingPath(taskId), "dedicated-funding"),

    writeDedicatedFunding: (taskId, record) =>
      writeJson(fundingPath(taskId), "dedicated-funding", record),

    deleteDedicatedFunding: (taskId) => files.delete(fundingPath(taskId)).catch(() => undefined),

    readDraft: (draftId) => readJson<ForumDraftRecord>(draftPath(draftId), "draft"),

    writeDraft: (draft) => writeJson(draftPath(draft.draftId), "draft", draft),

    deleteDraft: (draftId) => files.delete(draftPath(draftId)).catch(() => undefined),
  };
}

function stripRuntimeFields(node: ForumNodeView): ForumNodeView {
  // 缓存不保存 undefined 字段，避免 JSON 往返后出现 "parent_txid": null 之外的形态。
  return node;
}

/* 路径只使用绑定根下的相对名；根由 Host 从中央声明推导。 */

function configPath(configId: string): string {
  return `configs/${safeSegment(configId)}.json`;
}

function rootPath(configId: string): string {
  return `roots/${safeSegment(configId)}.json`;
}

function cachePath(configId: string, operation: ForumListOperation, parentTxid: string): string {
  return `cache/${safeSegment(configId)}-${operation}-${safeSegment(parentTxid)}.json`;
}

function readingPath(configId: string): string {
  return `reading/${safeSegment(configId)}.json`;
}

function projectionPath(seedHashHex: string): string {
  return `projections/${safeSegment(seedHashHex)}.json`;
}

function taskPath(taskId: string): string {
  return `publish/${safeSegment(taskId)}.json`;
}

function fundingPath(taskId: string): string {
  return `funding/${safeSegment(taskId)}.json`;
}

function draftPath(draftId: string): string {
  return `drafts/${safeSegment(draftId)}.json`;
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,62}$/iu;

/** 文件名只允许稳定业务 ID 的安全子集；不合法就 fail closed 而不是猜一个名字。 */
function safeSegment(value: string): string {
  if (!SAFE_SEGMENT.test(value)) {
    throw new ForumRecordError("unsafe-name", `记录名 ${JSON.stringify(value)} 不是安全标识`);
  }
  return value;
}

export class ForumRecordError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ForumRecordError";
    this.code = code;
  }
}

export type { ForumListPage, ForumBudgetConfirmation };