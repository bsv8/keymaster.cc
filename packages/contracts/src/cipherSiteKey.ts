import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { assertAppPublicKeyHex } from "./appIdentity.js";

/** cipher 站点绑定的协议常量（与 Go connectorigin.CipherContextV2 一致）。 */
export const CIPHER_CONTEXT_V2 = "keymaster.connect.cipher.v1";

/** App 级 cipher 派生（应用发布与公钥身份 §五）。
 * IKM = 32 字节钱包私钥；salt = CIPHER_CONTEXT_V2；
 * info = walletPubkeyLower + "\0" + network + "\0" + appPublicKeyHex。
 * origin、版本与 indexseed 不进入派生；调用方必须传入已验证的 App 公钥，
 * 不得接受业务请求自带的公钥声明。
 */
export function deriveAppCipherSiteKeyHKDF(
  privKey: Uint8Array,
  ownerPublicKeyHex: string,
  bsvNetwork: "main" | "test",
  appPublicKeyHex: string,
): Uint8Array {
  if (privKey.length !== 32) {
    throw new Error("Private key must be 32 bytes");
  }
  if (!/^(02|03)[0-9a-f]{64}$/iu.test(ownerPublicKeyHex)) {
    throw new Error("Public key must be 33-byte compressed hex");
  }
  if (bsvNetwork !== "main" && bsvNetwork !== "test") {
    throw new Error("Unknown network");
  }
  assertAppPublicKeyHex(appPublicKeyHex);
  const info = new TextEncoder().encode(
    `${ownerPublicKeyHex.toLowerCase()}\0${bsvNetwork}\0${appPublicKeyHex}`,
  );
  return hkdf(sha256, privKey, new TextEncoder().encode(CIPHER_CONTEXT_V2), info, 32);
}
