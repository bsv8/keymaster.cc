import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { p2pkhAddressToScriptHex, ownedP2pkhOutputs, parseP2pkhTransaction } from "./p2pkhTransactionParser.js";

function hex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function bytes(raw: string): Uint8Array { return Uint8Array.from(raw.match(/../g)!.map((part) => Number.parseInt(part, 16))); }

function varInt(value: number): string {
  if (value < 0xfd) return value.toString(16).padStart(2, "0");
  if (value <= 0xffff) return `fd${value.toString(16).padStart(4, "0").match(/../g)!.reverse().join("")}`;
  return `fe${value.toString(16).padStart(8, "0").match(/../g)!.reverse().join("")}`;
}

function makeTransaction(address: string, inputCount = 1, outputCount = 1): string {
  const script = p2pkhAddressToScriptHex(address, "main");
  const inputs = Array.from({ length: inputCount }, () => `${"00".repeat(32)}00000000${"00"}ffffffff`).join("");
  const outputs = Array.from({ length: outputCount }, () => `e803000000000000${varInt(script.length / 2)}${script}`).join("");
  return `01000000${varInt(inputCount)}${inputs}${varInt(outputCount)}${outputs}00000000`;
}

describe("P2PKH raw transaction parser", () => {
  it("derives the canonical txid and only recognizes exact owned P2PKH scripts", () => {
    const address = "1BoatSLRHtKNngkdXEeobR76b53LETtpyT";
    const rawTxHex = makeTransaction(address);
    const txid = hex(Uint8Array.from(sha256(sha256(bytes(rawTxHex)))).reverse());
    const parsed = parseP2pkhTransaction(rawTxHex, txid);
    expect(parsed.canonicalTxid).toBe(txid);
    expect(parsed.outputs[0]?.value).toBe(1000);
    expect(ownedP2pkhOutputs(parsed, address, "main")).toHaveLength(1);
    expect(() => parseP2pkhTransaction(`${rawTxHex}00`)).toThrow("trailing bytes");
  });

  it("parses multi-input/output transactions and canonical varints", () => {
    const rawTxHex = makeTransaction("1BoatSLRHtKNngkdXEeobR76b53LETtpyT", 2, 253);
    const parsed = parseP2pkhTransaction(rawTxHex);
    expect(parsed.inputs).toHaveLength(2);
    expect(parsed.outputs).toHaveLength(253);
    expect(parsed.outputs[252]?.vout).toBe(252);
  });

  it("rejects truncation, malformed lengths, non-canonical varints and txid mismatches", () => {
    const rawTxHex = makeTransaction("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
    expect(() => parseP2pkhTransaction(rawTxHex.slice(0, -2))).toThrow("truncated");
    const malformedLength = `${rawTxHex.slice(0, 82)}ff${rawTxHex.slice(84)}`;
    expect(() => parseP2pkhTransaction(malformedLength)).toThrow(/scriptSig exceeds|truncated/);
    expect(() => parseP2pkhTransaction(`01000000fd0100${rawTxHex.slice(10)}`)).toThrow("non-canonical varint");
    expect(() => parseP2pkhTransaction(rawTxHex, "00".repeat(32))).toThrow("txid mismatch");
  });

  it("rejects unsafe output amounts and vector bounds", () => {
    const rawTxHex = makeTransaction("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
    const amountOffset = 4 + 1 + 32 + 4 + 1 + 4;
    const unsafeAmount = `${rawTxHex.slice(0, amountOffset * 2)}ffffffffffffffff${rawTxHex.slice((amountOffset + 8) * 2)}`;
    expect(() => parseP2pkhTransaction(unsafeAmount)).toThrow("safe integer");
    expect(() => parseP2pkhTransaction(`01000000feffffffff${rawTxHex.slice(10)}`)).toThrow("invalid input count");
  });
});
