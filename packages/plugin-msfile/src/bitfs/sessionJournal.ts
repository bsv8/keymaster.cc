// BitFS 买卖会话的 Keymaster 自有状态机存储。
//
// 与 go-bitfs 的边界：SDK 只返回普通 evidence 和 exact bytes；本文件
// 记录应用进度、恢复 fence 和证据引用，不序列化 SDK 实例。

import type { OwnerFileStore } from "@keymaster/contracts";

const SESSION_FORMAT = "keymaster.bitfs-session";
const SESSION_VERSION = 1;
const SESSION_ID = /^[0-9a-z][0-9a-z._-]{0,127}$/u;
const HASH_HEX = /^[0-9a-f]{64}$/u;
const PUBLIC_KEY_HEX = /^(02|03)[0-9a-f]{64}$/u;

/** 可持久化的买方阶段。 */
export type BitfsBuyerPhase =
  | "discovering"
  | "quote-selected"
  | "opening-presign"
  | "funding-prepared"
  | "funding-unknown"
  | "funded"
  | "request-prepared"
  | "delivery-verified"
  | "content-committing"
  | "payment-unknown"
  | "completed"
  | "refund-ready"
  | "arbitration-retrieval"
  | "failed";

/** 可持久化的卖方阶段。 */
export type BitfsSellerPhase =
  | "quoted"
  | "opening-presigned"
  | "funded"
  | "delivery-prepared"
  | "payment-signing"
  | "payment-unknown"
  | "paid"
  | "close-unknown"
  | "closed"
  | "arbitration-prepared"
  | "arbitration-payment-unknown"
  | "failed";

/** 独立保存的 exact 报文/交易/证据字节的稳定名称。 */
type BitfsFixedEvidenceName =
  | "kind1-quote"
  | "kind2-opening-request"
  | "kind3-opening-response"
  | "kind4-funding-delivery"
  | "kind5-content-request"
  | "kind6-content-delivery"
  | "kind7-payment-update"
  | "kind8-arbitration-request"
  | "kind9-arbitration-response"
  | "kind10-retrieval-request"
  | "kind11-retrieval-response"
  | "funding-transaction"
  | "latest-payment-transaction"
  | "close-transaction"
  | "refund-transaction"
  | "arbitrated-payment-transaction"
  | "opening-evidence"
  | "pool-evidence"
  | "delivery-evidence";

/** 多批交付按 PaymentAuthorizationID 建立独立 exact 证据，不会覆盖上一轮。 */
export type BitfsEvidenceName = BitfsFixedEvidenceName
  | `kind5-content-request-${string}`
  | `kind6-content-delivery-${string}`
  | `kind7-payment-update-${string}`
  | `kind7-payment-sign-digest-${string}`
  | `kind7-payment-signature-${string}`
  | `latest-payment-transaction-${string}`;

export interface BitfsSessionRecord {
  /** 应用会话编号，不是 SDK 对象 ID。 */
  sessionId: string;
  /** 本会话的协议角色。 */
  role: "buyer" | "seller";
  /** 当前 Key 的压缩公钥。 */
  ownerPublicKeyHex: string;
  /** 对端压缩公钥。 */
  counterpartyPublicKeyHex: string;
  /** 本次买卖绑定的 Seed Hash。 */
  seedHashHex: string;
  /** 创建会话时的 Worker generation，用于拒绝迟到结果。 */
  generation: number;
  /** 买方或卖方阶段。 */
  phase: BitfsBuyerPhase | BitfsSellerPhase;
  /** 已可靠写入的证据文件名。 */
  evidence: BitfsEvidenceName[];
  /** 当前需对账的 canonical txid。 */
  pendingTxid?: string;
  /** 下一个时间截止点，UTC Unix 秒字符串。 */
  deadlineUnixSeconds?: string;
  /** 退款模板高度锁或时间锁数值。 */
  refundLockTime?: number;
  /** 记录修订号；每次 CAS 更新加一。 */
  revision: number;
  /** 最后更新时间，UTC ISO-8601。 */
  updatedAt: string;
  /** 稳定失败分类；不包含协议字节。 */
  failureCode?: string;
}

