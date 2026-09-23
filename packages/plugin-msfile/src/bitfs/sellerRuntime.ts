// BitFS 卖方请求匹配核心；不包含 React、Channel provider 或 libp2p host。
// 输入必须是 ChannelProtocol 产出的 VerifiedHashRequest。

import { isVerifiedHashRequest, dedupKey, type VerifiedHashRequest } from "bsv8-channel-protocol/hash-request";
import type { MsFileSellerSettings } from "@keymaster/contracts";
import { createSellerQuote, type Signer } from "go-bitfs";
import type { BitfsJournal } from "./journal.js";
import type { BitfsSeedIndex } from "./seedIndex.js";
import { bitfsWorkflowFacts } from "./sdk.js";
import { deriveSupplierPeerId, normalizeSupplierAddress } from "../supplierConfig.js";

export interface BitfsSellerMatch {
  /** Channel 去重键。 */
  requestKey: string;
  /** 已通过白名单与身份 pin 的规范 multiaddr。 */
  addresses: string[];
  /** 已持久化、可以交给 BitFS stream 的 exact Kind 1 bytes。 */
  quoteBytes: Uint8Array;
  /** 报价绑定的 Seed Hash。 */
  seedHashHex: string;
}

export interface BitfsSellerRuntimeDeps {
  /** 当前 Key 的受限签名端口；SDK 纯步骤函数不持有该端口。 */
  signer: Signer;
  /** 当前 generation 的可用 Seed 索引。 */
  index: BitfsSeedIndex;
  /** persist-before-send journal。 */
  journal: BitfsJournal;
  /** 返回当前卖方设置。 */
  settings(): Readonly<MsFileSellerSettings>;
  /** 显式可信时钟；SDK 与运行单元都不自行拥有时钟。 */
  nowMs(): number;
  /** 是否允许 loopback 明文 WS；只可由开发环境显式开启。 */
  allowLoopbackWs?: boolean;
}

export class BitfsSellerRuntime {
  private readonly seen = new Map<string, number>();
  constructor(private readonly deps: BitfsSellerRuntimeDeps) {}

  /**
   * 命中完整 Seed 且存在兼容 locator 时生成确定报价；未命中保持静默。
   * `webrtc-sdp` 会被明确忽略，不会当作 WebRTC Direct。
   */
  async match(request: VerifiedHashRequest, signal?: AbortSignal): Promise<BitfsSellerMatch | null> {
    if (!isVerifiedHashRequest(request)) throw new TypeError("卖方只接受 VerifiedHashRequest");
    const nowMs = this.deps.nowMs();
    this.prune(nowMs);
    const settings = this.deps.settings();
    if (!settings.sellerEnabled || request.expires_at_ms <= nowMs) return null;
    const dedup = dedupKey(request);
    const key = `${dedup.from_public_key}\0${dedup.message_id}`;
    if (this.seen.has(key)) return null;
    this.seen.set(key, request.expires_at_ms);
    const seed = this.deps.index.get(request.body.hash);
    if (!seed || seed.availability !== "available") return null;
    if (signal?.aborted) throw new DOMException("销售请求已取消", "AbortError");
    const expectedPeerId = deriveSupplierPeerId(request.from_public_key);
    const addresses: string[] = [];
    for (const locator of request.body.locators) {
      if (locator.kind !== "multiaddr") continue; // webrtc-sdp 不是 WebRTC Direct。
      const parsed = normalizeSupplierAddress(locator.address, expectedPeerId, { allowLoopbackWs: this.deps.allowLoopbackWs === true });
      if (parsed.ok && !addresses.includes(parsed.value.normalized)) addresses.push(parsed.value.normalized);
    }
    if (addresses.length === 0) return null;
    const quote = await createSellerQuote(bitfsWorkflowFacts(nowMs), this.deps.signer, {
      seedHash: hexToBytes(request.body.hash),
      buyerPublicKey: hexToBytes(request.from_public_key),
      seedPriceSatoshis: BigInt(settings.seedPriceSatoshis),
      fullBlockPriceSatoshis: BigInt(settings.fullBlockPriceSatoshis),
      fileSizeBytes: BigInt(seed.fileSizeBytes),
      quoteExpiresAtUnixSeconds: BigInt(Math.floor((nowMs + settings.quoteLifetimeSeconds * 1_000) / 1_000)),
      supportedArbiterPublicKeys: settings.supportedArbiterPublicKeys.map(hexToBytes),
      recommendedFilename: seed.fileName,
    });
    const journalId = await requestJournalId(request);
    const quoteBytes = await this.deps.journal.prepareOutbound(journalId, "seller", quote.outbound, nowMs);
    return { requestKey: key, addresses, quoteBytes, seedHashHex: request.body.hash };
  }

  clear(): void { this.seen.clear(); }
  private prune(nowMs: number): void { for (const [key, expiresAt] of this.seen) if (expiresAt <= nowMs) this.seen.delete(key); }
}

async function requestJournalId(request: VerifiedHashRequest): Promise<string> {
  const bytes = new TextEncoder().encode(`${request.from_public_key}\0${request.message_id}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0) throw new TypeError("hex 字段不合法");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
