// 独立 E2E 装配，不挂到 Keymaster 页面 RPC。使用正式连接所有者和付款服务。
import { HardwareConnectionOwner } from "../vaultlink-integration/src/hardware-connection.js";
import { HardwareWalletPayments } from "../vaultlink-integration/src/hardware-payments.js";
const peerId = "rockey-product-e2e";
let live = true;
const guard = () => {
  if (!live) throw Error("test-wallet-closed");
};
const owner = new HardwareConnectionOwner(guard);
let payments: HardwareWalletPayments | undefined;
self.addEventListener("message", async (event: MessageEvent) => {
  const { id, action, input } = event.data;
  try {
    let value: unknown;
    if (action === "enroll") {
      value = await owner.enroll({ ...input, peerId, assertRecordLive: guard });
      payments = new HardwareWalletPayments(owner.backend(), guard);
    } else if (action === "state") value = owner.state();
    else if (action === "document") value = owner.verifiedDocument();
    else if (action === "payment") {
      if (!payments) throw Error("hardware-disconnected");
      value = await payments.handle(input);
    } else if (action === "session-read")
      value = await owner.backend().readAppSession(input.id);
    else if (action === "close") {
      payments?.close();
      payments = undefined;
      await owner.close();
      value = true;
    } else if (action === "dispose") {
      await owner.close();
      live = false;
      value = true;
    } else throw Error("unknown-test-action");
    self.postMessage({ id, value });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
