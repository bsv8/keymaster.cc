import { bitfsDebug, setBitfsDebugSink } from "go-bitfs";

/** 由产品 dev 装配调用；不写应用存储，SDK 和宿主使用同一结构化出口。 */
export function configureBitfsDebug(enabled: boolean): void {
  setBitfsDebugSink(enabled ? event => console.debug(`[bitfs-debug] ${JSON.stringify(event)}`) : undefined);
}
export function traceBitfs(event: string, details: () => unknown = () => ({})): void {
  bitfsDebug("keymaster.cc", event, details);
}
