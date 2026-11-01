import { inspectFileQuoteEvidence, inspectPoolArtifactReference } from "bitfs-protocol";
import { IncrementalSha256 } from "../sha256.js";
import type { Pool } from "keymaster-trade-scheduler";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";

const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");

/** 内核池 ID 的持久日志地址；与报价、物理连接及后续请求报价无关。 */
export function schedulerPoolSessionId(poolId: string): string {
  const hash = new IncrementalSha256();
  hash.update(new TextEncoder().encode(poolId));
  return `pool-${hex(hash.digest())}`;
}

/** 新池按独立地址恢复；旧已开池仍使用原日志，不能迁移或丢弃签名责任。 */
export async function readSchedulerPoolSessionId(sessions: BitfsSessionJournal, pool: Pool): Promise<string> {
  const id = schedulerPoolSessionId(pool.id);
  if (await sessions.get(id)) return id;
  if (pool.openingObserved && (await sessions.get(pool.sessionId))?.evidence.includes("kind2-opening-request")) return pool.sessionId;
  return id;
}

/** 只用 wire 引用寻找候选日志。后续真实协议继续验证角色、签名、金额和历史状态。
 * 允许报价连接重建，但绝不按“最近一个池”猜归属。 */
export async function findBuyerPoolResponseSession(input: {
  sessions: BitfsSessionJournal; raw: Uint8Array; owner: string; counterparty: string; seed: string;
}): Promise<string> {
  const ref = inspectPoolArtifactReference(input.raw);
  const candidates: string[] = [];
  for (const record of await input.sessions.list()) {
    if (record.role !== "buyer" || record.ownerPublicKeyHex !== input.owner
      || record.counterpartyPublicKeyHex !== input.counterparty || record.seedHashHex !== input.seed) continue;
    if (ref.paymentAuthorizationID) {
      if (await input.sessions.getEvidence(record.sessionId, `kind5-content-request-${hex(ref.paymentAuthorizationID)}`)) candidates.push(record.sessionId);
    } else if (ref.refundTemplateTxID) {
      const raw = await input.sessions.getEvidence(record.sessionId, "kind2-opening-request");
      if (raw && hex(inspectPoolArtifactReference(raw).refundTemplateTxID!) === hex(ref.refundTemplateTxID)) candidates.push(record.sessionId);
    }
  }
  if (candidates.length !== 1) throw new Error("BitFS 响应没有唯一的本地池责任归属");
  return candidates[0]!;
}

/** 恢复旧池所需的文件与角色事实来自历史 exact 报价，不重新判断购买有效期。
 * 新请求仍由真正的请求步骤检验当前报价资格。 */
export async function readPoolQuoteContext(sessions: BitfsSessionJournal, sessionId: string) {
  const raw = await sessions.getEvidence(sessionId, "kind1-quote");
  if (!raw) throw new Error("BitFS 费用池缺少原始报价证据");
  const quote = inspectFileQuoteEvidence(raw);
  return { fileSizeBytes: quote.terms.fileSizeBytes.toString(10), recommendedFilename: quote.terms.recommendedFilename,
    supportedArbiterPublicKeys: quote.terms.supportedArbiterPublicKeys.map(hex) };
}

/** 已验签的报价仅作开池原始来源，复制到独立池日志后不再覆盖。 */
export async function createSchedulerPoolSession(input: {
  sessions: BitfsSessionJournal; poolId: string; quoteSessionId: string; nowMs: number;
}): Promise<BitfsSessionRecord> {
  const id = schedulerPoolSessionId(input.poolId);
  const existing = await input.sessions.get(id);
  const source = await input.sessions.get(input.quoteSessionId);
  if (!source || source.role !== "buyer") throw new Error("BitFS 开池缺少报价来源");
  let record = existing ?? await input.sessions.create({ sessionId: id, role: "buyer", ownerPublicKeyHex: source.ownerPublicKeyHex,
    counterpartyPublicKeyHex: source.counterpartyPublicKeyHex, seedHashHex: source.seedHashHex,
    generation: source.generation, phase: "quote-selected" }, input.nowMs);
  for (const name of ["kind1-quote", "quote-summary"] as const) {
    const bytes = await input.sessions.getEvidence(source.sessionId, name);
    if (bytes && !record.evidence.includes(name)) record = await input.sessions.putEvidence(id, record.revision, name, bytes, input.nowMs);
    else if (!bytes && name === "kind1-quote") throw new Error("BitFS 开池缺少 exact 报价");
  }
  return record;
}
