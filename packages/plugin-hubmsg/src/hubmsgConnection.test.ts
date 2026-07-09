import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN,
  APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
  APPMSG_ENVELOPE_VERSION_V1,
  APPMSG_SEAL_SUITE_ID_V1,
  HUB_FRAME_KIND,
  HUBMSG_EVENT,
  HUBMSG_METHOD,
  cborDecode,
  cborEncode,
  type CborValue,
  type ProviderSealedMessageRecord
} from "@keymaster/contracts";
import {
  HubMsgConnectionImpl,
  HubMsgProviderOperations,
  type HubMsgConnection
} from "./hubmsgConnection.js";

function decodeFrame(bytes: Uint8Array): { kind: number; body: unknown[] } {
  const outer = cborDecode(bytes);
  if (!Array.isArray(outer) || outer.length !== 3 || !(outer[2] instanceof Uint8Array)) {
    throw new Error("test: malformed frame");
  }
  const body = cborDecode(outer[2]);
  if (!Array.isArray(body)) {
    throw new Error("test: malformed frame body");
  }
  return { kind: outer[1] as number, body };
}

function requireValue<T>(value: T | null | undefined, message: string): NonNullable<T> {
  if (value == null) {
    throw new Error(message);
  }
  return value as NonNullable<T>;
}

function decodeCborArray(bytes: Uint8Array): CborValue[] {
  const decoded = cborDecode(bytes);
  if (!Array.isArray(decoded)) {
    throw new Error("test: decoded value is not an array");
  }
  return decoded;
}

function makePub(seed: number): Uint8Array {
  const out = new Uint8Array(33);
  out[0] = seed % 2 === 0 ? 0x02 : 0x03;
  for (let i = 1; i < out.length; i++) {
    out[i] = (seed + i) & 0xff;
  }
  return out;
}

function makeEnvelopeBytes(): Uint8Array {
  return cborEncode([
    APPMSG_ENVELOPE_VERSION_V1,
    makePub(1),
    APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
    "sender.plugin",
    makePub(2),
    APPMSG_ENVELOPE_ENDPOINT_KIND_ORIGIN,
    "https://receiver.example:443",
    "client-1",
    111,
    APPMSG_SEAL_SUITE_ID_V1,
    new Uint8Array(12).fill(7),
    new Uint8Array([1, 2, 3, 4])
  ]);
}

function makeStoredRecordBytes(messageId = "m-1", insertedAtMs = 222): Uint8Array {
  return cborEncode([
    messageId,
    insertedAtMs,
    makeEnvelopeBytes(),
    new Uint8Array(64).fill(9)
  ]);
}

class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly sent: Uint8Array[] = [];
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  binaryType = "arraybuffer";

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(message: Uint8Array): void {
    this.sent.push(message);
  }

  close(): void {
    this.emit("close", {});
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: (ev: unknown) => void): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(handler);
  }

  emit(type: string, ev: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const handler of set) handler(ev);
  }

  receive(frameBytes: Uint8Array): void {
    this.emit("message", { data: frameBytes });
  }
}

