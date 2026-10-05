import type { SatWindowLaneOperation } from "@keymaster/contracts";
import type { SatSubscriptionTransport, SatSupplierConnection } from "./satProvider.js";
interface SatWorkerTransportPorts {
  operation(operation: SatWindowLaneOperation, signal?: AbortSignal): Promise<unknown>;
  cancelInbound(connectionId: string, reason: string): void;
}
function asWire(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(label + " did not return wire bytes");
  return value;
}
/** Sat owns connection instances and registrations; WindowP2P only carries the wire. */
export function createSatWorkerTransport(ports: SatWorkerTransportPorts) {
  const satIncomingHandlers = new Map<string, { supplierId: string; ownerSessionEpoch: string; supplierGeneration: number; handler: (wire: Uint8Array) => Promise<Uint8Array> }>();
  const satConnectionStateHandlers = new Map<string, {
    supplierId: string;
    ownerSessionEpoch: string;
    supplierGeneration: number;
    handler: (state: "online" | "degraded" | "closed") => void;
  }>();
  const satSubscriptionTransport: SatSubscriptionTransport = {
    async connect(input): Promise<SatSupplierConnection> {
      const connectionId = `sat-connection-${crypto.randomUUID()}`;
      const fence = { supplierId: input.supplier.supplierId, connectionId, ownerSessionEpoch: input.ownerSessionEpoch, supplierGeneration: input.supplierGeneration } as const;
      // 先把业务 handler 放入 connectionId 索引，再发起 Window connect；这样
      // lane/adapter 在 connect 返回前收到的首条 Publish 也能回到当前 owner。
      if (input.onSspRequest) {
        satIncomingHandlers.set(connectionId, {
          supplierId: fence.supplierId,
          ownerSessionEpoch: fence.ownerSessionEpoch,
          supplierGeneration: fence.supplierGeneration,
          handler: input.onSspRequest,
        });
      }
      let result: unknown;
      try {
        result = await ports.operation({
          type: "connect",
          ...fence,
          supplierPublicKeyHex: input.supplier.supplierPublicKeyHex,
          multiaddrs: [...input.supplier.multiaddrs]
        }, input.signal);
      } catch (error) {
        ports.cancelInbound(connectionId, "Sat connection setup failed");
        satIncomingHandlers.delete(connectionId);
        throw error;
      }
      if (!result || typeof result !== "object" || typeof (result as { authenticatedPublicKeyHex?: unknown }).authenticatedPublicKeyHex !== "string"
        || (result as Partial<typeof fence>).supplierId !== fence.supplierId
        || (result as Partial<typeof fence>).connectionId !== fence.connectionId
        || (result as Partial<typeof fence>).ownerSessionEpoch !== fence.ownerSessionEpoch
        || (result as Partial<typeof fence>).supplierGeneration !== fence.supplierGeneration) {
        ports.cancelInbound(connectionId, "Sat connection returned an invalid fence");
        satIncomingHandlers.delete(connectionId);
        throw new Error("Sat Window lane returned an invalid authenticated connection");
      }
      let connectionState: "online" | "degraded" | "closed" = "online";
      const stateListeners = new Set<(state: "online" | "degraded" | "closed") => void>();
      const setConnectionState = (next: "online" | "degraded" | "closed"): void => {
        if (connectionState === next) return;
        connectionState = next;
        for (const listener of stateListeners) {
          try { listener(next); } catch { /* 单个状态监听器不能打断连接。 */ }
        }
      };
      satConnectionStateHandlers.set(connectionId, { ...fence, handler: setConnectionState });
      const connection: SatSupplierConnection = {
        ...fence,
        authenticatedPublicKeyHex: (result as { authenticatedPublicKeyHex: string }).authenticatedPublicKeyHex,
        get state() { return connectionState; },
        onStateChange: (handler) => {
          stateListeners.add(handler);
          handler(connectionState);
          return () => { stateListeners.delete(handler); };
        },
        requestSsp: async (wire, signal) => {
          if (connectionState === "closed") throw new Error("Sat supplier connection is closed");
          try {
            const response = asWire(await ports.operation({ type: "requestSsp", ...fence, wire: wire.slice() }, signal), "requestSsp");
            setConnectionState("online");
            return response;
          } catch (error) {
            setConnectionState("degraded");
            throw error;
          }
        },
        requestSpi: async (wire, signal) => {
          if (connectionState === "closed") throw new Error("Sat supplier connection is closed");
          try {
            const response = asWire(await ports.operation({ type: "requestSpi", ...fence, wire: wire.slice() }, signal), "requestSpi");
            setConnectionState("online");
            return response;
          } catch (error) {
            setConnectionState("degraded");
            throw error;
          }
        },
        subscribeSspRequests: (handler) => {
          satIncomingHandlers.set(connectionId, { supplierId: input.supplier.supplierId, ownerSessionEpoch: input.ownerSessionEpoch, supplierGeneration: input.supplierGeneration, handler });
          return () => {
            if (satIncomingHandlers.get(connectionId)?.handler === handler) {
              ports.cancelInbound(connectionId, "Sat SSP handler was unsubscribed");
              satIncomingHandlers.delete(connectionId);
            }
          };
        },
        close: () => {
          setConnectionState("closed");
          ports.cancelInbound(connectionId, "Sat connection was closed");
          satIncomingHandlers.delete(connectionId);
          satConnectionStateHandlers.delete(connectionId);
          void ports.operation({ type: "close", ...fence }).catch(() => undefined);
        },
      };
      return connection;
    },
  };
  return { transport: satSubscriptionTransport, incomingHandlers: satIncomingHandlers, stateHandlers: satConnectionStateHandlers };
}
