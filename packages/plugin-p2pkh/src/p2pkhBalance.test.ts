import { describe, expect, it } from "vitest";
import type { P2pkhLocalInputClaim, P2pkhLocalOutpoint, P2pkhLocalTransaction, P2pkhOwnedOutpointProjection } from "./p2pkhContracts.js";
import { calculateP2pkhBalanceBreakdown } from "./p2pkhService.js";

const owner = "02" + "11".repeat(32);
const resourceId = "p2pkh:main";
const resourceFields = { resourceId, publicKeyHex: owner, network: "main" as const };

function localTransaction(id: string, txid: string): P2pkhLocalTransaction {
  return { id, ...resourceFields, txid, rawTxHex: "", state: "local-confirmed", inputOutpointKeys: [], ownOutputs: [], parentTxids: [], createdAt: "now", updatedAt: "now", attempts: [] };
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
    expect(calculateP2pkhBalanceBreakdown({ chain, locals: [], localTransactions: [], claims, protectedOutpoints: new Set([`${protectedTxid}:0`]), network: "main" })).toMatchObject({ blockConfirmed: 1_500, localSpendable: 500 });
  });
});
