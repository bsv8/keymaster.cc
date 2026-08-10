import type { VaultLocalSecretService, VaultSealedSecret, SessionCoordinatorClient } from "@keymaster/contracts";

type Client = Pick<SessionCoordinatorClient, "getIsConnected" | "vaultOperation">;

function value<T>(result: Awaited<ReturnType<Client["vaultOperation"]>>, operation: string): T {
  if (result.status !== "ok") {
    const message = "message" in result ? result.message : `${operation} failed`;
    throw new Error(message);
  }
  return result.value as T;
}

export function createVaultLocalSecretService(client: Client): VaultLocalSecretService {
  return {
    async seal(scope: string, plaintext: Uint8Array): Promise<VaultSealedSecret> {
      if (!client.getIsConnected()) throw new Error("Vault coordinator unavailable");
      const transferable = new Uint8Array(plaintext);
      let result: unknown;
      try {
        result = value<unknown>(await client.vaultOperation({ type: "sealLocalSecret", scope, plaintext: transferable }), "sealLocalSecret");
      } finally {
        transferable.fill(0);
      }
      if (!result || typeof result !== "object" || !([1, 2] as number[]).includes((result as VaultSealedSecret).version)) throw new Error("Invalid sealed secret returned by Vault");
      return result as VaultSealedSecret;
    },
    async open(scope: string, sealed: VaultSealedSecret): Promise<Uint8Array> {
      if (!client.getIsConnected()) throw new Error("Vault coordinator unavailable");
      const result = value<unknown>(await client.vaultOperation({ type: "openLocalSecret", scope, sealed }), "openLocalSecret");
      if (!(result instanceof Uint8Array)) throw new Error("Invalid secret returned by Vault");
      return new Uint8Array(result);
    }
  };
}
