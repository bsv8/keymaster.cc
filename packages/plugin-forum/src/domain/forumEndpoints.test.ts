import { describe, expect, it } from "vitest";

import type { ForumEndpointConfig } from "@keymaster/contracts";

import { normalizeEndpoint } from "./forumService.js";

const PEER = "12D3KooWExamplePeerIdForTestsOnly000000000000000000";

function endpoint(overrides: Partial<ForumEndpointConfig> & Pick<ForumEndpointConfig, "kind" | "url">): ForumEndpointConfig {
  return { ...overrides } as ForumEndpointConfig;
}

describe("连接地址校验", () => {
  it("HTTPS 只接受 https:// 地址", () => {
    expect(normalizeEndpoint(endpoint({ kind: "https", url: "https://forum.example/roundtrip" })).url).toBe("https://forum.example/roundtrip");
    // 明文 http 不是 HTTPS 入口。
    expect(() => normalizeEndpoint(endpoint({ kind: "https", url: "http://forum.example/roundtrip" }))).toThrow(/https:\/\//);
    expect(() => normalizeEndpoint(endpoint({ kind: "https", url: "not a url" }))).toThrow(/不合法/);
  });

  it("WSS 接受完整 multiaddr，并拒绝 URL 形态", () => {
    const parsed = normalizeEndpoint(endpoint({ kind: "libp2p-wss", url: `/dns4/forum.example/tcp/443/wss/p2p/${PEER}` }));
    expect(parsed.kind).toBe("libp2p-wss");
    expect(parsed.url.startsWith("/dns4/forum.example/tcp/443/wss")).toBe(true);
    // 这正是回归点：`wss://host` 过不了 multiaddr()，必须在这里就失败而不是拨号时。
    expect(() => normalizeEndpoint(endpoint({ kind: "libp2p-wss", url: "wss://forum.example" }))).toThrow(/multiaddr/);
  });

  it("WSS 必须带 /wss 与 /p2p 分量，且不能混进 webrtc-direct", () => {
    expect(() => normalizeEndpoint(endpoint({ kind: "libp2p-wss", url: `/dns4/forum.example/tcp/443/p2p/${PEER}` }))).toThrow(/\/wss/);
    expect(() => normalizeEndpoint(endpoint({ kind: "libp2p-wss", url: "/dns4/forum.example/tcp/443/wss" }))).toThrow(/\/p2p/);
    expect(() =>
      normalizeEndpoint(endpoint({ kind: "libp2p-wss", url: `/dns4/forum.example/tcp/443/wss/webrtc-direct/p2p/${PEER}` })),
    ).toThrow(/不同 transport/);
  });

  it("WebRTC Direct 必须是带 certhash 的完整 multiaddr", () => {
    const url = `/ip4/203.0.113.7/udp/4000/webrtc-direct/certhash/uEiDDq4_x1Ny7Zh6G7_POmGBH3va8I3nbG4c0Tx0G7wRqY9o/p2p/${PEER}`;
    const parsed = normalizeEndpoint(endpoint({ kind: "webrtc-direct", url, peerId: PEER, certhash: "uEiD" }));
    expect(parsed.kind).toBe("webrtc-direct");
    expect(parsed.url).toContain("/webrtc-direct/certhash/");
    // 旧形态 `webrtc-direct://host` 不是 multiaddr。
    expect(() => normalizeEndpoint(endpoint({ kind: "webrtc-direct", url: "webrtc-direct://forum.example" }))).toThrow(/multiaddr/);
    // 缺 certhash 时 SDK 无法做 Direct 认证，必须拒绝而不是猜一个。
    expect(() =>
      normalizeEndpoint(endpoint({ kind: "webrtc-direct", url: `/ip4/203.0.113.7/udp/4000/webrtc-direct/p2p/${PEER}` })),
    ).toThrow(/certhash/);
  });

  it("校验后的 multiaddr 可以真正被 multiaddr() 解析", async () => {
    // 这是回归测试的核心：校验通过就必须能拨号。
    const { multiaddr } = await import("@multiformats/multiaddr");
    for (const url of [
      `/dns4/forum.example/tcp/443/wss/p2p/${PEER}`,
      `/ip4/203.0.113.7/udp/4000/webrtc-direct/certhash/uEiDDq4_x1Ny7Zh6G7_POmGBH3va8I3nbG4c0Tx0G7wRqY9o/p2p/${PEER}`,
    ]) {
      const kind = url.includes("/wss") ? "libp2p-wss" : "webrtc-direct";
      const normalized = normalizeEndpoint(endpoint({ kind: kind as ForumEndpointConfig["kind"], url }));
      expect(() => multiaddr(normalized.url)).not.toThrow();
      expect(() => multiaddr(normalized.url).getComponents().some((component) => component.name === "p2p")).not.toThrow();
    }
  });
});