import { defineBuiltinWorkerPlugin, emptyChainHeightSnapshot, WOC_CAPABILITY, WOC_WORKER_BROADCAST_CAPABILITY, WOC_BSV21_CAPABILITY, WOC_STAS_CAPABILITY, WOC_1SAT_ORDINALS_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, type BsvNetwork, type ChainHeightSnapshot, type WocQueueSnapshot, type WorkerTaskRegistrar } from "@keymaster/contracts";
import type { MessageBus } from "webloom-framework";
import { createWocService, createWocBsv21Service, createWocStasService, createWoc1SatOrdinalsService } from "./coordinator.js";
import { createWorkerWocViews } from "./workerWocViews.js";
import { createChainFeeRuntime } from "./chainFeeRuntime.js";
import { createChainHeightTask } from "./chainHeightTask.js";

export interface WocWorkerPorts {
  tasks: WorkerTaskRegistrar;
  settings(): Readonly<Record<string, unknown>> | undefined;
  queueChanged(snapshot: WocQueueSnapshot): void;
  publishHeight(snapshot: ChainHeightSnapshot): void;
  feePolicies(): import("@keymaster/contracts").ChainFeePolicies;
  publishFees(snapshots: import("@keymaster/contracts").ChainFeeSnapshots): void;
}

/** 每次 setup 创建独立服务；链高度投影由 WOC 所有，Host 只转发事件。 */
export function createWocWorkerRuntime(ports: WocWorkerPorts) {
  const fees = createChainFeeRuntime({ policies: ports.feePolicies, publish: ports.publishFees });
  let height = emptyChainHeightSnapshot();
  const snapshot = () => ({ ...height });
  function createService(messageBus: MessageBus) {
    const service = createWocService({ messageBus });
    const config = ports.settings();
    if (config) {
      const next: Partial<import("@keymaster/contracts").WocConfig> = {};
      if (typeof config.endpoint === "string" && config.endpoint.trim()) next.baseUrl = config.endpoint.trim();
      if (typeof config.requestsPerSecond === "number") next.requestsPerSecond = config.requestsPerSecond;
      if (Object.keys(next).length) service.updateConfig(next);
    }
    return service;
  }
  function heightTask(network: () => BsvNetwork, readHeight: (network: BsvNetwork, signal: AbortSignal) => Promise<number>) {
    return createChainHeightTask({
      network, readHeight, snapshot,
      publish(next) { height = next; ports.publishHeight(snapshot()); },
    });
  }
  const plugin = defineBuiltinWorkerPlugin("woc", [WOC_CAPABILITY, WOC_WORKER_BROADCAST_CAPABILITY, WOC_BSV21_CAPABILITY, WOC_STAS_CAPABILITY, WOC_1SAT_ORDINALS_CAPABILITY], async context => {
    const service = createService(context.messageBus);
    context.onDispose(() => service.dispose());
    const removeQueueListener = service.onQueueChange(ports.queueChanged);
    context.scope.onRevoke(removeQueueListener);
    context.onDispose(removeQueueListener);
    const views = createWorkerWocViews(service, () => context.scope.assertActive());
    context.scope.onRevoke(views.dispose);
    context.provide(WOC_CAPABILITY, views.query);
    context.provide(WOC_WORKER_BROADCAST_CAPABILITY, views.broadcast);
    context.provide(WOC_BSV21_CAPABILITY, createWocBsv21Service({ messageBus: context.messageBus }));
    context.provide(WOC_STAS_CAPABILITY, createWocStasService({ messageBus: context.messageBus }));
    context.provide(WOC_1SAT_ORDINALS_CAPABILITY, createWoc1SatOrdinalsService({ messageBus: context.messageBus }));
    const wallet = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope);
    const task = heightTask(() => {
      context.scope.assertActive();
      const identity = wallet.snapshot().activeKeyIdentity;
      if (!identity) throw new Error("WOC requires a network identity");
      return identity.bsvNetwork;
    }, (network, signal) => views.query.getChainHeight(network, { priority: "background", signal }));
    const feeTask = fees.task(() => { context.scope.assertActive(); const identity = wallet.snapshot().activeKeyIdentity; if (!identity) throw new Error("WOC requires a network identity"); return identity.bsvNetwork; }, (network, signal) => views.query.getFeeRecommendation(network, { priority: "background", signal }));
    const feeRegistration = await ports.tasks.register(feeTask, () => context.scope.assertActive());
    context.scope.onRevoke(feeRegistration.revoke);
    context.onDispose(feeRegistration.dispose);
    const registration = await ports.tasks.register(task, () => context.scope.assertActive());
    context.scope.onRevoke(registration.revoke);
    context.onDispose(registration.dispose);
  });
  return { plugin, snapshot, fees, createService, heightTask, resetHeight: () => { height = emptyChainHeightSnapshot(); } };
}
