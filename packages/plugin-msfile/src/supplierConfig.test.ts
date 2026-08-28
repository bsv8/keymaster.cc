// packages/plugin-msfile/src/supplierConfig.test.ts
// 供应商公钥 / PeerId / multiaddr 三重校验与规范化。

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADDRESS_POLICY,
  deriveSupplierPeerId,
  normalizeSupplierAddress,
  normalizeSupplierDraft,
} from "./supplierConfig.js";

export const SUPPLIER_PUBKEY = "035f3d296df6e017c017270bfc0293dc7d197ff9e04a25c096260420644d86d21a";
export const SUPPLIER_PEER_ID = "16Uiu2HAmK4mB2kfxPQBajorRZo6sEgp9UXteN9Voi27u2RxTzma9";
export const OWNER_PUBKEY = "02b6de0e542ca933c790eb27e7d759abf2947233552fd0f942c4cd391186286e72";

describe("deriveSupplierPeerId", () => {
  it("derives the libp2p PeerId from a compressed secp256k1 public key", () => {
    expect(deriveSupplierPeerId(SUPPLIER_PUBKEY)).toBe(SUPPLIER_PEER_ID);
  });

  it("rejects malformed or off-curve keys", () => {
    expect(() => deriveSupplierPeerId("04" + SUPPLIER_PUBKEY.slice(2))).toThrow();
    expect(() => deriveSupplierPeerId(SUPPLIER_PUBKEY.slice(2))).toThrow();
    // 未压缩前缀 04 不被接受。
    expect(() => deriveSupplierPeerId("04aa")).toThrow();
  });
});

