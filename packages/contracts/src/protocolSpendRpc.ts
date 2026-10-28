import type { ProtocolFundingPlanRequest, ProtocolSpendInput, ProtocolSpendPrepareInput, ProtocolSpendPreview, ProtocolSpendResult, ProtocolSpendService } from "./protocolSpend.js";

/** Authority evidence added by wallet assembly, never a business selector. */
export type ProtocolSpendExecutionInput = ProtocolSpendPrepareInput & { ownerPublicKeyHex: string; network: "main" | "test" };
export interface P2pkhProtocolExecutor extends Omit<ProtocolSpendService, "prepare" | "presign" | "releasePreparedSubmission"> {
  prepare(input: ProtocolSpendExecutionInput): Promise<ProtocolSpendPreview>;
  presign(input: ProtocolSpendExecutionInput): Promise<ProtocolSpendPreview>;
  releasePreparedSubmission(input: Parameters<NonNullable<ProtocolSpendService["releasePreparedSubmission"]>>[0] & { ownerPublicKeyHex: string; network: "main" | "test" }): Promise<void>;
}

/** Trusted wallet Window -> Worker DTO, not a Connect method or manager API. */
export type P2pkhProtocolCommand =
  | { type: "prepare" | "presign"; input: ProtocolSpendExecutionInput }
  | { type: "submit" | "release"; input: ProtocolSpendPreview }
  | { type: "release-submission"; input: Parameters<P2pkhProtocolExecutor["releasePreparedSubmission"]>[0] }
  | { type: "funding-plan"; input: ProtocolFundingPlanRequest & { ownerPublicKeyHex: string; network: "main" | "test" } };
export type P2pkhProtocolCommandResult =
  | { type: "prepare" | "presign"; value: ProtocolSpendPreview }
  | { type: "submit"; value: ProtocolSpendResult }
  | { type: "release" | "release-submission"; value: { released: true } }
  | { type: "funding-plan"; value: { selected: ProtocolSpendInput[]; totalInputSatoshis: number } };

/** Associate the internal command with its result; no second runtime protocol. */
export type P2pkhProtocolResultFor<T extends P2pkhProtocolCommand["type"]> =
  T extends "prepare" | "presign" ? { type: T; value: ProtocolSpendPreview } :
  T extends "release" | "release-submission" ? { type: T; value: { released: true } } :
  Extract<P2pkhProtocolCommandResult, { type: T }>;
