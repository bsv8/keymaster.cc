import { definePlugin, type Capability, type PluginSetup } from "webloom-framework";
import { BUILTIN_PLUGIN_DEFINITIONS } from "./generated/pluginDefinitions.js";
import type { BackgroundTaskDefinition } from "./background.js";

/** Worker 实现复用静态目录；声明缺失或 capability 不一致立即失败。 */
export function defineBuiltinWorkerPlugin(productId: string, capabilities: readonly Capability[], setup: PluginSetup) {
  const product = BUILTIN_PLUGIN_DEFINITIONS.find(product => product.id === productId);
  const units = product?.units.filter(unit => unit.runtime === "shared-worker") ?? [];
  const unit = units.length === 1 ? units[0] : undefined;
  if (!product || !unit) throw new Error(`Missing Worker declaration: ${productId}`);
  const resolve = (descriptor: { kind: string; id: string; version: string }) => {
    const capability = capabilities.find(candidate => candidate.kind === descriptor.kind && candidate.id === descriptor.id && candidate.version === descriptor.version);
    if (!capability) throw new Error(`Missing Worker capability: ${productId}/${descriptor.id}`);
    return capability;
  };
  return definePlugin({
    id: product.id, name: product.name, unitId: unit.id, runtime: "shared-worker",
    provides: unit.provides.map(resolve), privateProvides: unit.privateProvides.map(resolve),
    dependencies: unit.dependencies, permissions: unit.permissions, setup,
  });
}

/** 任务定义归插件；调度器返回可取消且可等待的注册句柄。 */
export interface WorkerTaskRegistration {
  revoke(): void;
  dispose(): Promise<void>;
}

export interface WorkerTaskRegistrar {
  register(task: BackgroundTaskDefinition & { unitId: string; syncPolicy?: "managed" | "smart" | "fixed" }, assertActive: () => void): Promise<WorkerTaskRegistration>;
}

/** 公共准入只返回本次调用的有效性检查，不泄露可变 peer/session。 */
export interface WorkerCallAdmission {
  authorize(call: import("webloom-framework").HandlerCallContext): () => void;
}

/** 插件声明自己的并发/撤销策略；公共准入不解析领域命令。 */
export interface WorkerRequestPolicy {
  scheduling: "serial" | "parallel";
  cleanupOnly?: boolean;
  activatesWallet?: boolean;
  validateEpoch?: boolean;
}
export interface WorkerRequestCall { peerId: string; requestId: string; signal?: AbortSignal }
export interface WorkerRequestPreparation { signal?: AbortSignal; dispose(response?: import("./sessionCoordinator.js").CoordinatorResponse): void }
export interface WorkerRequestRoute {
  kinds: readonly string[];
  policy(request: { kind: string }): WorkerRequestPolicy;
  execute(request: { kind: string }, call: WorkerRequestCall): Promise<import("./sessionCoordinator.js").CoordinatorResponse>;
  stale?(request: { kind: string }, call: WorkerRequestCall): Promise<import("./sessionCoordinator.js").CoordinatorResponse | undefined>;
  prepare?(request: { kind: string }, call: WorkerRequestCall): WorkerRequestPreparation;
}
/** 外部输入已由 typed RPC parser 校验；这里只收口 union 的 kind 分发。 */
export function defineWorkerRequestRoute<Request extends { kind: string }>(definition: {
  kinds: readonly Request["kind"][];
  policy(request: Request): WorkerRequestPolicy;
  execute(request: Request, call: WorkerRequestCall): Promise<import("./sessionCoordinator.js").CoordinatorResponse>;
  stale?(request: Request, call: WorkerRequestCall): Promise<import("./sessionCoordinator.js").CoordinatorResponse | undefined>;
  prepare?(request: Request, call: WorkerRequestCall): WorkerRequestPreparation;
}): WorkerRequestRoute {
  const narrow = (request: { kind: string }): Request => {
    if (!definition.kinds.includes(request.kind)) throw new Error(`Worker route does not own ${request.kind}`);
    return request as Request;
  };
  return {
    kinds: definition.kinds,
    policy: request => definition.policy(narrow(request)),
    execute: (request, call) => definition.execute(narrow(request), call),
    ...(definition.stale ? { stale: (request, call) => definition.stale!(narrow(request), call) } : {}),
    ...(definition.prepare ? { prepare: (request, call) => definition.prepare!(narrow(request), call) } : {}),
  };
}
