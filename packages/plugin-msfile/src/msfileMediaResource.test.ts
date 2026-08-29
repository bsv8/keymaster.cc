// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMsFileNativeMediaSession, type MsFileMediaSnapshot, type MsFileMediaSession } from "@keymaster/msfile-media/browser";
import type { MsFileService, ResourceDefinition, ResourceRegistry } from "@keymaster/contracts";

const mockState = vi.hoisted(() => ({
  sessions: [] as Array<{
    session: MsFileMediaSession;
    abortController: AbortController;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("@keymaster/msfile-media/browser", () => ({
  createMsFileNativeMediaSession: vi.fn(() => {
    const abortController = new AbortController();
    const dispose = vi.fn(async () => abortController.abort());
    const snapshot = (): MsFileMediaSnapshot => ({
      phase: "idle",
      mode: "vod",
      currentTimeSeconds: 0,
      bufferedSeconds: 0,
      blockWindowOccupancy: 0,
      blockWindowLimit: 2,
      verifiedBlockCount: 0,
      readBlockCount: 0,
      debug: { enabled: true, entries: [] },
    });
    const session = {
      snapshot,
      subscribe: () => () => undefined,
      attach: async () => undefined,
      play: async () => undefined,
      pause: () => undefined,
      seek: async () => undefined,
      stop: async () => undefined,
      dispose,
    } as unknown as MsFileMediaSession;
    mockState.sessions.push({ session, abortController, dispose });
    return session;
  }),
}));

import {
  disposeAllMsFileMediaSessions,
  disposeMsFileMediaSessionNow,
  getMsFileMediaSession,
  msFileMediaResourceArgs,
  registerMsFileMediaResource,
} from "./msfileMediaResource.js";

function makeRegistry(): { registry: ResourceRegistry; definition?: ResourceDefinition<MsFileMediaSnapshot, readonly string[]> } {
  let definition: ResourceDefinition<MsFileMediaSnapshot, readonly string[]> | undefined;
  const registry = {
    register<T, TArgs extends readonly string[]>(value: ResourceDefinition<T, TArgs>) {
      definition = value as unknown as ResourceDefinition<MsFileMediaSnapshot, readonly string[]>;
    },
    unregister: () => undefined,
    get: () => definition,
    _ids: () => definition ? [definition.id] : [],
  } as ResourceRegistry;
  return { registry, get definition() { return definition; } };
}

function sourceInput() {
  return {
    taskToken: "task-token",
    seedHashHex: "aa".repeat(32),
    supplierPublicKeyHex: `02${"11".repeat(32)}`,
    fileSizeBytes: 1n,
    declaredMediaType: "audio/mpeg",
    mediaBlockReadConcurrency: 2,
    globalSeedReadConcurrency: 4,
    globalBlockReadConcurrency: 8,
    globalStatConcurrency: 4,
  };
}

afterEach(() => {
  disposeAllMsFileMediaSessions();
  mockState.sessions.length = 0;
  vi.mocked(createMsFileNativeMediaSession).mockClear();
});

describe("MSFile media Resource Store lifecycle", () => {
  it("disable 时释放每个 entry 的 session，并清空 map", async () => {
    const registryState = makeRegistry();
    registerMsFileMediaResource(registryState.registry, {} as MsFileService);
    const args = msFileMediaResourceArgs(sourceInput());
    const resource = registryState.definition!;
    await resource.load(args, {} as never, new AbortController().signal);

    const created = mockState.sessions[0]!;
    const pendingSupplierRead = new Promise<void>((_resolve, reject) => {
      if (created.abortController.signal.aborted) reject(new Error("supplier read aborted"));
      else created.abortController.signal.addEventListener("abort", () => {
        reject(new Error("supplier read aborted"));
      }, { once: true });
    });
    expect(getMsFileMediaSession("task-token")).toBe(created.session);

    disposeAllMsFileMediaSessions();
    await expect(pendingSupplierRead).rejects.toThrow("supplier read aborted");
    expect(created.dispose).toHaveBeenCalledTimes(1);
    expect(getMsFileMediaSession("task-token")).toBeUndefined();
  });

  it("固定创建快照，设置变更不会重建既有媒体 Session", async () => {
    const registryState = makeRegistry();
    registerMsFileMediaResource(registryState.registry, {} as MsFileService);
    const first = sourceInput();
    const resource = registryState.definition!;
    const args = msFileMediaResourceArgs(first);
    await resource.load(args, {} as never, new AbortController().signal);
    expect(vi.mocked(createMsFileNativeMediaSession)).toHaveBeenCalledWith(
      expect.objectContaining({ reader: expect.any(Object) }),
      expect.objectContaining({
        mediaBlockReadConcurrency: 2,
        globalSeedReadConcurrency: 4,
        globalBlockReadConcurrency: 8,
        globalStatConcurrency: 4,
      }),
    );

    const changed = msFileMediaResourceArgs({ ...first, mediaBlockReadConcurrency: 6, globalBlockReadConcurrency: 12 });
    expect(changed).toEqual(args);
    await resource.load(changed, {} as never, new AbortController().signal);
    expect(vi.mocked(createMsFileNativeMediaSession)).toHaveBeenCalledTimes(1);
  });

  it("既有 Session 释放后再次创建时采用最新并发设置", async () => {
    const registryState = makeRegistry();
    registerMsFileMediaResource(registryState.registry, {} as MsFileService);
    const first = sourceInput();
    const resource = registryState.definition!;
    await resource.load(msFileMediaResourceArgs(first), {} as never, new AbortController().signal);
    const changed = { ...first, mediaBlockReadConcurrency: 6, globalBlockReadConcurrency: 12 };
    disposeMsFileMediaSessionNow(first.taskToken);
    const changedArgs = msFileMediaResourceArgs(changed);
    await resource.load(changedArgs, {} as never, new AbortController().signal);
    expect(vi.mocked(createMsFileNativeMediaSession)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(createMsFileNativeMediaSession).mock.calls[1]?.[1]).toMatchObject({
      mediaBlockReadConcurrency: 6,
      globalSeedReadConcurrency: 4,
      globalBlockReadConcurrency: 12,
      globalStatConcurrency: 4,
    });
  });
});
