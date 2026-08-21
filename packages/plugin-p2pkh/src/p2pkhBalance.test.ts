import { describe, expect, it } from "vitest";
import type { P2pkhLocalInputClaim, P2pkhLocalOutpoint, P2pkhLocalTransaction, P2pkhOwnedOutpointProjection } from "./p2pkhContracts.js";
import { calculateP2pkhBalanceBreakdown } from "./p2pkhService.js";
import { p2pkhOutpointKey } from "./p2pkhCanonical.js";

const owner = "02" + "11".repeat(32);
const resourceId = "p2pkh:main";
const resourceFields = { resourceId, publicKeyHex: owner, network: "main" as const };

function localTransaction(id: string, txid: string): P2pkhLocalTransaction {
  return { id, ...resourceFields, txid, rawTxHex: "", localState: "local-confirmed", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
}

function localOutpoint(id: string, txid: string, value: number, state: P2pkhLocalOutpoint["state"]): P2pkhLocalOutpoint {
  return { id, resourceId, txid, vout: 0, value, scriptHex: "76a914" + "00".repeat(20) + "88ac", submissionId: id, state, createdAt: "now", updatedAt: "now" };
}

function claim(id: string, submissionId: string, txid: string, value: number): P2pkhLocalInputClaim {
  return { id, submissionId, ...resourceFields, txid, vout: 0, outpointKey: `${txid}:0`, value, state: "active", createdAt: "now", updatedAt: "now" };
}

describe("P2PKH balance projection", () => {
  it("does not subtract a chained local change from block balance twice", () => {
    const fundingTxid = "aa".repeat(32);
    const localATxid = "bb".repeat(32);
    const localBTxid = "cc".repeat(32);
    const chain: P2pkhOwnedOutpointProjection[] = [{ id: "chain", ...resourceFields, address: "1abc", txid: fundingTxid, vout: 0, outpointKey: `${fundingTxid}:0`, value: 1000, scriptHex: "", chainState: "available", updatedAt: "now" }];
    const locals = [localOutpoint("a-output", localATxid, 900, "claimed"), localOutpoint("b-output", localBTxid, 800, "available")];
    const transactions = [localTransaction("a-output", localATxid), localTransaction("b-output", localBTxid)];
    const claims = [claim("a-claim", "a-output", fundingTxid, 1000), claim("b-claim", "b-output", localATxid, 900)];
    expect(calculateP2pkhBalanceBreakdown({ chain, locals, localTransactions: transactions, claims, network: "main" })).toMatchObject({ blockConfirmed: 1000, localConfirmedChange: 800, localSpendable: 800, pendingInputClaims: 1900 });
  });

  it("deducts a protected outpoint only once when it also has a local claim", () => {
    const protectedTxid = "dd".repeat(32);
    const freeTxid = "ee".repeat(32);
    const chain: P2pkhOwnedOutpointProjection[] = [
      { id: "protected", ...resourceFields, address: "1abc", txid: protectedTxid, vout: 0, outpointKey: `${protectedTxid}:0`, value: 1_000, scriptHex: "", chainState: "available", updatedAt: "now" },
      { id: "free", ...resourceFields, address: "1abc", txid: freeTxid, vout: 0, outpointKey: `${freeTxid}:0`, value: 500, scriptHex: "", chainState: "available", updatedAt: "now" }
    ];
    const claims = [claim("protected-claim", "protocol", protectedTxid, 1_000)];
    expect(calculateP2pkhBalanceBreakdown({ chain, locals: [], localTransactions: [], claims, protectedOutpoints: new Set([p2pkhOutpointKey({ resourceId, txid: protectedTxid, vout: 0 })]), network: "main" })).toMatchObject({ blockConfirmed: 1_500, localSpendable: 500 });
  });

  it("defensively deduplicates duplicate local outpoints by resource", () => {
    const parentTxid = "f1".repeat(32);
    const otherResource = "p2pkh:test";
    const localA = localOutpoint("duplicate-a", parentTxid, 700, "available");
    const localB = { ...localA, id: "duplicate-b", resourceId, submissionId: "duplicate-b" };
    const crossResource = { ...localA, id: "duplicate-test", resourceId: otherResource, submissionId: "duplicate-a", value: 999, network: "test" as const };
    const transactions = [{ ...localTransaction("duplicate-a", parentTxid), resourceId: otherResource, network: "test" as const }, localTransaction("duplicate-a", parentTxid), localTransaction("duplicate-b", parentTxid)];
    expect(calculateP2pkhBalanceBreakdown({ chain: [], locals: [localA, localB, crossResource], localTransactions: transactions, claims: [], network: "main" })).toMatchObject({ localConfirmedChange: 700 });
  });

  it("uses the chain projection as canonical when a local overlay has the same outpoint", () => {
    const txid = "f2".repeat(32);
    const chain: P2pkhOwnedOutpointProjection[] = [{ id: "confirmed-z", ...resourceFields, address: "1abc", txid, vout: 0, outpointKey: `${txid}:0`, value: 1_000, scriptHex: "chain-script", chainState: "available", updatedAt: "now" }];
    const local = localOutpoint("local-a", txid, 9_000, "available");
    const transactions = [localTransaction("local-a", txid)];
    const claims = [claim("same-outpoint", "other", txid, 9_000)];
    expect(calculateP2pkhBalanceBreakdown({ chain, locals: [local], localTransactions: transactions, claims, network: "main" })).toMatchObject({ blockConfirmed: 1_000, localConfirmedChange: 0, localSpendable: 0, pendingInputClaims: 1_000 });
  });

  it("qualifies protected reservations by resource", () => {
    const sharedTxid = "f3".repeat(32);
    const otherResource = "p2pkh:main:other";
    const chain: P2pkhOwnedOutpointProjection[] = [
      { id: "protected-resource", ...resourceFields, address: "1abc", txid: sharedTxid, vout: 0, outpointKey: `${sharedTxid}:0`, value: 1_000, scriptHex: "", chainState: "available", updatedAt: "now" },
      { id: "free-resource", ...resourceFields, resourceId: otherResource, address: "1other", txid: sharedTxid, vout: 0, outpointKey: `${sharedTxid}:0`, value: 2_000, scriptHex: "", chainState: "available", updatedAt: "now" }
    ];
    const protectedKeys = new Set([p2pkhOutpointKey({ resourceId, txid: sharedTxid, vout: 0 })]);
    expect(calculateP2pkhBalanceBreakdown({ chain, locals: [], localTransactions: [], claims: [], protectedOutpoints: protectedKeys, network: "main" })).toMatchObject({ blockConfirmed: 3_000, localSpendable: 2_000 });
  });
});
