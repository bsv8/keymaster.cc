import { traceDev } from "@keymaster/contracts";
import { bitfsDebug, setBitfsDebugSink } from "bitfs-protocol";
import { setDebugSink } from "keymaster-trade-scheduler";

/** 由产品 dev 装配调用；不写应用存储，SDK 和宿主使用同一结构化出口。 */
export function configureBitfsDebug(enabled: boolean): void {
  setBitfsDebugSink(enabled ? event => console.debug(`[bitfs-debug] ${JSON.stringify(event)}`) : undefined);
  // 调度器内核已有完整状态诊断；只在 dev 接到同一采集通道，production 明确关闭。
  setDebugSink(enabled ? event => traceDev("keymaster.trade-scheduler", event.event, () => event.details) : undefined);
}
export function traceBitfs(event: string, details: () => unknown = () => ({})): void {
  bitfsDebug("keymaster.cc", event, details);
}
