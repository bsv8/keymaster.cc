// 真机只读检查：使用正式 VLP SDK、物理 USB 与设备配对，不注入按键或测试密钥。
// 不注册渠道、不改设置、不提交支付，也不导出私钥。私钥仍只在设备中持有。
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { VaultLinkHardwareBackend } from "../dist/index.js";
const python =
  process.env.ROCKEY_PYTHON ??
  fileURLToPath(
    new URL(
      "../../../../../BSV8_VaultLinkProtocol/Coding/BSV8_VaultLinkProtocol/.tools/venv/bin/python",
      import.meta.url,
    ),
  );
const port = process.argv[2] ?? "/dev/cu.usbserial-02010546";
// 唯一串口读者原样转发加密帧；先关闭 DTR/RTS，再打开串口，避免因连接而复位设备。
const bridge = String.raw`
import os,sys,threading
import serial
from serial.tools import list_ports
port=sys.argv[1]
p=next((p for p in list_ports.comports() if p.device==port),None)
if p is None or p.vid!=0x10c4 or p.pid!=0xea60:
    raise RuntimeError('Expected CP2104 device is unavailable')
s=serial.Serial(port=None,baudrate=115200,timeout=0.2,write_timeout=5,exclusive=True)
s.dtr=False;s.rts=False;s.port=port;s.open()
def read():
    while s.is_open:
        try:
            b=s.read(max(1,s.in_waiting))
            if b:sys.stdout.buffer.write(b);sys.stdout.buffer.flush()
        except serial.SerialException:os._exit(1)
threading.Thread(target=read,daemon=True).start()
try:
    while True:
        b=os.read(sys.stdin.fileno(),16384)
        if not b:break
        s.write(b);s.flush()
finally:s.close()
`;
const child = spawn(python, ["-u", "-c", bridge, port], {
  stdio: ["pipe", "pipe", "inherit"],
});
const exited = once(child, "exit");
const input = child.stdout[Symbol.asyncIterator]();
let stopped = false,
  backend;
const transport = {
  async read() {
    const row = await input.next();
    return row.done ? null : new Uint8Array(row.value);
  },
  async write(bytes) {
    await new Promise((resolve, reject) =>
      child.stdin.write(bytes, (error) => (error ? reject(error) : resolve())),
    );
  },
  async close() {
    if (stopped) return;
    stopped = true;
    child.stdin.end();
    child.kill("SIGTERM");
    await exited;
  },
};
try {
  const result = await VaultLinkHardwareBackend.enroll(
    transport,
    {
      generations: {
        walletGeneration: 1,
        backendGeneration: 1,
        hostRunGeneration: 1,
      },
      assertActive() {
        if (stopped) throw Error("usb-check-closed");
      },
    },
    async (code) => {
      console.log(
        "配对核对码：" + code + "；请与设备屏幕核对，仅在设备上长按同意。",
      );
      return true;
    },
  );
  backend = result.backend;
  const channels = await backend.listChannels(),
    signing = await backend.listSigningChannels();
  if (!Array.isArray(channels) || !Array.isArray(signing.channels))
    throw Error("invalid-policy-list");
  console.log(
    JSON.stringify(
      {
        status: "passed",
        checks: [
          "physical-usb",
          "encrypted-pairing",
          "fresh-key-possession-proof",
          "network-identity",
          "payment-policy-read",
          "signing-policy-read",
        ],
        bsvNetwork: result.bsvNetwork,
        publicKeyFingerprint: createHash("sha256")
          .update(result.publicKeyHex)
          .digest("hex")
          .slice(0, 16),
        paymentChannels: channels.length,
        signingChannels: signing.channels.length,
      },
      null,
      2,
    ),
  );
} finally {
  if (backend) await backend.close();
  await transport.close();
}
