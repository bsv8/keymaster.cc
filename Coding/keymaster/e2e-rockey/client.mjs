import { openWindowUsbBridge } from "../vaultlink-integration/src/usb-bridge.ts";
// 与生产页面同一字节桥、MessagePort 租约及 WorkerUsbTransport。
export class KeymasterRocKeyJourney {
  next = 1;
  pending = new Map();
  constructor() {
    this.worker = new Worker("/keymaster-worker.js", { type: "module" });
    this.worker.onmessage = ({ data: m }) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) {
        console.info("[RocKey E2E] Worker rejected: " + m.error);
        p.reject(Error(m.error));
      } else p.resolve(m.value);
    };
    this.worker.onerror = () =>
      this.fail(Error("keymaster-test-worker-failed"));
  }
  rpc(action, input = {}, transfer = []) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("keymaster-test-timeout: " + action));
      }, 120000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, action, input }, transfer);
    });
  }
  async enroll(link) {
    this.bridge = await openWindowUsbBridge(
      link.serialFacade(),
      navigator.locks,
    );
    return this.rpc(
      "enroll",
      {
        port: this.bridge.port,
        leaseId: this.bridge.lease,
        label: "RocKey E2E",
        walletGeneration: crypto.randomUUID(),
      },
      [this.bridge.port],
    );
  }
  payment(command) {
    return this.rpc("payment", command);
  }
  fail(e) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
  async close() {
    try {
      await this.rpc("close");
    } finally {
      await this.bridge?.close();
      this.fail(Error("test-journey-closed"));
      this.worker.terminate();
    }
  }
}
