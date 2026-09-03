import { describe, expect, it, vi } from "vitest";
import {
  KeymasterConnectClient,
  KeymasterProtocolError,
  type KeymasterBrowserEnvironment,
  type KeymasterConnectMode
} from "./client.js";

interface Harness {
  client: KeymasterConnectClient;
  popup: Window;
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  posted: Array<{ message: unknown; targetOrigin: string }>;
  emit(data: unknown, origin?: string, source?: MessageEventSource | null): void;
}

function createHarness(mode: KeymasterConnectMode = "popup", hasOpener = true): Harness {
  const posted: Array<{ message: unknown; targetOrigin: string }> = [];
  let listener: ((event: MessageEvent) => void) | null = null;
  const close = vi.fn();
  const popup = {
    closed: false,
    close,
    postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin })
  } as unknown as Window;
  const open = vi.fn(() => popup);
  const environment: KeymasterBrowserEnvironment = {
    open,
    opener: () => hasOpener ? popup : null,
    addMessageListener: (value) => { listener = value; },
    removeMessageListener: () => { listener = null; },
    setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs) as unknown as number,
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
    setInterval: (handler, intervalMs) => globalThis.setInterval(handler, intervalMs) as unknown as number,
    clearInterval: (timer) => globalThis.clearInterval(timer),
    randomUUID: () => "generated-request"
  };
  const client = new KeymasterConnectClient({
    targetOrigin: "https://keymaster.example/a-path-is-not-an-origin",
    mode,
    readyTimeoutMs: 1_000,
    requestTimeoutMs: 1_000,
    closePollMs: 10_000,
    environment
  });
  return {
    client,
    popup,
    open,
    close,
    posted,
    emit(data, origin = "https://keymaster.example", source = popup) {
      listener?.({ data, origin, source } as MessageEvent);
    }
  };
}

describe("KeymasterConnectClient", () => {
  it("opens once, waits for ready, and resolves a typed request", async () => {
    const ctx = createHarness();
    const pending = ctx.client.login({ text: "Sign in" }, { requestId: "login-1" });
    expect(ctx.client.state).toBe("opening");
    expect(ctx.open).toHaveBeenCalledOnce();
    ctx.emit({ v: 1, type: "ready" });
    await vi.waitFor(() => expect(ctx.posted).toHaveLength(1));
    expect(ctx.posted[0]).toEqual({
      targetOrigin: "https://keymaster.example",
      message: {
        v: 1,
        type: "request",
        id: "login-1",
        method: "connect.login",
        params: { text: "Sign in" }
      }
    });

    ctx.emit({
      v: 1,
      type: "result",
      id: "login-1",
      ok: true,
      result: {
        connectSessionId: "session-1",
        ownerPublicKeyHex: `02${"11".repeat(32)}`,
        resolvedClaims: {},
        resolvedAt: 1
      }
    });
    await expect(pending).resolves.toMatchObject({ connectSessionId: "session-1" });
    await ctx.client.connect();
    expect(ctx.open).toHaveBeenCalledOnce();
    ctx.client.close();
  });

  it("ignores messages from a different origin or source window", async () => {
    const ctx = createHarness();
    const opening = ctx.client.connect();
    ctx.emit({ v: 1, type: "ready" }, "https://attacker.example");
    ctx.emit({ v: 1, type: "ready" }, undefined, {} as Window);
    expect(ctx.client.state).toBe("opening");
    ctx.emit({ v: 1, type: "ready" });
    await expect(opening).resolves.toBeUndefined();
    ctx.client.close();
  });

  it("maps failed protocol results to KeymasterProtocolError", async () => {
    const ctx = createHarness();
    const pending = ctx.client.resume("session-1");
    ctx.emit({ v: 1, type: "ready" });
    await vi.waitFor(() => expect(ctx.posted).toHaveLength(1));
    ctx.emit({
      v: 1,
      type: "result",
      id: "generated-request",
      ok: false,
      error: { code: "user_rejected", message: "Request rejected" }
    });
    await expect(pending).rejects.toEqual(expect.objectContaining<KeymasterProtocolError>({
      name: "KeymasterProtocolError",
      code: "user_rejected",
      message: "Request rejected"
    }));
    ctx.client.close();
  });

  it("sends protocol cancel and rejects when AbortSignal fires", async () => {
    const ctx = createHarness();
    const controller = new AbortController();
    const pending = ctx.client.resume("session-1", {
      requestId: "resume-1",
      signal: controller.signal
    });
    ctx.emit({ v: 1, type: "ready" });
    await vi.waitFor(() => expect(ctx.posted).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.posted[1]).toEqual({
      targetOrigin: "https://keymaster.example",
      message: { v: 1, type: "cancel", id: "resume-1" }
    });
    ctx.client.close();
  });

  it("adopts appView opener, sends child ready, and never owns the opener", async () => {
    const ctx = createHarness("appView");
    await ctx.client.connect();
    expect(ctx.client.state).toBe("connected");
    expect(ctx.open).not.toHaveBeenCalled();
    expect(ctx.posted[0]).toEqual({
      targetOrigin: "https://keymaster.example",
      message: { v: 1, type: "ready" }
    });
    ctx.client.close();
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("fails closed when appView opener is unavailable", async () => {
    const ctx = createHarness("appView", false);
    await expect(ctx.client.connect()).rejects.toEqual(expect.objectContaining({
      name: "KeymasterTransportError",
      code: "no_opener"
    }));
    expect(ctx.open).not.toHaveBeenCalled();
  });

  it("rejects connect.launch outside appView mode", async () => {
    const ctx = createHarness();
    await expect(ctx.client.launch({
      launchToken: "token",
      appIdentity: {
        version: 1,
        publisherPublicKey: `02${"11".repeat(32)}`,
        app: { id: "example", name: "Example", description: "Example app" },
        requirements: ["private-key"],
        signature: "22".repeat(64)
      }
    })).rejects.toThrow("requires mode");
  });

  it.each([
    ["identityGet", "identity.get"],
    ["intentSign", "intent.sign"],
    ["cipherEncrypt", "cipher.encrypt"],
    ["cipherDecrypt", "cipher.decrypt"],
    ["p2pkhTransfer", "p2pkh.transfer"],
    ["feepoolPrepare", "feepool.prepare"],
    ["feepoolCommit", "feepool.commit"],
    ["channelPublish", "channel.publish"],
    ["channelSubscriptionSet", "channel.subscription_set"],
    ["storageList", "storage.list"],
    ["storageDirectoryCreate", "storage.directory.create"],
    ["storageDirectoryDelete", "storage.directory.delete"],
    ["storagePut", "storage.put"],
    ["storageGet", "storage.get"],
    ["storageDelete", "storage.delete"],
    ["storageUploadBegin", "storage.upload.begin"],
    ["storageUploadPart", "storage.upload.part"],
    ["storageUploadComplete", "storage.upload.complete"],
    ["storageUploadAbort", "storage.upload.abort"]
  ] as const)("forwards %s to %s", async (clientMethod, protocolMethod) => {
    const ctx = createHarness();
    const request = vi.spyOn(ctx.client, "request").mockResolvedValue(undefined as never);
    const invoke = ctx.client[clientMethod] as unknown as (params: object) => Promise<unknown>;

    await invoke.call(ctx.client, {});

    expect(request).toHaveBeenCalledWith(protocolMethod, {}, undefined);
  });
});
