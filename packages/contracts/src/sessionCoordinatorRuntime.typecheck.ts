import type {
  CoordinatorRpcRequest,
  CoordinatorRpcResponseForRequest,
  SessionCoordinatorClient,
} from "./index.js";

const getCurrentKeyRequest = {
  kind: "vault.operation",
  operation: { type: "getCurrentKey" },
  expectedSessionEpoch: "epoch-1",
} as const satisfies CoordinatorRpcRequest;

const getCurrentKeyOk: CoordinatorRpcResponseForRequest<typeof getCurrentKeyRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
  operationResult: undefined,
};
void getCurrentKeyOk;

// A non-void request cannot publish an ok response without its result.
// @ts-expect-error response/result association requires operationResult
const getCurrentKeyMissingResult: CoordinatorRpcResponseForRequest<typeof getCurrentKeyRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
};
void getCurrentKeyMissingResult;

// The nested operation discriminant prevents a result from another Vault operation.
const getCurrentKeyWrongResult: CoordinatorRpcResponseForRequest<typeof getCurrentKeyRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
  // @ts-expect-error getCurrentKey returns a key view, not a boolean
  operationResult: true,
};
void getCurrentKeyWrongResult;

const unlockRequest = {
  kind: "unlock",
  password: "password",
  expectedSessionEpoch: "epoch-1",
} as const satisfies CoordinatorRpcRequest;

const unlockOk: CoordinatorRpcResponseForRequest<typeof unlockRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
};
void unlockOk;

// A void success cannot smuggle a result through the response.
const unlockWithResult: CoordinatorRpcResponseForRequest<typeof unlockRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
  // @ts-expect-error void responses forbid operationResult
  operationResult: true,
};
void unlockWithResult;

// Failures never carry a successful operation result.
// @ts-expect-error non-ok responses forbid operationResult
const getCurrentKeyFailureWithResult: CoordinatorRpcResponseForRequest<typeof getCurrentKeyRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "locked" },
  operationResult: {
    publicKeyHex: "02" + "11".repeat(32),
    label: "key",
    capabilities: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    format: "p2pkh",
  },
};
void getCurrentKeyFailureWithResult;

const cryptoRequest = {
  kind: "crypto",
  operation: { type: "signDigest", digestHex: "aa", format: "der" },
  expectedSessionEpoch: "epoch-1",
} as const satisfies CoordinatorRpcRequest;

const cryptoOk: CoordinatorRpcResponseForRequest<typeof cryptoRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
  cryptoResult: { type: "signDigest", format: "der", signatureHex: "bb" },
};
void cryptoOk;

// Crypto responses use cryptoResult and cannot use operationResult.
const cryptoWithOperationResult: CoordinatorRpcResponseForRequest<typeof cryptoRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
  // @ts-expect-error crypto response forbids operationResult
  operationResult: { type: "signDigest", format: "der", signatureHex: "bb" },
  cryptoResult: { type: "signDigest", format: "der", signatureHex: "bb" },
};
void cryptoWithOperationResult;

declare const coordinatorClient: Pick<SessionCoordinatorClient, "vaultOperation">;

// The legacy string-plus-input compatibility wrapper is intentionally absent.
// @ts-expect-error vaultOperation requires a typed discriminated request object
coordinatorClient.vaultOperation("getCurrentKey");
