import { expect, it, vi } from "vitest";
import { createSatWorkerTransport } from "./workerTransport.js";
it("updates the owned connection state and all remaining listeners from a fenced lane event", async () => {
  const runtime = createSatWorkerTransport({
    operation: async operation => {
      if (operation.type === "connect") return { ...operation, authenticatedPublicKeyHex: operation.supplierPublicKeyHex };
      return undefined;
    },
    cancelInbound: () => undefined,
  });
  const connection = await runtime.transport.connect({
    supplier: { name: "Supplier", enabled: true, supplierId: "supplier", supplierPublicKeyHex: "02" + "ab".repeat(32), multiaddrs: [] },
    ownerPublicKeyHex: "02" + "cd".repeat(32), ownerSessionEpoch: "epoch", supplierGeneration: 1,
  });
  const first = vi.fn(), second = vi.fn();
  const removeFirst = connection.onStateChange!(first);
  connection.onStateChange!(second);
  first.mockClear(); second.mockClear();
  removeFirst();
  runtime.stateHandlers.get(connection.connectionId)!.handler("degraded");
  expect(connection.state).toBe("degraded");
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledWith("degraded");
  connection.close();
  expect(runtime.stateHandlers.size).toBe(0);
  expect(runtime.incomingHandlers.size).toBe(0);
});