describe("normalizeSupplierAddress", () => {
  it("accepts webrtc-direct with matching peer and certhash", () => {
    const address = `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/p2p/${SUPPLIER_PEER_ID}`;
    const result = normalizeSupplierAddress(address, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY);
    expect(result.ok).toBe(true);
  });

  it("requires /certhash on webrtc-direct", () => {
    const address = `/ip4/127.0.0.1/udp/4001/webrtc-direct/p2p/${SUPPLIER_PEER_ID}`;
    const result = normalizeSupplierAddress(address, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY);
    expect(!result.ok && result.message).toMatch(/certhash/iu);
  });

  it("requires a UDP port and rejects DNS Direct without a trusted resolver", () => {
    const missingUdp = `/ip4/127.0.0.1/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/p2p/${SUPPLIER_PEER_ID}`;
    const missingUdpResult = normalizeSupplierAddress(missingUdp, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY);
    expect(missingUdpResult.ok).toBe(false);
    if (!missingUdpResult.ok) expect(missingUdpResult.message).toMatch(/ERR_WEBRTC_DIRECT_ADDRESS/u);

    const dnsDirect = `/dns4/nas.example.com/udp/4001/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/p2p/${SUPPLIER_PEER_ID}`;
    const dnsResult = normalizeSupplierAddress(dnsDirect, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY);
    expect(dnsResult).toMatchObject({ ok: false, message: expect.stringMatching(/trusted resolver/u) });
  });

  it("accepts tls/ws and rejects plain public ws", () => {
    const wss = `/dns4/proxy.example.com/tcp/443/tls/ws/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(wss, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY).ok).toBe(true);
    const plainPublic = `/dns4/proxy.example.com/tcp/80/ws/p2p/${SUPPLIER_PEER_ID}`;
    const result = normalizeSupplierAddress(plainPublic, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY);
    // dns 名称的裸 ws 在序列检查即被拒（仅 ip4/ip6 loopback 允许）。
    expect(!result.ok && result.message).toMatch(/exactly|loopback/);
  });

  it("allows loopback ws only when the dev policy is enabled", () => {
    const loopback = `/ip4/127.0.0.1/tcp/8080/ws/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(loopback, SUPPLIER_PEER_ID, { allowLoopbackWs: false }).ok).toBe(false);
    expect(normalizeSupplierAddress(loopback, SUPPLIER_PEER_ID, { allowLoopbackWs: true }).ok).toBe(true);
  });

  it("rejects mismatched /p2p peer ids", () => {
    const address = `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/p2p/${OWNER_PUBKEY}`;
    const result = normalizeSupplierAddress(address, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY);
    expect(!result.ok && result.message).toMatch(/does not match/);
  });

  it("rejects unsupported transports like quic or tcp-only addresses", () => {
    const quic = `/ip4/10.0.0.1/udp/4001/quic-v1/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(quic, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY).ok).toBe(false);
    const tcpOnly = `/ip4/10.0.0.1/tcp/4001/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(tcpOnly, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY).ok).toBe(false);
  });

  it("rejects malformed transport sequences（审查修复）", () => {
    // 混合 transport：tcp/tls 之后又插 udp 再 ws。
    const mixed = `/dns4/proxy.example.com/tcp/443/tls/udp/4001/ws/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(mixed, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY)).toMatchObject({ ok: false });
    // webrtc-direct 后面再挂 tls/ws。
    const hybrid = `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/tcp/443/tls/ws/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(hybrid, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY)).toMatchObject({ ok: false });
    // certhash 摘要被截断（uEiBAD 解码后不是 sha256/32）。
    const shortCert = `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uEiBAD/p2p/${SUPPLIER_PEER_ID}`;
    const shortResult = normalizeSupplierAddress(shortCert, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY);
    expect(shortResult.ok).toBe(false);
    if (!shortResult.ok) expect(shortResult.message).toMatch(/ERR_WEBRTC_DIRECT_CERTHASH/u);
    // 非 sha256 multihash code（0x00 identity）。
    const wrongCode = `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uAAiECJcqEQZmPj5Z3Sko8HcOyBhtttmX_cRcpw5cL6zVVEA/p2p/${SUPPLIER_PEER_ID}`;
    const wrongCodeResult = normalizeSupplierAddress(wrongCode, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY);
    expect(wrongCodeResult.ok).toBe(false);
    if (!wrongCodeResult.ok) expect(wrongCodeResult.message).toMatch(/ERR_WEBRTC_DIRECT_CERTHASH/u);
    // 组件顺序颠倒：certhash 在 webrtc-direct 之前。
    const reordered = `/ip4/127.0.0.1/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/udp/4001/webrtc-direct/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(reordered, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY).ok).toBe(false);
    // 端口非法 / 端口 0（审查修复：远端地址限定 1..65535）。
    const badPort = `/dns4/proxy.example.com/tcp/notaport/tls/ws/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(badPort, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY).ok).toBe(false);
    const zeroPort = `/dns4/proxy.example.com/tcp/0/tls/ws/p2p/${SUPPLIER_PEER_ID}`;
    expect(normalizeSupplierAddress(zeroPort, SUPPLIER_PEER_ID, DEFAULT_ADDRESS_POLICY).ok).toBe(false);
  });
});

describe("normalizeSupplierDraft", () => {
  const validAddress = `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uEiDu8SJ7IdK9W_PfRJfV0clhOP6mG0zNXcZQ8bBhC9ipwg/p2p/${SUPPLIER_PEER_ID}`;

  it("normalizes a full draft with lower-cased key and ordered addresses", () => {
    const result = normalizeSupplierDraft({
      name: "  Home NAS  ",
      supplierPublicKeyHex: SUPPLIER_PUBKEY.toUpperCase().replace(/^03/, "03"),
      addresses: [validAddress, validAddress],
      enabled: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.name).toBe("Home NAS");
      expect(result.config.addresses).toEqual([validAddress]);
      expect(result.peerId).toBe(SUPPLIER_PEER_ID);
    }
  });

  it("reports field-level failures", () => {
    function reason(draft: unknown): string {
      const result = normalizeSupplierDraft(draft);
      return result.ok ? "" : result.failure.reason;
    }
    expect(reason({ ...base(), name: "" })).toBe("name");
    expect(reason({ ...base(), supplierPublicKeyHex: "zz" })).toBe("public-key");
    expect(reason({ ...base(), addresses: [] })).toBe("address");
    expect(reason({ ...base(), enabled: "yes" })).toBe("enabled");
    expect(reason(null)).toBe("name");

    function base() {
      return { name: "nas", supplierPublicKeyHex: SUPPLIER_PUBKEY, addresses: [validAddress], enabled: true };
    }
  });
});
