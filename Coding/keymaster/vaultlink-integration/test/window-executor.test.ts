// 生命周期回归执行真实 Coordinator、KeyHold/IndexedDB、钱包授权、libp2p Host 和 lane 注册表。
// 只接入宿主端口与用户注册确认流程，不替换签名、Host 或业务响应。
import { expect, test } from "vitest";
import type {
  WindowP2pCoordinatorControl,
  WindowP2pExecutorLaneContext,
  CoordinatorClientRequest,
  CoordinatorResponse,
  CoordinatorTopic,
  CoordinatorValueResult,
} from "@keymaster/contracts";
import { WindowP2pExecutor } from "../../../../packages/plugin-window-p2p/src/windowExecutor.js";
import { createWindowP2pLaneRegistry } from "../../../../packages/plugin-window-p2p/src/laneRegistry.js";
import {
  __testResetWalletStore,
  __testBootstrapWalletStorage,
  __testDispatchStorageControl,
  __testAttachPort,
  __testDispatchStorageMessage,
  __testGetSnapshot,
  __testGetChainHeight,
  __testLock,
} from "../../../../apps/web/src/keymasterSessionCoordinator.worker.js";

async function fixture() {
  await __testResetWalletStore();
  await __testBootstrapWalletStorage();
  const initialized = await __testDispatchStorageControl({
    type: "initialize",
    plan: {
      transactionId: crypto.randomUUID(),
      firstKey: {
        kind: "import",
        bsvNetwork: "main",
        label: "network-test",
        format: "hex",
        material: { hex: "00".repeat(31) + "01" },
        capabilities: ["p2pkh"],
        password: "network-test-password",
      },
    },
  });
  expect(initialized.ack.status, JSON.stringify(initialized.ack)).toBe("ok");
  const peer = "real-window-" + crypto.randomUUID(),
    responses = new Map<string, CoordinatorResponse>(),
    listeners = new Map<CoordinatorTopic, Set<(event: unknown) => void>>();
  let connected = true;
  __testAttachPort(peer, (message) => {
    const data = message as CoordinatorResponse & { topic?: CoordinatorTopic };
    if (data.requestId) responses.set(data.requestId, data);
    if (data.topic)
      for (const listener of listeners.get(data.topic) ?? []) listener(data);
  });
  async function dispatch(kind: string, fields: Record<string, unknown> = {}) {
    const requestId = crypto.randomUUID();
    await __testDispatchStorageMessage(peer, {
      kind,
      clientId: peer,
      requestId,
      expectedSessionEpoch: __testGetSnapshot().sessionEpoch,
      ...fields,
    } as CoordinatorClientRequest);
    const result = responses.get(requestId);
    responses.delete(requestId);
    if (!result) throw Error("missing actual Coordinator response");
    return result;
  }
  async function value<T>(
    kind: string,
    fields: Record<string, unknown>,
  ): Promise<CoordinatorValueResult<T>> {
    const r = await dispatch(kind, fields);
    return r.ack.status === "ok"
      ? {
          status: "ok",
          value: r.operationResult as T,
          sessionEpoch: r.sessionEpoch,
        }
      : r.ack;
  }
  const released: string[] = [];
  const control: WindowP2pCoordinatorControl = {
    async connect() {
      if (!connected) throw Error("closed test port");
    },
    getIsConnected: () => connected,
    getConnectionState: () => (connected ? "ready" : "recoverable"),
    getBootstrapSnapshot: __testGetSnapshot,
    getSessionEpoch: () => __testGetSnapshot().sessionEpoch,
    getActivePublicKeyHex: () => __testGetSnapshot().activePublicKeyHex,
    getChainHeightSnapshot: __testGetChainHeight,
    subscribeTopic(topic, listener) {
      let set = listeners.get(topic);
      if (!set) {
        set = new Set();
        listeners.set(topic, set);
      }
      set.add(listener);
      void dispatch("subscribe", { topics: [topic] });
      return () => set!.delete(listener);
    },
    sendActivity() {
      void dispatch("activity");
    },
    windowP2pExecutorAcquire: (ownerPublicKeyHex, executorPort) =>
      value("window-p2p.executor.acquire", { ownerPublicKeyHex, executorPort }),
    async windowP2pExecutorRelease(leaseId) {
      const r = await dispatch("window-p2p.executor.release", { leaseId });
      if (r.ack.status === "ok") released.push(leaseId);
      return r.ack;
    },
    windowP2pExecutorSpikeTransfer: (leaseId, expectedSessionEpoch, bytes) =>
      value("window-p2p.executor.spike.transfer", {
        leaseId,
        expectedSessionEpoch,
        bytes,
      }),
    windowP2pExecutorSignNoiseStaticKey: (input) =>
      value("window-p2p.executor.identity.sign-noise", {
        ...input,
        expectedSessionEpoch:
          input.expectedSessionEpoch ?? __testGetSnapshot().sessionEpoch,
      }),
    windowP2pExecutorSignPeerRecord: (input) =>
      value("window-p2p.executor.identity.sign-peer-record", {
        ...input,
        expectedSessionEpoch:
          input.expectedSessionEpoch ?? __testGetSnapshot().sessionEpoch,
      }),
  };
  let approving = false;
  const approvals = setInterval(() => {
    if (approving) return;
    approving = true;
    void (async () => {
      const r = await dispatch("vault.operation", {
        operation: { type: "payment", command: { action: "pending" } },
      });
      if (r.ack.status !== "ok") return;
      for (const p of r.operationResult as {
        id: string;
        purpose?: string;
        operation?: string;
        mode?: string;
      }[]) {
        const allow =
          p.purpose === "registration" &&
          p.operation?.startsWith("identity.") &&
          p.mode === "automatic";
        await dispatch("vault.operation", {
          operation: {
            type: "payment",
            command: { action: "answer", id: p.id, allow },
          },
        });
      }
    })().finally(() => {
      approving = false;
    });
  }, 20);
  return {
    control,
    released,
    async close() {
      clearInterval(approvals);
      connected = false;
      listeners.clear();
      await __testLock();
      await __testResetWalletStore();
    },
  };
}
function inspector(
  input: {
    attach?: (context: WindowP2pExecutorLaneContext) => Promise<void>;
    stop?: () => Promise<void>;
  } = {},
) {
  const registry = createWindowP2pLaneRegistry();
  const contexts: WindowP2pExecutorLaneContext[] = [];
  registry.register({
    laneId: "inspection",
    async start(context) {
      contexts.push(context);
      await input.attach?.(context);
    },
    async stop() {
      await input.stop?.();
    },
    async handle() {
      throw Error("inspection has no business operation");
    },
  });
  return { registry, contexts };
}
const status = (context: WindowP2pExecutorLaneContext) =>
  (context.host as { status: string }).status;

