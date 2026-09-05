// packages/plugin-msfile/src/supplierConfig.ts
// 供应商配置 pure normalizer 与 PeerId pin 校验（施工单 §3.3 / network 规范 §4）。
//
// 校验规则（审查修复后）：
//   - 公钥必须是 33 字节压缩 secp256k1 公钥的 66 字符小写 hex；
//   - 每个地址按**精确组件序列**匹配，禁止混合 transport：
//       webrtc-direct : [ip4|ip6 <host>] /udp/<port>/webrtc-direct/certhash/<mh>/p2p/<peer>
//       tls/ws (WSS)  : [dns|dns4|dns6|ip4|ip6 <host>] tcp/<port> tls ws p2p/<peer>
//       loopback ws   : [ip4 127.0.0.1 | ip6 ::1] tcp/<port> ws p2p/<peer>   （仅开发策略）
//   - WebRTC Direct 的完整 endpoint、certhash、UDP 端口和 PeerId pin 由
//     bitcoin-libp2p/webrtc-direct 统一校验；当前浏览器没有受信 DNS resolver，
//     因此 Direct 只接受 ip4/ip6，dns* 仅保留给 WSS；
//   - `/wss` 输入可接受（解析器等价 /tls/ws），持久化输出规范形态；
//   - name 只是本地显示值；编辑时不允许原地更换供应商公钥。

import { multiaddr } from "@multiformats/multiaddr";
import { hexToBytes, peerIdFromPublicKeyBytes, publicKeyFromPeerId } from "bitcoin-libp2p/identity";
import { parseWebRTCDirectEndpoint, WebRTCDirectError } from "bitcoin-libp2p/webrtc-direct";
import { isValidMsFileSupplierPublicKeyHex } from "@keymaster/contracts";
import type { MsFileSupplierConfig } from "@keymaster/contracts";

export const MSFILE_MAX_SUPPLIER_NAME_BYTES = 200;
export const MSFILE_MAX_ADDRESSES_PER_SUPPLIER = 16;

/** loopback `ws` 只用于本机开发；生产策略默认关闭。 */
export interface SupplierAddressPolicy {
  allowLoopbackWs: boolean;
}

export const DEFAULT_ADDRESS_POLICY: SupplierAddressPolicy = { allowLoopbackWs: false };

export interface NormalizedSupplierConfig {
  name: string;
  supplierPublicKeyHex: string;
  addresses: string[];
  enabled: boolean;
}

export type NormalizeSupplierFailure =
  | { reason: "name"; message: string }
  | { reason: "public-key"; message: string }
  | { reason: "address"; message: string }
  | { reason: "enabled"; message: string };

export type NormalizeSupplierResult =
  | { ok: true; config: NormalizedSupplierConfig; peerId: string }
  | { ok: false; failure: NormalizeSupplierFailure };

/** 从压缩公钥派生 libp2p PeerId。非曲线内公钥会抛错。 */
export function deriveSupplierPeerId(supplierPublicKeyHex: string): string {
  if (!isValidMsFileSupplierPublicKeyHex(supplierPublicKeyHex)) {
    throw new Error("supplier public key must be 66 lower-case hex chars starting 02 or 03");
  }
  return peerIdFromPublicKeyBytes(hexToBytes(supplierPublicKeyHex)).toString();
}

interface ParsedAddress {
  normalized: string;
  transport: "webrtc-direct" | "tls-ws" | "ws-loopback";
}

type Component = { name: string; value?: string };

const HOST_PROTOS = new Set(["dns", "dns4", "dns6", "ip4", "ip6"]);

function isLoopbackHost(proto: string | undefined, host: string | undefined): boolean {
  if (!host) return false;
  if (proto === "ip4") return host === "127.0.0.1";
  if (proto === "ip6") return host === "::1";
  return false; // dns/dns4/dns6 名称不允许裸 ws
}

