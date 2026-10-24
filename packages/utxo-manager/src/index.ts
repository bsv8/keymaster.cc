// Public entry of keymaster-utxo-manager (utm/1).
// Applications see: request / replace / release / prepare / submit / reconcile
// plus views and persistence. Signing and broadcast stay behind host ports.
export { CONTRACT_VERSION, MAX_MONEY_SATS, BYTES_PER_KB, P2PKH_INPUT_WEIGHT, ERROR_CODES, UtmError, codeOf } from "./contract.js";
export type { ErrorCode } from "./contract.js";
export { parseAmount, formatAmount, addChecked, sumChecked, estimateFeeSats, parseFeeRate } from "./amounts.js";
export { parseTx, buildUnsigned, assembleSigned, estimateSignedSize, encodeVarint, varintSize, sortedOutpointKeys, checkTxid } from "./txcodec.js";
export type { TxInput, TxOutput, ParsedTx, UnsignedTemplate } from "./txcodec.js";
export { sha256, dsha256, bytesToHex, hexToBytes, calcTxid } from "./hash.js";
export {
  classifyPaymentScript, p2pkhScriptFromHash160, p2pkhScriptFromPublicKey, p2pkScriptFromPublicKey,
  paymentScriptMaterial, publisherMatchesPaymentScript, buildPaymentTemplate, validatePaymentTemplate,
  ripemd160, hash160, hash160Hex, isValidCompressedPublicKey,
} from "./paymentTemplate.js";
export type {
  PaymentType, PaymentOutputRole, PaymentScriptKind, PaymentOutputFact, PaymentRoleFact,
  PaymentTemplatePlan, PaymentTemplateValidation,
} from "./paymentTemplate.js";
export { FundingKernel, unsignedSkeleton, protectionSourceKind, occupationSource, fundSource } from "./kernel.js";
export type {
  Scope, ManagerConfig, SnapshotUtxo, SnapshotInput, RequestInput,
  ExternalProof, PrepareInput, CompletePrepareInput, AllocationView, OutboxEntry,
  ProtocolInputClass, ProtocolInputFact, ProtocolBindingKind, ProtocolIntentInput,
  ExternalSignatureRecord, ResponsibilityView, InputObservation, InputConclusion, SpentInputFact,
} from "./kernel.js";
export { submitSigned, retryExact, reconcileInputs, reconcileUnknown, prepareIntent, prepareProtocolIntent, completeProtocolIntent, recordExternalSignature, submitProtocolSigned } from "./orchestration.js";
export type { DurableStore, BroadcastOutcome, Broadcaster, ChainObserver, InputObserver, OrchestrationPorts, SubmitResult } from "./orchestration.js";
