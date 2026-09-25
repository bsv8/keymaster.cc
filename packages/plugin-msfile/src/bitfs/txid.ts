import { transactionID } from "go-bitfs";

export function bitfsTxidHex(rawTransaction: Uint8Array): string {
  return Array.from(transactionID(rawTransaction), (byte) => byte.toString(16).padStart(2, "0")).reverse().join("");
}