function parsePort(value: string | undefined): boolean {
  // 审查修复：远端供应商端口限定 1..65535（0 为保留值，不接受）。
  if (value === undefined) return true;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 按精确组件序列校验一个 multiaddr。返回错误消息而不是异常，
 * 便于设置页逐字段展示。K-V 读回与拨号前复用本函数。
 */
export function normalizeSupplierAddress(
  input: string,
  expectedPeerId: string,
  policy: SupplierAddressPolicy
): { ok: true; value: ParsedAddress } | { ok: false; message: string } {
  let addr;
  try {
    addr = multiaddr(input.trim());
  } catch {
    return { ok: false, message: "address is not a valid multiaddr" };
  }
  const components: Component[] = addr.getComponents().map((c) => ({ name: c.name, value: c.value }));

  // 尾部必须是 p2p/<peer-id> 且与公钥派生 PeerId 一致。
  const last = components[components.length - 1];
  if (!last || last.name !== "p2p" || !last.value) {
    return { ok: false, message: "address must end with /p2p/<peer-id>" };
  }
  if (last.value !== expectedPeerId) {
    return { ok: false, message: "address /p2p/<peer-id> does not match the supplier public key" };
  }
  const body = components.slice(0, -1);

  // WebRTC Direct 的 endpoint 规范、certhash、UDP 端口和身份 pin 统一交给
  // SDK；本应用暂不提供受信 DNS resolver，所以 DNS Direct 明确拒绝。
  if (body.some((c) => c.name === "webrtc-direct")) {
    try {
      const endpoint = parseWebRTCDirectEndpoint(addr, { publicKey: publicKeyFromPeerId(expectedPeerId) });
      if (endpoint.hostType !== "ip4" && endpoint.hostType !== "ip6") {
        return { ok: false, message: "WebRTC Direct DNS addresses require a trusted resolver; use ip4/ip6 or configure WSS" };
      }
      return { ok: true, value: { normalized: endpoint.address.toString(), transport: "webrtc-direct" } };
    } catch (error) {
      if (error instanceof WebRTCDirectError) {
        return { ok: false, message: `WebRTC Direct ${error.stage} failed (${error.code})` };
      }
      return { ok: false, message: "WebRTC Direct address validation failed" };
    }
  }

  // tls/ws (WSS): <host> tcp/<port> tls ws —— 精确四段。
  const names = body.map((c) => c.name);
  if (names.includes("tls")) {
    const exact =
      body.length === 4 &&
      HOST_PROTOS.has(body[0]!.name) &&
      body[1]!.name === "tcp" && parsePort(body[1]!.value) &&
      body[2]!.name === "tls" &&
      body[3]!.name === "ws";
    if (!exact) {
      return { ok: false, message: "wss address must be exactly <host>/tcp/<port>/tls/ws/p2p/<peer-id>; mixed transports are not allowed" };
    }
    return { ok: true, value: { normalized: addr.toString(), transport: "tls-ws" } };
  }

  // 裸 ws：<host> tcp/<port> ws，仅 loopback 且开发策略开启。
  if (names.includes("ws")) {
    const exact =
      body.length === 3 &&
      (body[0]!.name === "ip4" || body[0]!.name === "ip6") &&
      body[1]!.name === "tcp" && parsePort(body[1]!.value) &&
      body[2]!.name === "ws";
    if (!exact) {
      return { ok: false, message: "plain ws address must be exactly <host>/tcp/<port>/ws/p2p/<peer-id>" };
    }
    if (!policy.allowLoopbackWs || !isLoopbackHost(body[0]!.name, body[0]!.value)) {
      return { ok: false, message: "plain ws is only allowed for loopback development addresses" };
    }
    return { ok: true, value: { normalized: addr.toString(), transport: "ws-loopback" } };
  }

  return { ok: false, message: "only webrtc-direct, tls/ws (or wss alias) and loopback ws are allowed" };
}

/**
 * 规范化一份供应商配置草稿（来自设置页表单）。
 * 输入未知来源，所有字段逐一校验；失败时给出可展示原因。
 */
export function normalizeSupplierDraft(
  draft: unknown,
  policy: SupplierAddressPolicy = DEFAULT_ADDRESS_POLICY
): NormalizeSupplierResult {
  if (typeof draft !== "object" || draft === null) {
    return { ok: false, failure: { reason: "name", message: "supplier draft must be an object" } };
  }
  const record = draft as Record<string, unknown>;

  const rawName = typeof record.name === "string" ? record.name.trim() : "";
  if (rawName.length < 1) return { ok: false, failure: { reason: "name", message: "name must not be empty" } };
  if (new TextEncoder().encode(rawName).length > MSFILE_MAX_SUPPLIER_NAME_BYTES) {
    return { ok: false, failure: { reason: "name", message: "name is too long" } };
  }

  const publicKeyHex = typeof record.supplierPublicKeyHex === "string" ? record.supplierPublicKeyHex.toLowerCase() : "";
  if (!isValidMsFileSupplierPublicKeyHex(publicKeyHex)) {
    return {
      ok: false,
      failure: { reason: "public-key", message: "public key must be 66 lower-case hex chars starting with 02 or 03" },
    };
  }

  let peerId: string;
  try {
    peerId = deriveSupplierPeerId(publicKeyHex);
  } catch (error) {
    return {
      ok: false,
      failure: { reason: "public-key", message: error instanceof Error ? error.message : "invalid public key" },
    };
  }

  const rawAddresses = Array.isArray(record.addresses) ? record.addresses : [];
  if (rawAddresses.length < 1) {
    return { ok: false, failure: { reason: "address", message: "at least one address is required" } };
  }
  if (rawAddresses.length > MSFILE_MAX_ADDRESSES_PER_SUPPLIER) {
    return { ok: false, failure: { reason: "address", message: "too many addresses" } };
  }
  const seen = new Set<string>();
  const normalizedAddresses: string[] = [];
  for (const entry of rawAddresses) {
    if (typeof entry !== "string") {
      return { ok: false, failure: { reason: "address", message: "addresses must be strings" } };
    }
    const parsed = normalizeSupplierAddress(entry, peerId, policy);
    if (!parsed.ok) return { ok: false, failure: { reason: "address", message: parsed.message } };
    if (seen.has(parsed.value.normalized)) continue;
    seen.add(parsed.value.normalized);
    normalizedAddresses.push(parsed.value.normalized);
  }

  if (typeof record.enabled !== "boolean") {
    return { ok: false, failure: { reason: "enabled", message: "enabled must be a boolean" } };
  }

  return {
    ok: true,
    peerId,
    config: {
      name: rawName,
      supplierPublicKeyHex: publicKeyHex,
      addresses: normalizedAddresses,
      enabled: record.enabled,
    },
  };
}

/**
 * K-V 读回 / 拨号前的严格复核（审查修复）：
 * 持久化记录可能来自旧版本校验或被外部改动；不合法即 fail closed。
 */
export function validatePersistedSupplier(
  config: MsFileSupplierConfig,
  policy: SupplierAddressPolicy = DEFAULT_ADDRESS_POLICY
): { ok: true } | { ok: false; message: string } {
  let peerId: string;
  try {
    peerId = deriveSupplierPeerId(config.supplierPublicKeyHex);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "invalid public key" };
  }
  if (config.addresses.length < 1) return { ok: false, message: "supplier has no addresses" };
  for (const address of config.addresses) {
    const parsed = normalizeSupplierAddress(address, peerId, policy);
    if (!parsed.ok) return { ok: false, message: `${address}: ${parsed.message}` };
  }
  return { ok: true };
}
