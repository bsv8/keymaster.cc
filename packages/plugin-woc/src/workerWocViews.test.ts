import { expect, it, vi } from "vitest";
import { createMessageBus } from "webloom-framework";
import { createWocService } from "./wocService.js";
import { createWorkerWocViews } from "./workerWocViews.js";

it("keeps broadcast and lifecycle methods out of query consumers and rejects late provider results", async () => {
  let finishFetch!: (response: Response) => void;
  let beganFetch!: () => void;
  const started = new Promise<void>((resolve) => { beganFetch = resolve; });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    beganFetch();
    return new Promise<Response>((resolve) => { finishFetch = resolve; });
  });
  const service = createWocService({ messageBus: createMessageBus(), initialConfig: { requestsPerSecond: 1000 } });
  let active = true;
  const views = createWorkerWocViews(service, () => { if (!active) throw new Error("provider revoked"); });
  try {
    expect("broadcast" in views.query).toBe(false);
    expect("dispose" in views.query).toBe(false);
    expect("ready" in views.query).toBe(false);
    expect(Object.keys(views.broadcast)).toEqual(["broadcast"]);
    const height = views.query.getChainHeight("main");
    await started;
    active = false;
    finishFetch(new Response(JSON.stringify({ blocks: 900_000 }), { status: 200 }));
    await expect(height).rejects.toThrow("provider revoked");
    expect(() => views.query.getConfig()).toThrow("provider revoked");
  } finally {
    service.dispose();
    fetchMock.mockRestore();
  }
});

it("fences subscription callbacks and removes them when the provider Scope revokes", async () => {
  const service = createWocService({ messageBus: createMessageBus() });
  let active = true;
  const views = createWorkerWocViews(service, () => { if (!active) throw new Error("provider revoked"); });
  const listener = vi.fn();
  try {
    const off = views.query.onConfigChange(listener);
    listener.mockClear();
    active = false;
    await service.updateConfig({ requestsPerSecond: 4 });
    expect(listener).not.toHaveBeenCalled();
    views.dispose();
    active = true;
    await service.updateConfig({ requestsPerSecond: 5 });
    expect(listener).not.toHaveBeenCalled();
    off();
  } finally { views.dispose(); service.dispose(); }
});
