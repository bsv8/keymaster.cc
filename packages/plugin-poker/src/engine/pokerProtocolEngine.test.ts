// packages/plugin-poker/src/engine/pokerProtocolEngine.test.ts
// 验证发现链路：
//   1. tryParsePresence / tryParseTable 能正确解析 bsv-poker 风格 JSON；
//   2. PokerProtocolEngine.handleFrame 在 bsvp/presence / bsvp/dir topic
//      上把 payload 解析后触发 hooks；
//   3. table close（members === -1）被识别成 isClose=true；
//   4. 损坏 JSON / 缺字段不会 throw（fail-safe）。

import { describe, expect, it } from "vitest";
import { PokerProtocolEngine, POKER_DISCOVERY_TOPICS, tryParsePresence, tryParseTable } from "./pokerProtocolEngine.js";
import { BsvEncoding } from "../tsstack/adapter.js";

const MY_PUB = BsvEncoding.fromHex("02" + "ab".repeat(32));

describe("pokerProtocolEngine: discovery wire-format", () => {
  it("tryParsePresence parses C# PresenceJson layout", () => {
    const json = JSON.stringify({
      playerId: "02CAFE" + "00".repeat(31), // upper-case in input
      addr: "1.2.3.4:8080",
      handle: "alice",
      sig: "deadbeef"
    });
    const got = tryParsePresence(new TextEncoder().encode(json));
    expect(got).not.toBeNull();
    expect(got?.playerId).toBe("02cafe" + "00".repeat(31)); // lowercased
    expect(got?.addr).toBe("1.2.3.4:8080");
    expect(got?.handle).toBe("alice");
  });

  it("tryParseTable handles open table", () => {
    const json = JSON.stringify({
      id: "t-deadbeef~TexasHoldem~p4",
      name: "Friday Night",
      members: 4,
      pub: "02cafe" + "00".repeat(31),
      sig: "ff"
    });
    const got = tryParseTable(new TextEncoder().encode(json));
    expect(got).not.toBeNull();
    expect(got?.id).toBe("t-deadbeef~TexasHoldem~p4");
    expect(got?.members).toBe(4);
    expect(got?.isClose).toBe(false);
  });

  it("tryParseTable recognises members === -1 as close", () => {
    const json = JSON.stringify({ id: "t-x", name: "n", members: -1, pub: "", sig: "" });
    const got = tryParseTable(new TextEncoder().encode(json));
    expect(got?.isClose).toBe(true);
  });

  it("tryParsePresence returns null on broken JSON or missing playerId", () => {
    expect(tryParsePresence(new TextEncoder().encode("{not json"))).toBeNull();
    expect(tryParsePresence(new TextEncoder().encode(JSON.stringify({ addr: "x" })))).toBeNull();
  });

  it("handleFrame routes bsvp/presence to onPresenceFrame hook", () => {
    const seen: any[] = [];
    const engine = new PokerProtocolEngine({
      hooks: { onPresenceFrame: (p) => seen.push(p) }
    });
    engine.setContext({ myPub33: MY_PUB });
    const payload = new TextEncoder().encode(JSON.stringify({
      playerId: "03ff" + "00".repeat(31),
      addr: "5.6.7.8:9090",
      handle: "bob",
      sig: ""
    }));
    // proxy 内部协议 topic 是无前导空格；与 SessionRegistry 精确匹配。
    engine.handleFrame(POKER_DISCOVERY_TOPICS.Presence, payload);
    expect(seen.length).toBe(1);
    expect(seen[0].playerId).toBe("03ff" + "00".repeat(31));
  });

  it("handleFrame ignores legacy leading-space topic (no trim heuristic)", () => {
    const seen: any[] = [];
    const engine = new PokerProtocolEngine({
      hooks: { onPresenceFrame: (p) => seen.push(p) }
    });
    engine.setContext({ myPub33: MY_PUB });
    const payload = new TextEncoder().encode(JSON.stringify({ playerId: "02aa" + "00".repeat(31), addr: "x", handle: "", sig: "" }));
    engine.handleFrame(" bsvp/presence", payload);
    expect(seen.length).toBe(0);
  });

  it("handleFrame routes bsvp/dir to onTableFrame hook including close signal", () => {
    const seen: any[] = [];
    const engine = new PokerProtocolEngine({
      hooks: { onTableFrame: (p) => seen.push(p) }
    });
    engine.setContext({ myPub33: MY_PUB });
    const open = new TextEncoder().encode(JSON.stringify({ id: "t-1", name: "n", members: 2, pub: "", sig: "" }));
    const close = new TextEncoder().encode(JSON.stringify({ id: "t-1", name: "n", members: -1, pub: "", sig: "" }));
    engine.handleFrame(POKER_DISCOVERY_TOPICS.Dir, open);
    engine.handleFrame(POKER_DISCOVERY_TOPICS.Dir, close);
    expect(seen.length).toBe(2);
    expect(seen[0].isClose).toBe(false);
    expect(seen[1].isClose).toBe(true);
  });

  it("handleFrame on tableId topic also parses table announce (proxy duplicates publish)", () => {
    const seen: any[] = [];
    const engine = new PokerProtocolEngine({
      hooks: { onTableFrame: (p) => seen.push(p) }
    });
    engine.setContext({ myPub33: MY_PUB });
    const open = new TextEncoder().encode(JSON.stringify({ id: "t-abc", name: "n", members: 3, pub: "", sig: "" }));
    engine.handleFrame("t-abc", open);
    expect(seen.length).toBe(1);
    expect(seen[0].id).toBe("t-abc");
  });

  it("handleFrame silently ignores bsvp/dir? signal frames", () => {
    const seen: any[] = [];
    const engine = new PokerProtocolEngine({
      hooks: { onTableFrame: (p) => seen.push(p) }
    });
    engine.setContext({ myPub33: MY_PUB });
    engine.handleFrame(POKER_DISCOVERY_TOPICS.DirQuery, new Uint8Array(0));
    expect(seen.length).toBe(0);
  });
});
