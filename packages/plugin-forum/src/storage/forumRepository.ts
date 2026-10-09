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
import type { BorrowedOwnerFileStore, StorageObjectRevision } from "@keymaster/contracts";
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
  readonly fundingId?: string;
  readonly txid: string;
  readonly vout: number;
  readonly rawTxHex: string;
  readonly valueSatoshis: string;
  readonly address: string;
  readonly submissionId?: string;
  /** 记录归属的 owner 公钥（小写 hex）；恢复时拒绝别的身份的记录。 */
  readonly ownerPublicKeyHex?: string;
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

/**
 * 派发租约。
 *
 * 同一浏览器里的多个标签页各自持有一个 Window 实例，进程内的互斥锁对它们无效。
 * 租约把「谁正在为这个任务拆钱和派发」写进 owner 文件存储，并用**条件写**
 * （`ifNoneMatch` / `ifRevision`）取得：两个标签页同时抢同一笔任务时，只有一个
 * 的条件写会成功，另一个拿到冲突而不是各自准备一遍资金。
 *
 * 租约是有时限的：标签页崩溃或关闭窗口后不会永久锁死任务，过期即可被接管。
 * 代价是持有者**可能**在执行途中失去租约，因此 `fencingToken` 是租约的一部分：
 * 持有者必须在自己的每一次写入里带上它，由写入方（阶段推进、资金准备、派发）
 * 核对，租约被接管之后旧持有者的写入就一定失败。
 */
export interface ForumDispatchLease {
  readonly taskId: string;
  /** 持有者标识：页面实例的随机 id，同一页面重入时保持不变。 */
  readonly holderId: string;
  readonly ownerPublicKeyHex: string;
  readonly acquiredAtMs: number;
  /** 到期时刻；超过它仍未推进阶段的任务允许被接管。 */
  readonly expiresAtMs: number;
  /**
   * 栅栏令牌：每次取得或续租都递增。
   *
   * 阶段推进时写入任务记录，接管方的下一次推进会看到更大的令牌并覆盖它；
   * 旧持有者带着更小的令牌回来写入时会被拒绝。单纯「我以为我持有租约」不够，
   * 因为租约可能在两次 I/O 之间被别人接管。
   */
  readonly fencingToken: number;
}

/**
 * 派发租约读写。
 *
 * `acquire` 用条件写保证互斥；`release` 按 revision 条件删除，只删自己那一版；
 * `assertHeld` 是持有权的权威核对——它在每次不可逆动作前调用，而不是相信本地状态。
 */
export interface ForumDispatchLeaseHandle {
  /** 续租后会被替换成带更大栅栏令牌的新版本，因此不是 readonly。 */
  lease: ForumDispatchLease;
  /**
   * 续租：持有者延长自己的租期并拿到新的栅栏令牌，不会抢走别人的。
   *
   * 返回 undefined 表示租约已被接管，此后本次调用必须停止。
   */
  renew(lease: ForumDispatchLease): Promise<ForumDispatchLease | undefined>;
  /**
   * 权威核对持有权。
   *
   * 读存储而不是信任内存：只有磁盘上仍是本持有者且未过期的租约才算持有。
   * 慢请求或页面被暂停超过 TTL 后，这里会失败并阻止后续动作。
   */
  assertHeld(): Promise<ForumDispatchLease>;
  /** 按 revision 条件删除：不会删掉接管方写入的新版本。 */
  release(): Promise<void>;
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
  /**
   * 写任务；带栅栏令牌时做条件写。
   *
   * `fencingToken` 是派发租约带来的：没有它就只是「后写覆盖前写」。有了它，
   * 租约被接管后旧持有者的阶段推进会因令牌落后而失败，而不是把接管方的进展覆盖掉。
   */
  writeTask(task: ForumPublishTask, options?: { fencingToken?: number }): Promise<void>;
  /** 当前已记录的最大栅栏令牌；未记录过时为 0。 */
  readTaskFencingToken(taskId: string): Promise<number>;
  deleteTask(taskId: string): Promise<void>;