describe("HubMsgConnectionImpl", () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    FakeSocket.instances.length = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
  });

  it("按 HubMsg 现行握手发送 client_bind，并对服务端 ping 回 pong", async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

    const signer = {
      publicKeyHex: "02aa".padEnd(66, "a"),
      signChallenge: vi.fn(async () => "11".repeat(64))
    };
    const conn = new HubMsgConnectionImpl({ url: "wss://hubmsg.test/ws/v1" });
    const connectPromise = conn.connect(signer);
    const sock = requireValue(FakeSocket.instances[0], "test: missing fake socket");
    expect(sock.url).toBe("wss://hubmsg.test/ws/v1");

    sock.receive(
      cborEncode([
        1,
        HUB_FRAME_KIND.ServerOpen,
        cborEncode(["sid-1", "nonce-1", 45])
      ])
    );
    await vi.waitFor(() => expect(sock.sent).toHaveLength(1));
    const bindFrame = decodeFrame(requireValue(sock.sent[0], "test: missing client_bind frame"));
    expect(bindFrame.kind).toBe(HUB_FRAME_KIND.ClientBind);
    expect(bindFrame.body[0]).toBe("sid-1");
    expect(bindFrame.body[1]).toBe(signer.publicKeyHex);
    expect(typeof bindFrame.body[2]).toBe("number");
    expect(bindFrame.body[3]).toBe("11".repeat(64));
    expect(signer.signChallenge).toHaveBeenCalledTimes(1);

    sock.receive(
      cborEncode([1, HUB_FRAME_KIND.BindReady, cborEncode(["sid-1"])])
    );
    await connectPromise;
    expect(conn.state()).toBe("bound");

    sock.receive(
      cborEncode([1, HUB_FRAME_KIND.Ping, cborEncode([999])])
    );
    expect(sock.sent).toHaveLength(2);
    const pongFrame = decodeFrame(requireValue(sock.sent[1], "test: missing pong frame"));
    expect(pongFrame.kind).toBe(HUB_FRAME_KIND.Pong);
    expect(pongFrame.body).toEqual([999]);
  });

  it("server_open 前 socket close：connect reject，不会永久挂住", async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

    const signer = {
      publicKeyHex: "02aa".padEnd(66, "a"),
      signChallenge: vi.fn(async () => "11".repeat(64))
    };
    const conn = new HubMsgConnectionImpl({ url: "wss://hubmsg.test/ws/v1" });
    const connectPromise = conn.connect(signer);
    const sock = requireValue(FakeSocket.instances[0], "test: missing fake socket");

    sock.close();

    await expect(connectPromise).rejects.toThrow(/websocket closed during server_open/i);
    expect(conn.state()).toBe("closed");
  });

  it("server_open 超时：connect reject，并记录 failed 日志", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const signer = {
      publicKeyHex: "02aa".padEnd(66, "a"),
      signChallenge: vi.fn(async () => "11".repeat(64))
    };
    const conn = new HubMsgConnectionImpl({
      url: "wss://hubmsg.test/ws/v1",
      handshakeTimeoutMs: 50,
      logger
    });
    const connectPromise = conn.connect(signer).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(51);

    const err = await connectPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/server_open timeout after 50ms/i);
    expect(conn.state()).toBe("closed");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "hubmsg.connect.failed"
      })
    );
  });
});

