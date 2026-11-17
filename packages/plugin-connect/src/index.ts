// packages/plugin-connect/src/index.ts
// 连接插件统一入口（显示名 Connect，持久身份 protocol）。
// 主应用 通过 import 这个文件来装配插件，不直接 import 内部模块。

export { connectPlugin, connectSetup, CONNECT_PLUGIN_ID } from "./manifest.js";
export { ConnectCommandFeed, type ConnectCommandFeedProps } from "./ConnectCommandFeed.js";
export { createConnectService, ConnectServiceImpl, type ConnectServiceDeps } from "./connectService.js";
export { openConnectStorageRepository, type ConnectStorageStores } from "./storage/protocolStorageRepository.js";
export { CONNECT_STORAGE_DECLARATIONS, CONNECT_STORAGE_PURPOSES } from "./storage/protocolStorageDeclarations.js";
export { ProtocolValidationError, parseRequestMessage, assertMainnetP2pkhAddress, assertCompressedPubkeyHex } from "./protocolValidation.js";
export { cborEncode, cborDecode, type CborValue, type CborMap } from "./protocolCbor.js";
export { sha256Bytes, signCompactSecp256k1, verifyCompactSecp256k1, aesGcmEncrypt, aesGcmDecrypt, CIPHER_CONTEXT_V2 } from "./protocolCrypto.js";
export { buildClaimProjection, buildClaimProjectionFromParams, resolveClaims, resolveBuiltinClaim, type BuiltinClaimContext, type ClaimResolver, type CborProjectionEntry } from "./protocolClaims.js";

export type { FeepoolPendingOp } from "./feepoolOperations.js";
