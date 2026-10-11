import { useEffect, useRef, useState } from "react";
import { Button } from "@keymaster/ui";
import type { SerialPortLike } from "@vaultlink/sdk";
import { openWindowUsbBridge } from "./usb-bridge.js";
import type { HardwareConnectionState } from "./hardware-connection.js";

type Command = {action: "enroll"; port: MessagePort; leaseId: string; label: string} | { action: "state" } | { action: "attach"|"recover"|"recover-erased"|"provision"|"recover-import"; port: MessagePort; leaseId: string }
  | { action: "disconnect"; leaseId: string };
export function HardwareConnectionPanel({ execute, text, enrollmentLabel, preserveConnectionOnUnmount, recovery, erasedRecovery, provisioning, onStateChange }: {
  execute(command: Command): Promise<HardwareConnectionState>;
  text(key: string, fallback: string): string;
  enrollmentLabel?: string;
  recovery?:boolean;
  provisioning?:boolean;
  /** 父流程只有在设备确认配对与持有权证明完成后才能开放迁移。 */
  onStateChange?(state: HardwareConnectionState): void;
  /** User reports the old hardware key is already erased. The Worker still
   * requires a validated local-committed journal and a separate receipt-only connection. */
  erasedRecovery?:boolean;
  /** 欢迎页把 USB 租约交给 Worker 后卸载仍保留连接，不依赖状态广播顺序；调用方主动返回须 disconnect。 */
  preserveConnectionOnUnmount?(): boolean;
}) {
  const [state, setState] = useState<HardwareConnectionState>({ status: "disconnected" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const bridge = useRef<Awaited<ReturnType<typeof openWindowUsbBridge>>>();
  const generation = useRef(0);
  const transferred = useRef(false);
  const preserve = useRef(preserveConnectionOnUnmount); preserve.current = preserveConnectionOnUnmount;
  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);
  useEffect(() => {
    const captured = ++generation.current;
    let reading = false;
    const refresh = async () => {
      if (reading) return; reading = true;
      try { const value = await execute({ action: "state" }); if (generation.current === captured) setState(value); }
      catch (e) { if (generation.current === captured) setError(e instanceof Error ? e.message : String(e)); }
      finally { reading = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 750);
    const close = () => {
      const current = bridge.current; bridge.current = undefined;
      // 首次绑定会切换欢迎页，可能早于页面的 unlocked 投影更新。
      // 已转交的 enrollment 租约归 Window/Worker；主动返回须显式 disconnect。
      const retained = enrollmentLabel !== undefined || preserve.current?.();
      if (current && (!transferred.current || !retained)) void current.close();
    };
    // attach 后由 Window bridge 的 pagehide 与 Worker close 管理租约。
    // 正常解锁会卸载登录页，不能因此又关闭设备、把钱包锁回去。
    return () => { generation.current++; clearInterval(timer); close(); };
  }, [execute, enrollmentLabel]);

  async function connect() {
    const captured = generation.current;
    setBusy(true); setError("");
    try {
      const serial = (navigator as unknown as { serial?: { requestPort(): Promise<SerialPortLike> } }).serial;
      if (!serial || !navigator.locks) throw new Error(text("unavailable", "此浏览器不支持所需的 USB 串口连接。"));
      // requestPort 必须在这次真实点击里调用；PIN 只在设备输入。
      const port = await serial.requestPort();
      const opened = await openWindowUsbBridge(port, navigator.locks);
      if (generation.current !== captured) { await opened.close(); return; }
      bridge.current = opened; transferred.current = true;
      const value = await execute(enrollmentLabel === undefined ? { action: provisioning?(recovery?"recover-import":"provision"):erasedRecovery?"recover-erased":recovery?"recover":"attach", port: opened.port, leaseId: opened.lease }
        : {action: "enroll", port: opened.port, leaseId: opened.lease, label: enrollmentLabel});
      if (generation.current !== captured) return;
      setState(value);
    } catch (e) {
      const current = bridge.current; bridge.current = undefined; transferred.current = false; await current?.close();
      if (generation.current === captured) setError(e instanceof Error ? e.message : String(e));
    } finally { if (generation.current === captured) setBusy(false); }
  }
  async function disconnect() {
    const current = bridge.current; bridge.current = undefined;
    try { if (state.leaseId) await execute({ action: "disconnect", leaseId: state.leaseId }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { await current?.close(); setState({ status: "disconnected" }); }
  }
  return <div>
    <p>{text("instructions", "先在设备上输入 PIN 解锁 RocKey，再连接 USB 并核对两端配对码。")}</p>
    {state.status === "pairing" ? <div>
      <p>{text("pairing", "核对两端配对码，在 RocKey 上长按确认：")} <strong>{state.pairingCode}</strong></p>
    </div> : state.status === "connected" ? <p role="status">{text("connected", "RocKey 已验证连接。")}</p>
      : <Button onClick={() => void connect()} loading={busy} disabled={busy || state.status !== "disconnected"}>{text("connect", "连接 RocKey")}</Button>}
    {state.leaseId ? <Button variant="ghost" onClick={() => void disconnect()}>{text("disconnect", "断开连接")}</Button> : null}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
