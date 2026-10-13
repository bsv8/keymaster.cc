import { describe, expect, it } from "vitest";
import { parseDocument, unlockDocument } from "keyhold";
import { createKeyHoldDocument, decryptKeyHoldDocument, exportPortableKeyHoldDocument, parseKeyHoldDocument, serializeKeyHoldDocument } from "./keyholdDocument.js";
describe("wallet network attachment to portable KeyHold", () => {
  it("authenticates the local network, exports a portable private key, and detects network tampering", async () => {
    const privateKey = new Uint8Array(32); privateKey[31] = 1;
    const wallet = await createKeyHoldDocument({ label: "test wallet", bsvNetwork: "test", privateKey }, "password", { iterations: 1 });
    const restored = parseKeyHoldDocument(serializeKeyHoldDocument(wallet));
    expect(restored.bsvNetwork).toBe("test");
    const opened = await decryptKeyHoldDocument(restored, "password");
    expect(opened.privateKey).toEqual(privateKey); opened.privateKey.fill(0);
    await expect(decryptKeyHoldDocument({ ...restored, bsvNetwork: "main" }, "password")).rejects.toThrow("network identity authentication");
    const portable = exportPortableKeyHoldDocument(restored);
    expect(portable).not.toContain("bsvNetwork");
    const standard = await unlockDocument(parseDocument(portable), "password");
    expect(standard.privateKey).toEqual(privateKey); standard.privateKey.fill(0); privateKey.fill(0);
    expect(() => parseKeyHoldDocument(portable)).toThrow("explicit identity upgrade");
  });
});
