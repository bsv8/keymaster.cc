import { describe, expect, it } from "vitest";
import { MSFILE_MEDIA_RANGE_PROTOCOL_VERSION, MsFileRangeHost } from "./rangeHost.js";

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function seedFor(hash: string): Uint8Array {
  const seed = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) seed[index] = Number.parseInt(hash.slice(index * 2, index * 2 + 2), 16);
  return seed;
}

async function sessionFixture() {
  const block = new Uint8Array([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
  const blockHash = await sha256(block);
  const seed = seedFor(blockHash);
  const host = new MsFileRangeHost();
  const session = host.createSession({
    seedHashHex: await sha256(seed),
    supplierPublicKeyHex: `02${"11".repeat(32)}`,
    fileSizeBytes: BigInt(block.byteLength),
    declaredMediaType: "audio/mpeg",
    reader: {
      readSeed: async () => seed.slice(),
      readBlock: async () => block.slice(),
    },
  });
  return { host, session, block };
}

type InternalSession = {
  handle(message: unknown, port: MessagePort): Promise<void>;
  bindClient(clientId: string): void;
};

function receive(port: MessagePort): Promise<unknown> {
  return new Promise((resolve) => {
    port.addEventListener("message", (event) => resolve(event.data), { once: true });
    port.start();
  });
}

function receiveMatching(port: MessagePort, predicate: (message: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent<unknown>) => {
      if (!predicate(event.data)) return;
      port.removeEventListener("message", listener);
      resolve(event.data);
    };
    port.addEventListener("message", listener);
    port.start();
  });
}

describe("MsFileRangeHost MessageChannel", () => {
  it("返回 HEAD 元数据并按 pull 输出正文", async () => {
    const { host, session, block } = await sessionFixture();
    (session as unknown as InternalSession).bindClient("client-a");
    const channel = new MessageChannel();
    const request = {
      type: "msfile-media-range-request",
      version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
      clientId: "client-a",
      sessionId: session.sessionId,
      requestId: "head-test",
      method: "HEAD",
    };
    const responsePromise = receive(channel.port1);
    await (session as unknown as InternalSession).handle(request, channel.port2);
    expect(await responsePromise).toMatchObject({ status: 200, contentLength: block.byteLength, mediaType: "audio/mpeg" });
    channel.port1.close();

    const streamChannel = new MessageChannel();
    const streamRequest = {
      ...request,
      requestId: "get-test",
      method: "GET",
      range: "bytes=2-5",
    };
    const messages: unknown[] = [];
    streamChannel.port1.addEventListener("message", (event) => messages.push(event.data));
    streamChannel.port1.start();
    await (session as unknown as InternalSession).handle(streamRequest, streamChannel.port2);
    const chunkPromise = receiveMatching(streamChannel.port1, (message) => (
      typeof message === "object" && message !== null &&
      (message as { type?: string }).type === "msfile-media-range-chunk"
    ));
    streamChannel.port1.postMessage({ type: "msfile-media-range-pull", version: 1, requestId: "get-test" });
    await chunkPromise;
    const donePromise = receiveMatching(streamChannel.port1, (message) => (
      typeof message === "object" && message !== null &&
      (message as { type?: string }).type === "msfile-media-range-done"
    ));
    streamChannel.port1.postMessage({ type: "msfile-media-range-pull", version: 1, requestId: "get-test" });
    await donePromise;
    const chunks = messages.filter((message): message is { type: string; bytes?: ArrayBuffer } => typeof message === "object" && message !== null && "type" in message && (message as { type: string }).type === "msfile-media-range-chunk");
    expect(chunks).toHaveLength(1);
    expect(new Uint8Array(chunks[0]!.bytes!)).toEqual(block.slice(2, 6));
    expect(messages.some((message) => typeof message === "object" && message !== null && (message as { type?: string }).type === "msfile-media-range-done")).toBe(true);
    await host.dispose();
  });

  it("dispose 后立即撤销 session 映射", async () => {
    const { host, session } = await sessionFixture();
    await session.dispose();
    const channel = new MessageChannel();
    const responsePromise = receive(channel.port1);
    await (session as unknown as InternalSession).handle({
      type: "msfile-media-range-request",
      version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
      clientId: "client-a",
      sessionId: session.sessionId,
      requestId: "revoked-test",
      method: "GET",
    }, channel.port2);
    expect(await responsePromise).toMatchObject({ status: 404 });
    await host.dispose();
  });

  it("Client.id 变化时拒绝复用旧 URL", async () => {
    const { host, session } = await sessionFixture();
    (session as unknown as InternalSession).bindClient("client-a");
    const firstChannel = new MessageChannel();
    const firstResponse = receive(firstChannel.port1);
    await (session as unknown as InternalSession).handle({
      type: "msfile-media-range-request",
      version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
      clientId: "client-a",
      sessionId: session.sessionId,
      requestId: "owner-test-a",
      method: "HEAD",
    }, firstChannel.port2);
    expect(await firstResponse).toMatchObject({ status: 200 });
    firstChannel.port1.close();

    const secondChannel = new MessageChannel();
    const secondResponse = receive(secondChannel.port1);
    await (session as unknown as InternalSession).handle({
      type: "msfile-media-range-request",
      version: MSFILE_MEDIA_RANGE_PROTOCOL_VERSION,
      clientId: "client-b",
      sessionId: session.sessionId,
      requestId: "owner-test-b",
      method: "GET",
    }, secondChannel.port2);
    expect(await secondResponse).toMatchObject({ status: 404 });
    secondChannel.port1.close();
    await host.dispose();
  });
});
