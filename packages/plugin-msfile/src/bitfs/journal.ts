// BitFS checkpoint / exact outbox 持久化。
//
// 该存储必须绑定独立 `bitfs-journal` purpose。协议字节逐文件原样保存，不放入
// MSFile 内容、设置或 App 用量文件；发送方只能发送 `prepareOutbound` 返回的副本。

import type { OwnerFileStore } from "@keymaster/contracts";
import { parse, type Artifact, type WireKind } from "go-bitfs";

const RECORD_FORMAT = "keymaster.bitfs-journal";
const RECORD_VERSION = 1;
const ID_PATTERN = /^[0-9a-f]{64}$/u;

/** 不含敏感协议字节的恢复索引。 */
export interface BitfsJournalRecord {
  /** RefundTemplateTxID 或 PaymentAuthorizationID 的小写 hex。 */
  idHex: string;
  /** 当前角色。 */
  role: "buyer" | "seller";
  /** 调用方定义、版本化的不透明 checkpoint 字节文件是否已写入。 */
  checkpointPresent: boolean;
  /** 已持久化的出站 Artifact Kind。 */
  outboxKind?: WireKind;
  /** 出站状态；unknown 必须通过业务 ID 对账，不能重新签名。 */
  outboxState?: "prepared" | "sent" | "result-unknown" | "confirmed";
  /** 最后更新时间，UTC ISO-8601。 */
  updatedAt: string;
}

export interface BitfsJournal {
  /** 保存 opaque checkpoint；调用方负责版本与语义，存储层不解析。 */
  putCheckpoint(idHex: string, role: "buyer" | "seller", bytes: Uint8Array, nowMs: number): Promise<void>;
  /** 读取 checkpoint 的防御性副本。 */
  getCheckpoint(idHex: string): Promise<Uint8Array | undefined>;
  /** 先保存并严格回读 exact Artifact，再允许网络发送。 */
  prepareOutbound(idHex: string, role: "buyer" | "seller", artifact: Artifact, nowMs: number): Promise<Uint8Array>;
  /** 更新已保存 outbox 状态；不会覆盖 exact bytes。 */
  markOutbound(idHex: string, state: "sent" | "result-unknown" | "confirmed", nowMs: number): Promise<void>;
  /** 恢复并再次严格解析 exact Artifact。 */
  restoreOutbound(idHex: string): Promise<Artifact | undefined>;
  /** 读取恢复索引。 */
  getRecord(idHex: string): Promise<BitfsJournalRecord | undefined>;
}

