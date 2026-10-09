import type { Page } from "@playwright/test";

/** Chromium page console omits SharedWorker exceptions; capture only our diagnostics. */
export async function captureCoordinatorWorkerConsole(page: Page, log: (message: string) => void, prefixes: readonly string[] = ["[coordinator]"]): Promise<() => Promise<void>> {
  const browser = page.context().browser();
  if (!browser) throw new Error("Worker diagnostics require Chromium");
  const client = await browser.newBrowserCDPSession();
  const sessions: string[] = [];
  let nextId = 10;
  const pending = new Map<number, { prefix: string; timer: ReturnType<typeof setTimeout> }>();
  client.on("Target.receivedMessageFromTarget", event => {
    const message = JSON.parse(event.message) as { id?: number; result?: { result?: Array<{ name: string; value?: {value?: unknown} }> }; method?: string; params?: { args?: Array<{value?: unknown; objectId?: string; preview?: {properties?: Array<{name: string; value?: string}>}}> } };
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (request) {
        clearTimeout(request.timer); pending.delete(message.id);
        const properties = (message.result?.result ?? []).filter(property => property.value?.value !== undefined);
        log(request.prefix + " " + JSON.stringify(Object.fromEntries(properties.map(property => [property.name, property.value!.value]))));
      }
      return;
    }
    if (message.method !== "Runtime.consoleAPICalled") return;
    const text = message.params?.args?.map(arg => typeof arg.value === "string" ? arg.value : arg.preview?.properties ? JSON.stringify(Object.fromEntries(arg.preview.properties.map(property => [property.name, property.value]))) : "").join(" ") ?? "";
    if (prefixes.some(prefix => text.startsWith(prefix))) {
      log(text);
      for (const arg of message.params?.args ?? []) if (arg.objectId && !arg.preview) {
        const id = nextId++;
        pending.set(id, { prefix: text, timer: setTimeout(() => pending.delete(id), 2000) });
        void client.send("Target.sendMessageToTarget", { sessionId: event.sessionId, message: JSON.stringify({ id, method: "Runtime.getProperties", params: { objectId: arg.objectId, ownProperties: true } }) }).catch(() => undefined);
      }
    }
  });
  const targets = await client.send("Target.getTargets");
  for (const target of targets.targetInfos.filter(value => value.type === "shared_worker")) {
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: false });
    sessions.push(sessionId);
    await client.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 1, method: "Runtime.enable" }) });
  }
  return async () => {
    for (const request of pending.values()) clearTimeout(request.timer);
    pending.clear();
    for (const sessionId of sessions) await client.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    await client.detach();
  };
}