  /* 专用资金记录：按发布任务存放，每个任务一笔，避免两个任务争同一个 UTXO。 */
  readDedicatedFunding(taskId: string): Promise<ForumDedicatedFundingRecord | undefined>;
  writeDedicatedFunding(taskId: string, record: ForumDedicatedFundingRecord): Promise<void>;
  deleteDedicatedFunding(taskId: string): Promise<void>;

  /**
   * 跨标签页的派发互斥。
   *
   * 用 owner 文件存储的条件写取得，所以同一浏览器的第二个标签页会拿到 undefined
   * 而不是各自准备一遍资金。租约有 TTL：崩溃的标签页不会永久锁死任务。
   */
  acquireDispatchLease(
    // 令牌由仓储分配：调用方给不出「比磁盘上更大」的值，所以它不是入参。
    input: Omit<ForumDispatchLease, "expiresAtMs" | "fencingToken">,
    leaseTtlMs: number,
  ): Promise<ForumDispatchLeaseHandle | undefined>;

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
  const decodeJson = <T>(bytes: Uint8Array, path: string, kind: string): T | undefined => {
    if (bytes.byteLength > FORUM_RECORD_MAX_BYTES) throw new ForumRecordError("record-too-large", `${path} 超过记录大小上限`);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const envelope = parsed as Partial<Envelope<T>>;
    if (envelope.format !== FORUM_RECORD_FORMAT || envelope.version !== FORUM_RECORD_VERSION || envelope.kind !== kind) return undefined;
    return envelope.data;
  };
  const readJson = async <T>(path: string, kind: string): Promise<T | undefined> => {
    const object = await files.get(path);
    return object === undefined ? undefined : decodeJson<T>(object.bytes, path, kind);
  };
  // 内容与 revision 必须来自同一个 get，不能借用另一次读取的新 revision。
  const readTaskSnapshot = async (taskId: string) => {
    const path = taskPath(taskId);
    const object = await files.get(path);
    return object === undefined ? undefined : {
      task: decodeJson<ForumPublishTaskWithToken>(object.bytes, path, "task"),
      revision: object.revision,
    };
  };
  const readStoredTask = async (taskId: string): Promise<ForumPublishTaskWithToken | undefined> =>
    (await readTaskSnapshot(taskId))?.task;

