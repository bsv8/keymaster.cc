import { describe, expect, it } from "vitest";
import { binary, binaryBytes, binaryText, binaryToText } from "./binary.js";

describe("binary helpers", () => {
  it("copies caller bytes into an explicit BinaryField", () => {
    const source = new Uint8Array([1, 2, 3]);
    const field = binary(source, "application/octet-stream");
    source[0] = 9;
    expect([...binaryBytes(field)]).toEqual([1, 2, 3]);
    expect(field).toMatchObject({ $type: "binary", mime: "application/octet-stream" });
  });

  it("round-trips UTF-8 text", () => {
    expect(binaryToText(binaryText("Keymaster · 密钥"))).toBe("Keymaster · 密钥");
  });
});