export interface BitfsSessionJournal {
  /** 仅当会话不存在时创建。 */
  create(record: Omit<BitfsSessionRecord, "revision" | "updatedAt" | "evidence"> & { evidence?: BitfsEvidenceName[] }, nowMs: number): Promise<BitfsSessionRecord>;
  /** 读取会话记录。 */
  get(sessionId: string): Promise<BitfsSessionRecord | undefined>;
  /** 按 revision + Provider ETag 原子推进阶段。 */
  update(sessionId: string, expectedRevision: number, patch: Partial<Pick<BitfsSessionRecord, "phase" | "pendingTxid" | "deadlineUnixSeconds" | "refundLockTime" | "failureCode">>, nowMs: number): Promise<BitfsSessionRecord>;
  /** 先以 create-only 保存 exact bytes，回读一致后再把引用加入会话。 */
  putEvidence(sessionId: string, expectedRevision: number, name: BitfsEvidenceName, bytes: Uint8Array, nowMs: number): Promise<BitfsSessionRecord>;
  /** 读取 exact evidence 防御性副本。 */
  getEvidence(sessionId: string, name: BitfsEvidenceName): Promise<Uint8Array | undefined>;
  /** 分页扫描恢复记录。 */
  list(): Promise<BitfsSessionRecord[]>;
}

export function createBitfsSessionJournal(store: OwnerFileStore): BitfsSessionJournal {
  const recordPath = (id: string) => `sessions/${assertSessionId(id)}.json`;
  const evidencePath = (id: string, name: BitfsEvidenceName) => `evidence/${assertSessionId(id)}/${name}.bin`;
  const read = async (id: string): Promise<{ record: BitfsSessionRecord; etag?: string } | undefined> => {
    const object = await store.get(recordPath(id));
    if (!object) return undefined;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)); }
    catch { throw new Error("BitFS 会话索引损坏"); }
    return { record: parseRecord(value, id), ...(object.etag === undefined ? {} : { etag: object.etag }) };
  };
  const write = async (record: BitfsSessionRecord, options: { ifNoneMatch?: "*"; ifMatch?: string } = {}): Promise<void> => {
    const bytes = new TextEncoder().encode(`${JSON.stringify({ format: SESSION_FORMAT, version: SESSION_VERSION, ...record }, null, 2)}\n`);
    await store.put(recordPath(record.sessionId), bytes, options);
  };
  const mutate = async (id: string, expectedRevision: number, change: (current: BitfsSessionRecord) => BitfsSessionRecord): Promise<BitfsSessionRecord> => {
    const current = await read(id);
    if (!current || current.record.revision !== expectedRevision) throw new Error("BitFS 会话修订冲突");
    const next = change(current.record);
    await write(next, current.etag === undefined ? {} : { ifMatch: current.etag });
    const committed = await read(id);
    if (!committed || committed.record.revision !== next.revision) throw new Error("BitFS 会话状态提交失败");
    return committed.record;
  };
  return {
    async create(input, nowMs) {
      const record = validateRecord({ ...input, evidence: uniqueEvidence(input.evidence ?? []), revision: 1, updatedAt: iso(nowMs) });
      await write(record, { ifNoneMatch: "*" });
      return (await read(record.sessionId))!.record;
    },
    async get(sessionId) { return (await read(sessionId))?.record; },
    async update(sessionId, expectedRevision, patch, nowMs) {
      return mutate(sessionId, expectedRevision, (current) => validateRecord({
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: iso(nowMs),
      }));
    },
    async putEvidence(sessionId, expectedRevision, name, bytes, nowMs) {
      assertEvidenceName(name);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new TypeError("BitFS 证据字节不能为空");
      const path = evidencePath(sessionId, name);
      const prior = await store.get(path);
      if (prior && !equal(prior.bytes, bytes)) throw new Error("BitFS 证据名已绑定不同 exact bytes");
      if (!prior) await store.put(path, bytes.slice(), { ifNoneMatch: "*" });
      const committed = await store.get(path);
      if (!committed || !equal(committed.bytes, bytes)) throw new Error("BitFS 证据持久化校验失败");
      return mutate(sessionId, expectedRevision, (current) => validateRecord({
        ...current,
        evidence: uniqueEvidence([...current.evidence, name]),
        revision: current.revision + 1,
        updatedAt: iso(nowMs),
      }));
    },
    async getEvidence(sessionId, name) {
      const object = await store.get(evidencePath(sessionId, assertEvidenceName(name)));
      return object?.bytes.slice();
    },
    async list() {
      const records: BitfsSessionRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.list({ prefix: "sessions/", limit: 200, ...(cursor === undefined ? {} : { cursor }) });
        for (const file of page.files) {
          const match = /^sessions\/([0-9a-z][0-9a-z._-]{0,127})\.json$/u.exec(file.path);
          if (!match) continue;
          const item = await read(match[1]!);
          if (item) records.push(item.record);
        }
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return records.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    },
  };
}