  const writeJson = async (path: string, kind: string, data: unknown): Promise<void> => {
    const envelope: Envelope<unknown> = { format: FORUM_RECORD_FORMAT, version: FORUM_RECORD_VERSION, kind, data };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > FORUM_RECORD_MAX_BYTES) {
      throw new ForumRecordError("record-too-large", `${path} 超过 ${FORUM_RECORD_MAX_BYTES} 字节上限`);
    }
    await files.put(path, bytes, { contentType: "application/json" });
  };

  /** 租约记录的内容与 revision。revision 是条件写的依据，必须和内容一起读。 */
  const readLeaseAt = async (path: string): Promise<{ lease: ForumDispatchLease | undefined; revision: StorageObjectRevision } | undefined> => {
    const object = await files.get(path);
    if (object === undefined) return undefined;
    return { lease: decodeLease(object.bytes), revision: object.revision };
  };

  /**
   * 条件写任务记录。
   *
   * `revision` 是原子判据：读-比-写之间的窗口由存储层判定，而不是由我们先读出来
   * 的值判断。`token` 一并携带，保证无条件写的那条路径不会抹掉仲裁元数据。
   */
  const putTaskIfUnchanged = async (
    path: string,
    data: ForumPublishTaskWithToken,
    revision: StorageObjectRevision | undefined,
    token: number,
  ): Promise<boolean> => {
    const envelope: Envelope<ForumPublishTaskWithToken> = {
      format: FORUM_RECORD_FORMAT,
      version: FORUM_RECORD_VERSION,
      kind: "task",
      data: withFencingToken(stripFencingToken(data) as ForumPublishTask, token),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    if (bytes.byteLength > FORUM_RECORD_MAX_BYTES) {
      throw new ForumRecordError("record-too-large", `${path} 超过 ${FORUM_RECORD_MAX_BYTES} 字节上限`);
    }
    try {
      await files.put(path, bytes, {
        contentType: "application/json",
        ...(revision === undefined ? { ifNoneMatch: true as const } : { ifRevision: revision }),
      });
      return true;
    } catch {
      return false;
    }
  };

  /** 条件写：文件不存在用 `ifNoneMatch`，存在用 `ifRevision`。失败返回 false。 */
  const putLease = async (path: string, lease: ForumDispatchLease, revision: StorageObjectRevision | undefined): Promise<boolean> => {
    const envelope: Envelope<ForumDispatchLease> = {
      format: FORUM_RECORD_FORMAT,
      version: FORUM_RECORD_VERSION,
      kind: "dispatch-lease",
      data: lease,
    };
    try {
      await files.put(path, new TextEncoder().encode(JSON.stringify(envelope)), {
        contentType: "application/json",
        ...(revision === undefined ? { ifNoneMatch: true as const } : { ifRevision: revision }),
      });
      return true;
    } catch {
      return false;
    }
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

    readTask: async (taskId) => stripFencingToken(await readStoredTask(taskId)),

    readTaskFencingToken: async (taskId) => fencingTokenOf(await readStoredTask(taskId)),

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

    /**
     * 写任务；带栅栏令牌时是条件写。
     *
     * 规则是「令牌不得落后于已记录的值」：接管方拿到更大的令牌并推进之后，
     * 旧持有者带着更小的令牌回来写入会失败。相等则允许（持有者自己续租后
     * 令牌会变大，所以相等只出现在没有发生接管时）。
     */
    async writeTask(task, options) {
      const path = taskPath(task.taskId);
      const snapshot = await readTaskSnapshot(task.taskId);
      if (snapshot !== undefined && snapshot.task === undefined) throw new ForumRecordError("invalid-task", "发布任务记录损坏，拒绝覆盖");
      const currentToken = fencingTokenOf(snapshot?.task);
      const token = options?.fencingToken ?? currentToken;
      if (token < currentToken) throw new ForumRecordError("fenced", `发布任务 ${task.taskId} 的栅栏令牌落后，租约已被接管`);
      if (!(await putTaskIfUnchanged(path, withFencingToken(task, token), snapshot?.revision, token))) {
        throw new ForumRecordError("concurrent-write", `发布任务 ${task.taskId} 在写入前已被另一个写入改变`);
      }
    },

    deleteTask: (taskId) => files.delete(taskPath(taskId)).catch(() => undefined),

    async readDedicatedFunding(taskId) {
      // 显式 async：路径非法时以 rejected promise 表达，与仓储其余入口一致，
      // 否则调用方的 `await` 与 `catch` 会漏掉同步抛出的错误。
      return readJson<ForumDedicatedFundingRecord>(fundingPath(taskId), "dedicated-funding");
    },

    writeDedicatedFunding: (taskId, record) =>
      writeJson(fundingPath(taskId), "dedicated-funding", record),

    deleteDedicatedFunding: (taskId) => files.delete(fundingPath(taskId)).catch(() => undefined),

  /**
   * 取得派发租约。
   *
   * 两条条件写分支：文件不存在时用 `ifNoneMatch`（创建竞态），存在且已过期时用
   * `ifRevision`（接管竞态）。任一条失败都说明另一个标签页抢先，因此返回 undefined
   * 而不是覆盖。
   */
  async acquireDispatchLease(
    input: Omit<ForumDispatchLease, "expiresAtMs">,
    leaseTtlMs: number,
  ): Promise<ForumDispatchLeaseHandle | undefined> {
    const path = leasePath(input.taskId);
    // 一次读出内容与 revision：条件写必须带 revision，否则「接管已过期租约」
    // 会退化成无条件覆盖，互斥也就没了。
    const current = await readLeaseAt(path);
    const held = current?.lease;
    if (held !== undefined && held.expiresAtMs > now() && held.holderId !== input.holderId) {
      // 另一个标签页正在处理：这里的调用方必须落到对账而不是各自准备资金。
      return undefined;
    }
    const ownRenewal = held?.holderId === input.holderId;
    // 令牌来自**任务记录**而不是租约文件。租约释放会删掉那个文件，若从它开始计数，
    // 下一次取得又会回到 1，而任务里可能已经记着更大的令牌——于是恢复重试会被自己的
    // 旧记录判为 fenced。任务记录不随释放删除，因此它才是持久的单调计数。
    const taskToken = fencingTokenOf(await readStoredTask(input.taskId));
    const nextToken = Math.max(taskToken, held?.fencingToken ?? 0) + 1;
    // `mine` 是这份租约的可变游标：续租推进它，assertHeld 与 release 比对它的当前值。
    const mine: { lease: ForumDispatchLease } = {
      lease: {
        ...input,
        expiresAtMs: ownRenewal ? Math.max(now() + leaseTtlMs, held.expiresAtMs) : now() + leaseTtlMs,
        fencingToken: nextToken,
      },
    };
    if (!(await putLease(path, mine.lease, current?.revision))) return undefined;
    return {
      get lease() {
        return mine.lease;
      },
      set lease(next: ForumDispatchLease) {
        mine.lease = next;
      },
      async renew(next) {
        const latest = await readLeaseAt(path);
        // 续租只能续自己的：别人的租约被抢走就说明互斥已经失效。
        if (latest?.lease !== undefined && latest.lease.holderId !== input.holderId) {
          return undefined;
        }
        const renewed: ForumDispatchLease = {
          ...next,
          expiresAtMs: now() + leaseTtlMs,
          fencingToken: (latest?.lease?.fencingToken ?? 0) + 1,
        };
        if (!(await putLease(path, renewed, latest?.revision))) return undefined;
        // 本地游标同步推进：否则后续 assertHeld 会拿旧令牌和自己的续租结果比对而误判。
        mine.lease = renewed;
        return renewed;
      },
      async assertHeld() {
        // 每次不可逆动作前都读存储核对。只看内存的话，租约被接管这件事永远发现不了。
        // 比对本地游标的当前值：续租会推进它，续租后的核对必须用新令牌。
        const local = mine.lease;
        const latest = await readLeaseAt(path);
        if (latest?.lease === undefined) {
          throw new ForumRecordError("lease-lost", `发布任务 ${input.taskId} 的派发租约已不存在`);
        }
        if (latest.lease.holderId !== input.holderId || latest.lease.fencingToken !== local.fencingToken) {
          throw new ForumRecordError(
            "lease-lost",
            `发布任务 ${input.taskId} 的派发租约已被接管（当前持有者令牌 ${latest.lease.fencingToken}，本地令牌 ${local.fencingToken}）`,
          );
        }
        if (latest.lease.expiresAtMs <= now()) {
          throw new ForumRecordError("lease-expired", `发布任务 ${input.taskId} 的派发租约已过期`);
        }
        return latest.lease;
      },
      async release() {
        const local = mine.lease;
        const latest = await readLeaseAt(path);
        // 只删自己那一版：按 revision 条件删除，因此接管方写入的新版本不会被误删。
        if (latest?.lease === undefined) return;
        if (latest.lease.holderId !== input.holderId || latest.lease.fencingToken !== local.fencingToken) return;
        await files.delete(path, { ifRevision: latest.revision }).catch(() => undefined);
      },
    };
  },

    readDraft: (draftId) => readJson<ForumDraftRecord>(draftPath(draftId), "draft"),

    writeDraft: (draft) => writeJson(draftPath(draft.draftId), "draft", draft),

    deleteDraft: (draftId) => files.delete(draftPath(draftId)).catch(() => undefined),
  };
}

