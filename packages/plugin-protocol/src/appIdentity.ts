/** proof 规范化与密码学验证由独立协议栈提供；catalog 信任和授权策略仍属于钱包。 */
export {
  APP_IDENTITY_DOMAIN_V1, AppIdentityValidationError, canonicalizeJson,
  identityPayload, identityDigestBytes, verifyAppIdentityProof, isVerifiedAppIdentitySnapshot,
} from "keymaster-connect/server";
