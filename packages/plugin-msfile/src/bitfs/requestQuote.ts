import { inspectContentRequestReference, inspectFileQuoteReference } from "go-bitfs";
import type { BitfsSessionJournal, BitfsSessionRecord } from "./sessionJournal.js";

/** 逐请求保存的报价是恢复依据；旧已签记录只回读当时的原始开池报价。 */
export async function readBitfsRequestQuote(sessions: BitfsSessionJournal, sessionId: string, authorizationId: string): Promise<Uint8Array> {
  const raw = await sessions.getEvidence(sessionId, `kind1-request-quote-${authorizationId}`)
    ?? await sessions.getEvidence(sessionId, "kind1-quote");
  if (!raw) throw new Error("BitFS 请求缺少原始报价证据");
  return raw;
}

/** 引用只用于定位，返回前不将其当成有效授权。调用者必须在读取正文前
 * 把候选报价、池和 exact Kind 5 一起交给 SDK 做完整验证。 */
export async function findBitfsSellerRequestQuote(sessions: BitfsSessionJournal, poolRecord: BitfsSessionRecord, rawKind5: Uint8Array) {
  const reference = inspectContentRequestReference(rawKind5);
  const id = hex(reference.fileQuoteTermsID);
  for (const record of await sessions.list()) {
    if (record.role !== "seller" || record.ownerPublicKeyHex !== poolRecord.ownerPublicKeyHex
      || record.counterpartyPublicKeyHex !== poolRecord.counterpartyPublicKeyHex) continue;
    const raw = await sessions.getEvidence(record.sessionId, "kind1-quote");
    if (raw && hex(inspectFileQuoteReference(raw)) === id) return { raw, seedHashHex: record.seedHashHex };
  }
  throw new Error("BitFS 请求引用了未持有的原始报价");
}
const hex = (raw: Uint8Array) => Array.from(raw, byte => byte.toString(16).padStart(2, "0")).join("");
