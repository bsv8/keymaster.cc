// packages/plugin-protocol/src/index.ts
// 协议插件统一入口。
// apps/web 通过 import 这个文件来装配插件，不直接 import 内部模块。

export { protocolPlugin, PROTOCOL_PLUGIN_ID } from "./manifest.js";
export { ProtocolPopupPage } from "./ProtocolPopupPage.js";
export { createProtocolService, ProtocolServiceImpl } from "./protocolService.js";
export { ProtocolValidationError, parseRequestMessage } from "./protocolValidation.js";
export {
  cborEncode,
  cborDecode,
  type CborValue,
  type CborMap
} from "./protocolCbor.js";
export {
  sha256Bytes,
  signCompactSecp256k1,
  verifyCompactSecp256k1,
  deriveSiteKey,
  aesGcmEncrypt,
  aesGcmDecrypt,
  CIPHER_CONTEXT_V1
} from "./protocolCrypto.js";
export {
  buildClaimProjection,
  buildClaimProjectionFromParams,
  resolveClaims,
  resolveBuiltinClaim,
  type BuiltinClaimContext,
  type ClaimResolver,
  type CborProjectionEntry
} from "./protocolClaims.js";
