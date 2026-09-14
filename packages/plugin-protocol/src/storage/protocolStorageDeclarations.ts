import { CENTRAL_STORAGE_DECLARATIONS } from "@keymaster/contracts";

/** Protocol V1's centrally owned purpose declarations. */
export const PROTOCOL_STORAGE_DECLARATIONS = Object.freeze({
  durablePolicy: CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy,
  sessions: CENTRAL_STORAGE_DECLARATIONS.protocolSessions,
  commandHistory: CENTRAL_STORAGE_DECLARATIONS.protocolCommandHistory
});

export const PROTOCOL_STORAGE_PURPOSES = Object.freeze({
  durablePolicy: PROTOCOL_STORAGE_DECLARATIONS.durablePolicy.purposeId,
  sessions: PROTOCOL_STORAGE_DECLARATIONS.sessions.purposeId,
  commandHistory: PROTOCOL_STORAGE_DECLARATIONS.commandHistory.purposeId
});
