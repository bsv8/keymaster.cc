import type { VaultLocalSecretService, VaultSealedSecret, SessionCoordinatorClient, CoordinatorValueResult } from "@keymaster/contracts";

type Client = Pick<SessionCoordinatorClient, "getIsConnected" | "vaultOperation">;

function value<T>(result: CoordinatorValueResult<T>, operation: string): T {
  if (result.status !== "ok") {
    const message = "message" in result ? result.message : `${operation} failed`;
    throw new Error(message);
  }
  return result.value;
}

export function createVaultLocalSecretService(client: Client): VaultLocalSecretService {
  return {
    async seal(scope: string, plaintext: Uint8Array): Promise<VaultSealedSecret> {
      if (!client.getIsConnected()) throw new Error("Vault coordinator unavailable");
      const transferable = new Uint8Array(plaintext);
      let result: VaultSealedSecret;
      try {
        result = value(await client.vaultOperation({ type: "sealLocalSecret", scope, plaintext: transferable }), "sealLocalSecret");
      } finally {
        transferable.fill(0);
      }
      if (result.version !== 3 || result.keySource !== "active-key-hkdf-v1") throw new Error("Invalid sealed secret returned by Vault");
      return result;
    },
    async open(scope: string, sealed: VaultSealedSecret): Promise<Uint8Array> {
      if (!client.getIsConnected()) throw new Error("Vault coordinator unavailable");
      const result = value(await client.vaultOperation({ type: "openLocalSecret", scope, sealed }), "openLocalSecret");
      if (!(result instanceof Uint8Array)) throw new Error("Invalid secret returned by Vault");
      return new Uint8Array(result);
    }
  };
}
