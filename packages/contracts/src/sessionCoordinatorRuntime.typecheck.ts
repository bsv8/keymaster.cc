import type {
  CoordinatorRpcRequest,
  CoordinatorRpcResponseForRequest,
  SessionCoordinatorClient,
} from "./index.js";

const listKeysRequest = {
  kind: "vault.operation",
  operation: { type: "listKeys" },
  expectedSessionEpoch: "epoch-1",
} as const satisfies CoordinatorRpcRequest;

const listKeysOk: CoordinatorRpcResponseForRequest<typeof listKeysRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
  operationResult: [],
};
void listKeysOk;

// A non-void request cannot publish an ok response without its result.
// @ts-expect-error response/result association requires operationResult
const listKeysMissingResult: CoordinatorRpcResponseForRequest<typeof listKeysRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
};
void listKeysMissingResult;

// The nested operation discriminant prevents a result from another Vault operation.
const listKeysWrongResult: CoordinatorRpcResponseForRequest<typeof listKeysRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "ok" },
  // @ts-expect-error listKeys returns a key view array, not a boolean
  operationResult: true,
};
void listKeysWrongResult;

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
const listKeysFailureWithResult: CoordinatorRpcResponseForRequest<typeof listKeysRequest> = {
  sessionEpoch: "epoch-1",
  ack: { status: "locked" },
  operationResult: [],
};
void listKeysFailureWithResult;

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
coordinatorClient.vaultOperation("listKeys");
