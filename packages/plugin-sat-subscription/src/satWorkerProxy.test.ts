import { describe, expect, it, vi } from "vitest";
import type { CoordinatorSatOperation, MessageProviderOperations, ProviderSealedMessageRecord, SessionCoordinatorClient } from "@keymaster/contracts";
import { SatSubscriptionWorkerProxyProvider } from "./satWorkerProxy.js";

const OWNER = "02" + "11".repeat(32);

describe("SatSubscriptionWorkerProxyProvider", () => {
  it("sends only the delivery claim fields over the ACK RPC", async () => {
    const operations: CoordinatorSatOperation[] = [];
    const coordinator = {
      subscribeTopic: vi.fn(() => () => undefined),
      satOperation: vi.fn(async (operation: CoordinatorSatOperation) => {
        operations.push(operation);
        return {
          status: "ok" as const,
          value: { isHealthy: true, lastError: null, lastConnectedAtMs: 1 },
        };
      }),
    } as unknown as SessionCoordinatorClient;
    const provider = new SatSubscriptionWorkerProxyProvider(coordinator);
    const handle = await provider.bind({ signer: { publicKeyHex: OWNER, signChallenge: async () => "" } }) as MessageProviderOperations;
    const record = {
      messageId: "A".repeat(43),
      senderPublicKeyHex: "03" + "22".repeat(32),
      senderEndpointId: "https://sender.example:443",
      senderEndpointKind: "origin" as const,
      recipientPublicKeyHex: OWNER,
      recipientEndpointId: "https://recipient.example:443",
      recipientEndpointKind: "origin" as const,
      clientMessageId: "client-message",
      createdAtMs: 1,
      insertedAtMs: 2,
      envelope: { envelopeBytes: new Uint8Array([1]), signatureBytes: new Uint8Array([2]) },
      ingressSupplierId: "supplier-a",
      deliveryId: "delivery-a",
      ackClaimToken: "claim-a",
    } satisfies ProviderSealedMessageRecord;

    await handle.ackMessage!(record);
    expect(operations).toHaveLength(2);
    expect(operations[1]).toEqual({
      type: "provider.ack",
      claim: { deliveryId: "delivery-a", supplierId: "supplier-a", ackClaimToken: "claim-a" },
    });
    expect(JSON.stringify(operations[1])).not.toContain("senderPublicKeyHex");
    expect(JSON.stringify(operations[1])).not.toContain("messageId");
  });
});
