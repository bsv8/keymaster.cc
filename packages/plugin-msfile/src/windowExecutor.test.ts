// WSS 身份 pin 失败时必须回收已经建立的连接，并继续尝试后续地址。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSupplierPeerId } from "./supplierConfig.js";
import { MsFileSupplierRuntime } from "./windowExecutor.js";

const mocks = vi.hoisted(() => ({
  authenticateConnection: vi.fn(),
}));

vi.mock("bitcoin-libp2p/libp2p", () => ({
  authenticateConnection: mocks.authenticateConnection,
  createHost: vi.fn(),
}));

const SUPPLIER_PUBKEY = "035f3d296df6e017c017270bfc0293dc7d197ff9e04a25c096260420644d86d21a";
const SUPPLIER_PEER_ID = deriveSupplierPeerId(SUPPLIER_PUBKEY);
const BAD_WSS_ADDRESS = `/dns4/bad.example.com/tcp/443/tls/ws/p2p/${SUPPLIER_PEER_ID}`;
const FALLBACK_WSS_ADDRESS = `/dns4/fallback.example.com/tcp/443/tls/ws/p2p/${SUPPLIER_PEER_ID}`;

type TestConnection = {
  abort: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  newStream: ReturnType<typeof vi.fn>;
};

type TestStream = {
  send: ReturnType<typeof vi.fn>;
  onDrain: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
};

function connection(): TestConnection {
  return {
    abort: vi.fn(),
    close: vi.fn(async () => undefined),
    newStream: vi.fn(async () => {
      throw new Error("MSFile stream must not be opened before WSS authentication succeeds");
    }),
  };
}

function pendingStream(): TestStream {
  return {
    send: vi.fn(() => true),
    onDrain: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
    }),
  };
}

function hostFor(responses: Array<TestConnection | Error>) {
  let index = 0;
  const dial = vi.fn(async (_address: unknown) => {
    const response = responses[index++];
    if (response instanceof Error) throw response;
    if (!response) throw new Error("unexpected dial");
    return response;
  });
  return { dial, stop: vi.fn(async () => undefined) };
}

function supplier(addresses: string[]): {
  name: string;
  supplierPublicKeyHex: string;
  addresses: string[];
  enabled: boolean;
} {
  return {
    name: "test supplier",
    supplierPublicKeyHex: SUPPLIER_PUBKEY,
    addresses,
    enabled: true,
  };
}

describe("MsFileSupplierRuntime WSS lifecycle", () => {
  beforeEach(() => {
    mocks.authenticateConnection.mockReset();
    mocks.authenticateConnection.mockImplementation(() => {
      throw new Error("supplier identity mismatch");
    });
  });

  it("probe closes a WSS connection exactly once when identity pin fails", async () => {
    const badConnection = connection();
    const host = hostFor([badConnection]);
    const runtime = new MsFileSupplierRuntime(host as never);

    const result = await runtime.probe({
      supplier: supplier([BAD_WSS_ADDRESS]),
      supplierGeneration: 1,
    });

    expect(result.connected).toBe(false);
    expect(result.addresses).toEqual([{ address: BAD_WSS_ADDRESS, ok: false, errorCode: "dial_failed" }]);
    expect(badConnection.close).toHaveBeenCalledTimes(1);
    expect(badConnection.newStream).not.toHaveBeenCalled();
  });

  it("stat closes failed WSS authentication and falls back without opening streams", async () => {
    const badConnection = connection();
    const host = hostFor([badConnection, new Error("fallback dial failed")]);
    const runtime = new MsFileSupplierRuntime(host as never);

    await expect(runtime.stat({
      supplier: supplier([BAD_WSS_ADDRESS, FALLBACK_WSS_ADDRESS]),
      seedHashHex: "ab".repeat(32),
      supplierGeneration: 1,
    })).rejects.toThrow(/supplier dial failed/);

    expect(host.dial).toHaveBeenCalledTimes(2);
    expect(host.dial.mock.calls.map(([address]) => (address as { toString(): string }).toString())).toEqual([
      BAD_WSS_ADDRESS,
      FALLBACK_WSS_ADDRESS,
    ]);
    expect(badConnection.close).toHaveBeenCalledTimes(1);
    expect(badConnection.newStream).not.toHaveBeenCalled();
  });

  it("read closes failed WSS authentication and falls back without opening streams", async () => {
    const badConnection = connection();
    const host = hostFor([badConnection, new Error("fallback dial failed")]);
    const runtime = new MsFileSupplierRuntime(host as never);

    await expect(runtime.read({
      supplier: supplier([BAD_WSS_ADDRESS, FALLBACK_WSS_ADDRESS]),
      kind: "block",
      hashHex: "cd".repeat(32),
      maxPriceSatoshis: "1",
      supplierGeneration: 1,
    })).rejects.toThrow(/supplier dial failed/);

    expect(host.dial).toHaveBeenCalledTimes(2);
    expect(host.dial.mock.calls.map(([address]) => (address as { toString(): string }).toString())).toEqual([
      BAD_WSS_ADDRESS,
      FALLBACK_WSS_ADDRESS,
    ]);
    expect(badConnection.close).toHaveBeenCalledTimes(1);
    expect(badConnection.newStream).not.toHaveBeenCalled();
  });

  it("Read 被 AbortSignal 取消时立即 reset supplier connection", async () => {
    mocks.authenticateConnection.mockImplementation(() => undefined);
    const statStream = pendingStream();
    const readStream = pendingStream();
    const supplierConnection = {
      abort: vi.fn(),
      close: vi.fn(async () => undefined),
      newStream: vi.fn()
        .mockResolvedValueOnce(statStream)
        .mockResolvedValueOnce(readStream),
    };
    const host = hostFor([supplierConnection as unknown as TestConnection]);
    const runtime = new MsFileSupplierRuntime(host as never);
    const controller = new AbortController();
    const pendingRead = runtime.read({
      supplier: supplier([FALLBACK_WSS_ADDRESS]),
      kind: "block",
      hashHex: "ef".repeat(32),
      maxPriceSatoshis: "1",
      supplierGeneration: 1,
      signal: controller.signal,
    });

    await vi.waitFor(() => expect(readStream.send).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pendingRead).rejects.toMatchObject({ name: "AbortError" });
    expect(supplierConnection.abort).toHaveBeenCalledTimes(1);
    expect(supplierConnection.close).toHaveBeenCalledTimes(1);
    expect(statStream.close).toHaveBeenCalledTimes(1);
    expect(readStream.close).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });
});