function parseRecord(value: unknown, expectedId: string): BitfsSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BitFS 会话索引格式错误");
  const row = value as Record<string, unknown>;
  if (row.format !== SESSION_FORMAT || row.version !== SESSION_VERSION || row.sessionId !== expectedId) throw new Error("BitFS 会话索引版本错误");
  return validateRecord(row as unknown as BitfsSessionRecord);
}

function validateRecord(record: BitfsSessionRecord): BitfsSessionRecord {
  assertSessionId(record.sessionId);
  if (record.role !== "buyer" && record.role !== "seller") throw new Error("BitFS 会话角色错误");
  if (!PUBLIC_KEY_HEX.test(record.ownerPublicKeyHex) || !PUBLIC_KEY_HEX.test(record.counterpartyPublicKeyHex)) throw new Error("BitFS 会话公钥错误");
  if (!HASH_HEX.test(record.seedHashHex)) throw new Error("BitFS 会话 Seed Hash 错误");
  if (!Number.isSafeInteger(record.generation) || record.generation < 0) throw new Error("BitFS 会话 generation 错误");
  if (!allPhases.has(record.phase)) throw new Error("BitFS 会话阶段错误");
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error("BitFS 会话修订号错误");
  if (!Number.isFinite(Date.parse(record.updatedAt)) || new Date(Date.parse(record.updatedAt)).toISOString() !== record.updatedAt) throw new Error("BitFS 会话时间错误");
  if (record.pendingTxid !== undefined && !HASH_HEX.test(record.pendingTxid)) throw new Error("BitFS 会话 txid 错误");
  if (record.deadlineUnixSeconds !== undefined && !/^[1-9][0-9]*$/u.test(record.deadlineUnixSeconds)) throw new Error("BitFS 会话截止时间错误");
  if (record.refundLockTime !== undefined && (!Number.isSafeInteger(record.refundLockTime) || record.refundLockTime < 0 || record.refundLockTime > 0xffffffff)) throw new Error("BitFS 会话退款锁错误");
  if (record.failureCode !== undefined && !/^[a-z0-9._-]{1,64}$/u.test(record.failureCode)) throw new Error("BitFS 会话失败码错误");
  return {
    ...record,
    evidence: uniqueEvidence(record.evidence),
  };
}

const allPhases = new Set<BitfsBuyerPhase | BitfsSellerPhase>([
  "discovering", "quote-selected", "opening-presign", "funding-prepared", "funding-unknown", "funded",
  "request-prepared", "delivery-verified", "content-committing", "payment-unknown", "completed",
  "refund-ready", "arbitration-retrieval", "quoted", "opening-presigned", "delivery-prepared", "payment-signing", "paid",
  "close-unknown", "closed", "arbitration-prepared", "arbitration-payment-unknown", "failed",
]);

const evidenceNames = new Set<BitfsFixedEvidenceName>([
  "kind1-quote", "kind2-opening-request", "kind3-opening-response", "kind4-funding-delivery",
  "kind5-content-request", "kind6-content-delivery", "kind7-payment-update", "kind8-arbitration-request",
  "kind9-arbitration-response", "kind10-retrieval-request", "kind11-retrieval-response", "funding-transaction",
  "latest-payment-transaction", "close-transaction", "refund-transaction", "arbitrated-payment-transaction",
  "opening-evidence", "pool-evidence", "delivery-evidence",
]);

function assertSessionId(value: string): string { if (!SESSION_ID.test(value)) throw new TypeError("BitFS 会话 ID 不合法"); return value; }
function assertEvidenceName(value: BitfsEvidenceName): BitfsEvidenceName {
  if (evidenceNames.has(value as BitfsFixedEvidenceName)
    || /^(kind5-content-request|kind6-content-delivery|kind7-payment-update|kind7-payment-sign-digest|kind7-payment-signature|latest-payment-transaction)-[0-9a-f]{64}$/u.test(value)) return value;
  throw new TypeError("BitFS 证据名不合法");
}
function uniqueEvidence(values: readonly BitfsEvidenceName[]): BitfsEvidenceName[] { return [...new Set(values.map(assertEvidenceName))].sort(); }
function iso(nowMs: number): string { if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("BitFS 会话时间不合法"); return new Date(nowMs).toISOString(); }
function equal(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]); }
