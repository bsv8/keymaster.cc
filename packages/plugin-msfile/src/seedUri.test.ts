import { expect, it } from "vitest";
import { parseSeedUri } from "./seedUri.js";
it("only accepts explicit Seed URIs and keeps private-key-like bare text unmatched", () => {
 const hash = "ab".repeat(32);
 expect(parseSeedUri(`msfile://seed/${hash}`)).toBe(hash);
 for (const input of [hash, `msfile://seed/${hash}?buy=true`, `msfile://seed/${hash}/extra`, `https://seed/${hash}`, `msfile://seed/bad`]) expect(parseSeedUri(input)).toBeUndefined();
});
