import type { BorrowedModuleFileStore, P2pkhPaymentLookupResult } from "@keymaster/contracts";
import type { FundingIdentity } from "./p2pkhUtxoManager.js";
import type { SubmissionPlan } from "./p2pkhSubmissionRuntime.js";
import { calcTxidFromRawTxHex } from "./p2pkhSigner.js";

const prefix = "signed-payments/";
// Existing signed records protect funds across upgrades and can be retried byte-for-byte.
const legacyPrefix = "rivet-payments/";
export interface SignedPaymentExact {
  version: 1;
  plan: SubmissionPlan & { paymentId: string; allocationId: string };
  rawTxHex: string;
  txid: string;
  status: "unknown" | "accepted" | "already_known" | "failed";
}

function path(paymentId: string, directory = prefix) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(paymentId)) throw new Error("Invalid staged payment identifier");
  return directory + paymentId + ".json";
}

function parse(bytes: Uint8Array): SignedPaymentExact {
  const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as SignedPaymentExact;
  if (row.version !== 1 || !row.plan?.paymentId || !row.plan.allocationId ||
      !Array.isArray(row.plan.inputs) || !row.plan.inputs.length || !["unknown", "accepted", "already_known", "failed"].includes(row.status) ||
      calcTxidFromRawTxHex(row.rawTxHex) !== row.txid) throw new Error("Invalid signed staged payment record");
  return row;
}

export function createSignedPaymentOutbox(files: BorrowedModuleFileStore) {
  const encode = (row: SignedPaymentExact) => new TextEncoder().encode(JSON.stringify(row));
  const readFile = async (paymentId: string) => {
    for (const directory of [prefix, legacyPrefix]) {
      const objectPath = path(paymentId, directory);
      const file = await files.get(objectPath);
      if (file) return { row: parse(file.bytes), revision: file.revision, objectPath };
    }
    return undefined;
  };
  function sameOwner(row: SignedPaymentExact, scope: FundingIdentity): boolean {
    return row.plan.ownerPublicKeyHex === scope.ownerPublicKeyHex && row.plan.network === scope.network;
  }

  return {
    async putSigned(plan: SubmissionPlan, rawTxHex: string, txid: string) {
      if (!plan.paymentId || !plan.allocationId || !plan.dataSignature) throw new Error("Incomplete signed staged payment plan");
      const row: SignedPaymentExact = { version: 1, plan: { ...plan, paymentId: plan.paymentId, allocationId: plan.allocationId },
        rawTxHex, txid, status: "unknown" };
      await files.put(path(plan.paymentId), encode(row), { ifNoneMatch: true, contentType: "application/json" });
    },
    async get(scope: FundingIdentity & { paymentId: string }) {
      const file = await readFile(scope.paymentId);
      if (file && !sameOwner(file.row, scope)) throw new Error("Staged payment owner changed");
      return file?.row;
    },
    async resolve(paymentId: string, status: Exclude<SignedPaymentExact["status"], "unknown">) {
      const file = await readFile(paymentId);
      if (!file || file.row.status !== "unknown") return;
      await files.put(file.objectPath, encode({ ...file.row, status }), { ifRevision: file.revision, contentType: "application/json" });
    },
    async restoredProtectedInputs(scope: FundingIdentity) {
      const restored = new Set<string>();
      for (const directory of [prefix, legacyPrefix]) {
        let cursor: string | undefined;
        do {
          const page = await files.list({ prefix: directory, cursor });
          for (const entry of page.files) {
            const file = await files.get(entry.path);
            if (!file) continue;
            const row = parse(file.bytes);
            if (!sameOwner(row, scope) || row.status === "failed") continue;
            for (const input of row.plan.inputs) restored.add(`${input.txid}:${input.vout}`);
          }
          cursor = page.nextCursor;
        } while (cursor);
      }
      return restored;
    },
  };
}

export function signedPaymentStatus(row: SignedPaymentExact): P2pkhPaymentLookupResult {
  return { status: row.status === "already_known" ? "accepted" : row.status, txid: row.txid, allocationId: row.plan.allocationId };
}