test("真实 Window executor 创建 Host，锁定后撤销 lease 并关闭 Host，dispose 幂等", async () => {
  const f = await fixture(),
    lane = inspector(),
    executor = new WindowP2pExecutor({
      coordinator: f.control,
      laneRegistry: lane.registry,
    });
  try {
    expect(await executor.start()).toBe(true);
    expect(lane.contexts.length).toBe(1);
    expect(status(lane.contexts[0]!)).toBe("started");
    await __testLock();
    await executor.reconcileSession(__testGetSnapshot());
    expect(status(lane.contexts[0]!)).toBe("stopped");
    await executor.dispose();
    expect(executor.isDisposed).toBe(true);
  } finally {
    await executor.dispose();
    await f.close();
  }
}, 60000);

test("真实 Worker lease 先于等待中的 lane 清理释放，新的 executor 可以获得 lease", async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lane = inspector({ stop: () => blocked }),
    executor = new WindowP2pExecutor({
      coordinator: f.control,
      laneRegistry: lane.registry,
    });
  let stopped: Promise<void> | undefined;
  const ports = new MessageChannel();
  try {
    expect(await executor.start()).toBe(true);
    stopped = executor.stop();
    await expect.poll(() => f.released.length).toBe(1);
    const next = await f.control.windowP2pExecutorAcquire(
      __testGetSnapshot().activePublicKeyHex!,
      ports.port2,
    );
    expect(next.status).toBe("ok");
    if (next.status === "ok")
      await f.control.windowP2pExecutorRelease(next.value.leaseId);
    release();
    await stopped;
    expect(status(lane.contexts[0]!)).toBe("stopped");
  } finally {
    release();
    await stopped;
    ports.port1.close();
    ports.port2.close();
    await executor.dispose();
    await f.close();
  }
}, 60000);

test("lane attach 尚未完成时 stop 胜出，真实 Host 被关闭，不发表就绪", async () => {
  const f = await fixture();
  let finish!: () => void;
  const attached = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const lane = inspector({
      attach: () => attached,
      stop: async () => {
        finish();
      },
    }),
    executor = new WindowP2pExecutor({
      coordinator: f.control,
      laneRegistry: lane.registry,
    });
  try {
    const start = executor.start();
    await expect.poll(() => lane.contexts.length).toBe(1);
    await executor.stop();
    finish();
    expect(await start).toBe(false);
    expect(status(lane.contexts[0]!)).toBe("stopped");
  } finally {
    finish();
    await executor.dispose();
    await f.close();
  }
}, 60000);

test("同一网络 Key 重新解锁进入新 epoch，旧 Host 已停止，新 Host 使用新 Noise 证明", async () => {
  const f = await fixture(),
    lane = inspector(),
    executor = new WindowP2pExecutor({
      coordinator: f.control,
      laneRegistry: lane.registry,
    });
  try {
    expect(await executor.start()).toBe(true);
    const epoch = __testGetSnapshot().sessionEpoch;
    await __testLock();
    await executor.reconcileSession(__testGetSnapshot());
    expect(status(lane.contexts[0]!)).toBe("stopped");
    const unlocked = await __testDispatchStorageControl({
      type: "unlock",
      password: "network-test-password",
    });
    expect(unlocked.ack.status).toBe("ok");
    expect(__testGetSnapshot().sessionEpoch).not.toBe(epoch);
    expect(await executor.start()).toBe(true);
    expect(lane.contexts.length).toBe(2);
    expect(lane.contexts[1]!.host).not.toBe(lane.contexts[0]!.host);
    expect(status(lane.contexts[1]!)).toBe("started");
  } finally {
    await executor.dispose();
    await f.close();
  }
}, 60000);