describe("HubMsgProviderOperations", () => {
  function makeConn(args: {
    request?: (
      methodId: number,
      params: Uint8Array,
      options?: { timeoutMs?: number }
    ) => Promise<Uint8Array>;
    subscribeEvent?: (eventId: number, handler: (data: Uint8Array) => void) => () => void;
  }): HubMsgConnection {
    return {
      state: () => "bound",
      connect: async () => undefined,
      close: () => undefined,
      request: async <TResult>(
        methodId: number,
        params: Uint8Array,
        options?: { timeoutMs?: number }
      ) => {
        const impl =
          args.request ??
          (async () => {
            throw new Error("not implemented");
          });
        return (await impl(methodId, params, options)) as TResult;
      },
      subscribeEvent:
        args.subscribeEvent ??
        (() => () => undefined),
      onClose: () => () => undefined
    };
  }

  it("sendMessage 只上传 signed envelope 二元组，并把第二个回参当 insertedAtMs", async () => {
    const calls: Array<{ methodId: number; params: Uint8Array }> = [];
    const ops = new HubMsgProviderOperations(
      makeConn({
        request: async (methodId, params) => {
          calls.push({ methodId, params });
          return cborEncode(["m-1", 222]);
        }
      })
    );
    const record: ProviderSealedMessageRecord = {
      messageId: "",
      clientMessageId: "client-1",
      senderPublicKeyHex: "02aa".padEnd(66, "a"),
      senderEndpointKind: "plugin",
      senderEndpointId: "sender.plugin",
      recipientPublicKeyHex: "02bb".padEnd(66, "b"),
      recipientEndpointKind: "origin",
      recipientEndpointId: "https://receiver.example:443",
      createdAtMs: 111,
      insertedAtMs: 0,
      envelope: {
        envelopeBytes: makeEnvelopeBytes(),
        signatureBytes: new Uint8Array(64).fill(9)
      }
    };

    const out = await ops.sendMessage({ record });
    expect(out).toEqual({ messageId: "m-1", insertedAtMs: 222 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.methodId).toBe(HUBMSG_METHOD.MessageSend);
    const decoded = decodeCborArray(calls[0]!.params);
    expect(Array.from(requireValue(decoded[0], "test: missing send envelope") as Uint8Array)).toEqual(
      Array.from(record.envelope.envelopeBytes)
    );
    expect(Array.from(requireValue(decoded[1], "test: missing send signature") as Uint8Array)).toEqual(
      Array.from(record.envelope.signatureBytes)
    );
  });

  it("list/get/received 都按 HubMsg 最小四元组解析，并从 envelope 还原路由头", async () => {
    let subscribedHandler: ((data: Uint8Array) => void) | null = null;
    const ops = new HubMsgProviderOperations(
      makeConn({
        request: async (methodId, params) => {
          if (methodId === HUBMSG_METHOD.MessageList) {
            expect(cborDecode(params)).toEqual([
              "02aa".padEnd(66, "a"),
              APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
              "sender.plugin",
              "all",
              "cursor-1",
              "",
              50
            ]);
            return cborEncode([makeStoredRecordBytes("m-1", 222), false]);
          }
          if (methodId === HUBMSG_METHOD.MessageGet) {
            expect(cborDecode(params)).toEqual([
              "m-9",
              "02aa".padEnd(66, "a"),
              APPMSG_ENVELOPE_ENDPOINT_KIND_PLUGIN,
              "sender.plugin"
            ]);
            return cborEncode([makeStoredRecordBytes("m-9", 999)]);
          }
          throw new Error(`unexpected method ${methodId}`);
        },
        subscribeEvent: (eventId, handler) => {
          expect(eventId).toBe(HUBMSG_EVENT.MessageReceived);
          subscribedHandler = handler;
          return () => {
            subscribedHandler = null;
          };
        }
      })
    );

    const listed = await ops.listMessages({
      ownerPublicKeyHex: "02aa".padEnd(66, "a"),
      scopeEndpoint: { kind: "plugin", id: "sender.plugin" },
      afterMessageId: "cursor-1",
      limit: 50
    });
    expect(listed.hasMore).toBe(false);
    expect(listed.items[0]).toMatchObject({
      messageId: "m-1",
      clientMessageId: "client-1",
      senderEndpointKind: "plugin",
      senderEndpointId: "sender.plugin",
      recipientEndpointKind: "origin",
      recipientEndpointId: "https://receiver.example:443",
      createdAtMs: 111,
      insertedAtMs: 222
    });

    const got = await ops.getMessage({
      ownerPublicKeyHex: "02aa".padEnd(66, "a"),
      scopeEndpoint: { kind: "plugin", id: "sender.plugin" },
      messageId: "m-9"
    });
    expect(got?.messageId).toBe("m-9");
    expect(got?.insertedAtMs).toBe(999);

    const received: ProviderSealedMessageRecord[] = [];
    const off = ops.subscribeMessages((rec) => received.push(rec));
    const handler: (data: Uint8Array) => void = requireValue(
      subscribedHandler,
      "test: missing subscribe handler"
    );
    handler(makeStoredRecordBytes("m-3", 333));
    expect(received[0]?.messageId).toBe("m-3");
    expect(received[0]?.insertedAtMs).toBe(333);
    off();
  });

  it("checkOnline 走扁平数组，不再包一层列表", async () => {
    const calls: Array<{
      methodId: number;
      params: Uint8Array;
      options?: { timeoutMs?: number };
    }> = [];
    const ops = new HubMsgProviderOperations(
      makeConn({
        request: async (methodId, params, options) => {
          calls.push({ methodId, params, options });
          return cborEncode(["02aa".padEnd(66, "a")]);
        }
      })
    );

    const out = await ops.checkOnline({
      publicKeyHexes: ["02aa".padEnd(66, "a"), "02bb".padEnd(66, "b")]
    });
    expect(calls[0]?.methodId).toBe(HUBMSG_METHOD.MessageOnline);
    expect(cborDecode(calls[0]!.params)).toEqual([
      "02aa".padEnd(66, "a"),
      "02bb".padEnd(66, "b")
    ]);
    expect(calls[0]?.options?.timeoutMs).toBe(5_000);
    expect(out).toEqual({
      ["02aa".padEnd(66, "a")]: "online",
      ["02bb".padEnd(66, "b")]: "offline"
    });
  });

  it("checkOnline 请求失败时向上抛错，不在 provider 层吞成 unknown", async () => {
    const ops = new HubMsgProviderOperations(
      makeConn({
        request: async () => {
          throw new Error("HubMsg: request timeout after 5000ms");
        }
      })
    );

    await expect(
      ops.checkOnline({
        publicKeyHexes: ["02aa".padEnd(66, "a")]
      })
    ).rejects.toThrow(/request timeout after 5000ms/i);
  });
});
