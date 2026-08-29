import { describe, expect, it } from "vitest";
import { createMsFileMediaSession } from "./session.js";

function input() {
  return {
    seedHashHex: "aa".repeat(32),
    supplierPublicKeyHex: `02${"11".repeat(32)}`,
    fileSizeBytes: 0n,
    declaredMediaType: "video/mp4",
    reader: {
      readSeed: async () => new Uint8Array(),
      readBlock: async () => new Uint8Array(),
    },
  };
}

describe("MsFileMediaSession Debug", () => {
  it("默认开启且只记录脱敏的有界状态字段", async () => {
    const session = createMsFileMediaSession(input());
    const snapshot = session.snapshot();

    expect(snapshot.debug.enabled).toBe(true);
    expect(snapshot.debug.entries[0]).toMatchObject({
      sequence: 1,
      scope: "session",
      action: "created",
      details: {
        fileSizeBytes: 0,
        declaredMediaType: "video/mp4",
      },
    });
    expect(JSON.stringify(snapshot.debug.entries)).not.toContain("11".repeat(32));
    expect(JSON.stringify(snapshot.debug.entries)).not.toContain("aa".repeat(32));
    await session.dispose();
  });

  it("显式关闭时不产生诊断记录", async () => {
    const session = createMsFileMediaSession(input(), { debug: false });
    expect(session.snapshot().debug).toEqual({ enabled: false, entries: [] });
    await session.dispose();
  });
});