export function createBitfsJournal(store: OwnerFileStore): BitfsJournal {
  const recordPath = (id: string) => `records/${assertId(id)}.json`;
  const checkpointPath = (id: string) => `checkpoints/${assertId(id)}.bin`;
  const outboxPath = (id: string) => `outbox/${assertId(id)}.cbor`;
  const writeRecord = async (record: BitfsJournalRecord): Promise<void> => {
    const bytes = new TextEncoder().encode(`${JSON.stringify({ format: RECORD_FORMAT, version: RECORD_VERSION, ...record }, null, 2)}\n`);
    await store.put(recordPath(record.idHex), bytes);
  };
  const readRecord = async (idHex: string): Promise<BitfsJournalRecord | undefined> => {
    const object = await store.get(recordPath(idHex));
    if (!object) return undefined;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.bytes)); } catch { throw new Error("BitFS journal 索引损坏"); }
    return parseRecord(value, idHex);
  };
  return {
    async putCheckpoint(idHex, role, bytes, nowMs) {
      assertNonempty(bytes, "checkpoint");
      const existing = await readRecord(idHex);
      await store.put(checkpointPath(idHex), bytes.slice());
      await writeRecord({
        idHex: assertId(idHex), role,
        checkpointPresent: true,
        ...(existing?.outboxKind === undefined ? {} : { outboxKind: existing.outboxKind }),
        ...(existing?.outboxState === undefined ? {} : { outboxState: existing.outboxState }),
        updatedAt: iso(nowMs),
      });
    },
    async getCheckpoint(idHex) {
      const object = await store.get(checkpointPath(idHex));
      return object?.bytes.slice();
    },
    async prepareOutbound(idHex, role, artifact, nowMs) {
      const exact = artifact.bytes();
      const validated = parse(exact);
      const existing = await readRecord(idHex);
      const prior = await store.get(outboxPath(idHex));
      if (prior && !equal(prior.bytes, exact)) throw new Error("BitFS outbox ID 已绑定不同 exact bytes");
      if (!prior) await store.put(outboxPath(idHex), exact.slice(), { ifNoneMatch: "*" });
      // 回读是 persist-before-send 的提交门禁，Provider 未可靠提交时不得返回。
      const committed = await store.get(outboxPath(idHex));
      if (!committed || !equal(committed.bytes, exact)) throw new Error("BitFS outbox 持久化校验失败");
      await writeRecord({
        idHex: assertId(idHex), role,
        checkpointPresent: existing?.checkpointPresent ?? false,
        outboxKind: validated.kind,
        outboxState: existing?.outboxState ?? "prepared",
        updatedAt: iso(nowMs),
      });
      return committed.bytes.slice();
    },
    async markOutbound(idHex, state, nowMs) {
      const record = await readRecord(idHex);
      if (!record?.outboxKind) throw new Error("BitFS outbox 尚未准备");
      await writeRecord({ ...record, outboxState: state, updatedAt: iso(nowMs) });
    },
    async restoreOutbound(idHex) {
      const object = await store.get(outboxPath(idHex));
      return object ? parse(object.bytes) : undefined;
    },
    getRecord: readRecord,
  };
}

function parseRecord(value: unknown, expectedId: string): BitfsJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BitFS journal 索引格式错误");
  const row = value as Record<string, unknown>;
  const keys = ["format", "version", "idHex", "role", "checkpointPresent", "outboxKind", "outboxState", "updatedAt"];
  if (Object.keys(row).some((key) => !keys.includes(key)) || row.format !== RECORD_FORMAT || row.version !== RECORD_VERSION || row.idHex !== assertId(expectedId)) throw new Error("BitFS journal 索引格式错误");
  if ((row.role !== "buyer" && row.role !== "seller") || typeof row.checkpointPresent !== "boolean") throw new Error("BitFS journal 索引字段错误");
  const outboxKind = row.outboxKind === undefined ? undefined : Number(row.outboxKind);
  if (outboxKind !== undefined && (!Number.isInteger(outboxKind) || outboxKind < 1 || outboxKind > 11)) throw new Error("BitFS journal Kind 错误");
  const states = ["prepared", "sent", "result-unknown", "confirmed"];
  if (row.outboxState !== undefined && !states.includes(String(row.outboxState))) throw new Error("BitFS journal 状态错误");
  const updatedAt = String(row.updatedAt);
  if (!Number.isFinite(Date.parse(updatedAt)) || new Date(Date.parse(updatedAt)).toISOString() !== updatedAt) throw new Error("BitFS journal 时间错误");
  return {
    idHex: expectedId,
    role: row.role,
    checkpointPresent: row.checkpointPresent,
    ...(outboxKind === undefined ? {} : { outboxKind: outboxKind as WireKind }),
    ...(row.outboxState === undefined ? {} : { outboxState: row.outboxState as BitfsJournalRecord["outboxState"] }),
    updatedAt,
  };
}

function assertId(value: string): string { if (!ID_PATTERN.test(value)) throw new TypeError("BitFS journal ID 必须是 32 字节小写 hex"); return value; }
function assertNonempty(value: Uint8Array, field: string): void { if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new TypeError(`BitFS ${field} 不能为空`); }
function iso(nowMs: number): string { if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new TypeError("BitFS journal 时间不合法"); return new Date(nowMs).toISOString(); }
function equal(left: Uint8Array, right: Uint8Array): boolean { return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]); }
