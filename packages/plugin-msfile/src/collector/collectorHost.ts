// Worker 侧采集宿主：按 owner 持有采集服务实例，随会话世代自停。
// 控制面在锁定时被顶层门禁拦截；定时器每次触发前复核存活，失效即自停。

import type { ActiveKeyCrypto, BorrowedModuleFileStore } from "@keymaster/contracts";
import { CollectorService } from "./collectorService.js";

export interface CollectorHostDeps {
  /** owner 文件句柄（msfiles 根）。 */
  files: BorrowedModuleFileStore;
  /** owner 的 Vault 签名能力。 */
  crypto: () => Promise<ActiveKeyCrypto>;
  /** 会话存活判定（epoch 一致且已解锁）。 */
  isAlive: () => boolean;
  /** dev 诊断开关。 */
  diagnostics: boolean;
}

const instances = new Map<string, { epoch: string; service: CollectorService }>();

/** 取当前 owner 的采集服务；世代变化时重建（旧实例自停）。 */
export function collectorForOwner(owner: string, epoch: string, deps: CollectorHostDeps): CollectorService {
  const current = instances.get(owner);
  if (current && current.epoch === epoch) return current.service;
  current?.service.stop();
  const service = new CollectorService({
    files: deps.files,
    crypto: deps.crypto,
    isAlive: deps.isAlive,
    diagnostics: deps.diagnostics,
  });
  service.start();
  instances.set(owner, { epoch, service });
  return service;
}

/** 停止指定 owner 的采集服务（测试与显式清理用）。 */
export function stopCollectorForOwner(owner: string): void {
  const current = instances.get(owner);
  if (current) {
    current.service.stop();
    instances.delete(owner);
  }
}