function stripRuntimeFields(node: ForumNodeView): ForumNodeView {
  // 缓存不保存 undefined 字段，避免 JSON 往返后出现 "parent_txid": null 之外的形态。
  return node;
}

/** 栅栏令牌在磁盘上的字段名；与任务内容分开，读任务时剥掉。 */
const FORUM_TASK_FENCING_KEY = "__fencingToken";

/** 磁盘上的任务形态：业务字段 + 栅栏令牌。 */
type ForumPublishTaskWithToken = ForumPublishTask & { [FORUM_TASK_FENCING_KEY]?: number };

function withFencingToken(task: ForumPublishTask, token: number): ForumPublishTaskWithToken {
  return { ...task, [FORUM_TASK_FENCING_KEY]: token };
}

/** 从磁盘形态里取栅栏令牌；缺失或非法一律按 0（无令牌）处理。 */
function fencingTokenOf(stored: ForumPublishTaskWithToken | undefined): number {
  const token = stored?.[FORUM_TASK_FENCING_KEY];
  return typeof token === "number" && Number.isSafeInteger(token) && token >= 0 ? token : 0;
}

function stripFencingToken(stored: ForumPublishTaskWithToken | undefined): ForumPublishTask | undefined {
  if (stored === undefined) return undefined;
  // 令牌是仲裁元数据，不属于任务：调用方看到它就可能自己拿去当条件写。
  const { [FORUM_TASK_FENCING_KEY]: _token, ...rest } = stored;
  return rest;
}

/**
 * 解码租约；损坏的租约按「不存在」处理。
 *
 * 这里的取舍很明确：读不出持有者就无法判断它是否过期，因此让下一位调用者按
 * 创建分支接管，而不是把一个无法归属的锁一直留着。
 */
function decodeLease(bytes: Uint8Array): ForumDispatchLease | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const envelope = parsed as Partial<Envelope<ForumDispatchLease>>;
  if (envelope.format !== FORUM_RECORD_FORMAT || envelope.version !== FORUM_RECORD_VERSION) return undefined;
  if (envelope.kind !== "dispatch-lease") return undefined;
  const lease = envelope.data;
  if (typeof lease !== "object" || lease === null) return undefined;
  if (typeof lease.taskId !== "string" || typeof lease.holderId !== "string" || lease.holderId.length === 0) return undefined;
  if (typeof lease.ownerPublicKeyHex !== "string" || !Number.isFinite(lease.acquiredAtMs) || !Number.isFinite(lease.expiresAtMs)) {
    return undefined;
  }
  return lease;
}

/* 路径只使用绑定根下的相对名；根由 Host 从中央声明推导。 */

function configPath(configId: string): string {
  return `configs/${safeSegment(configId)}.json`;
}

function rootPath(configId: string): string {
  return `roots/${safeSegment(configId)}.json`;
}

function cachePath(configId: string, operation: ForumListOperation, parentTxid: string): string {
  // parentTxid 是 64 字符 txid，不是业务 ID：必须走 hash 校验，否则所有列表缓存
  // 都会因为 unsafe-name 而写不进去（写入异常又被调用方吞掉，离线缓存静默失效）。
  return `cache/${safeSegment(configId)}-${operation}-${safeHashSegment(parentTxid, "parent_txid")}.json`;
}

function readingPath(configId: string): string {
  return `reading/${safeSegment(configId)}.json`;
}

function projectionPath(seedHashHex: string): string {
  // seedHash 是 64 字符 hash，同上：不能套业务 ID 的 63 字符上限。
  return `projections/${safeHashSegment(seedHashHex, "seed hash")}.json`;
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

function leasePath(taskId: string): string {
  return `leases/${safeSegment(taskId)}.json`;
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,62}$/iu;
/** 32 字节 hash 的 hex 形式：64 字符小写 hex。 */
const HASH_SEGMENT = /^[0-9a-f]{64}$/u;

/**
 * hash 的路径片段校验。
 *
 * 与业务 ID 分开：txid 与 seed hash 天然是 64 字符，把它们塞进 63 字符的业务 ID
 * 规则会让索引缓存与展示投影**永远**写不进去，而写入异常在调用方被吞掉，于是
 * 离线缓存静默失效——一个看不出症状的失效。
 */
function safeHashSegment(value: string, label: string): string {
  if (!HASH_SEGMENT.test(value)) {
    throw new ForumRecordError("unsafe-name", `${label} 必须是 64 字符小写 hex，实际 ${JSON.stringify(value)}`);
  }
  return value;
}

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