import { WINDOW_P2P_WORKER_BRIDGE_CAPABILITY } from "@keymaster/contracts/window-p2p";
import {
  defineBuiltinWorkerPlugin, FORUM_WORKER_NETWORK_CAPABILITY, FORUM_WORKER_SERVICE_CAPABILITY,
  FORUM_WORKER_ATTACHMENT_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, STORAGE_FILE_CLIENTS_CAPABILITY,
  MSFILE_CONTENT_CAPABILITY, VAULT_WORKER_CRYPTO_CAPABILITY, P2PKH_WORKER_PROTOCOL_CAPABILITY,
  WOC_CAPABILITY, type WorkerCallAdmission,
} from "@keymaster/contracts";
import { createForumWorkerService } from "./workerService.js";
import { executeForumWorkerRequest } from "./workerHandler.js";
import { streamForumAttachment } from "./attachmentStream.js";
import { createForumWorkerNetwork, type ForumWorkerExecutorBridge } from "./workerNetwork.js";
export { createForumWorkerNetwork, type ForumWorkerExecutorBridge, type ForumWorkerScope } from "./workerNetwork.js";

export function createForumWorkerPlugin(ports: { admission: WorkerCallAdmission }) {
  return defineBuiltinWorkerPlugin("forum", [FORUM_WORKER_NETWORK_CAPABILITY, FORUM_WORKER_SERVICE_CAPABILITY, FORUM_WORKER_ATTACHMENT_CAPABILITY], async context => {
    const bridge = context.capability(WINDOW_P2P_WORKER_BRIDGE_CAPABILITY).bind(context.consumer, context.scope);
    const network = createForumWorkerNetwork(bridge.request, context.scope,
      cancel => context.scope.onRevoke(reason => cancel(new Error(reason))));
    context.provide(FORUM_WORKER_NETWORK_CAPABILITY, network);
    const walletState = context.capability(VAULT_WALLET_STATE_CAPABILITY).bind(context.consumer, context.scope);
    const identity = walletState.snapshot();
    const owner = identity.activePublicKeyHex;
    if (!owner) throw new Error("Forum requires an active owner");
    const assertActive = () => {
      context.scope.assertActive();
      const current = walletState.snapshot();
      if (current.status !== "unlocked" || current.activePublicKeyHex !== owner || current.sessionEpoch !== identity.sessionEpoch) throw new Error("Forum owner session revoked");
    };
    let owned: Awaited<ReturnType<typeof createForumWorkerService>> | undefined;
    let starting: Promise<Awaited<ReturnType<typeof createForumWorkerService>>> | undefined;
    // 同步撤销阻止任务继续 mutation；异步 disposal 等待尚未完成的创建。
    context.scope.onRevoke(() => owned?.dispose());
    context.onDispose(async () => {
      try { await starting; } catch { /* 已撤销的创建在 ensure 中释放候选实例。 */ }
      owned?.dispose();
      owned = undefined;
    });
    const ensure = async () => {
      assertActive();
      if (owned) return owned;
      starting ??= (async () => {
        const candidate = await createForumWorkerService({
          owner, epoch: identity.sessionEpoch, assertActive, network, signal: context.scope.signal,
          storage: context.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(context.consumer, context.scope, ""),
          content: context.capability(MSFILE_CONTENT_CAPABILITY), crypto: context.capability(VAULT_WORKER_CRYPTO_CAPABILITY),
          wallet: context.capability(P2PKH_WORKER_PROTOCOL_CAPABILITY), query: context.capability(WOC_CAPABILITY),
        });
        try { assertActive(); } catch (error) { candidate.dispose(); throw error; }
        owned = candidate;
        return candidate;
      })();
      const pending = starting;
      try { return await pending; } finally { if (starting === pending) starting = undefined; }
    };
    context.handle(FORUM_WORKER_SERVICE_CAPABILITY, async (request, call) => {
      const assertAdmission = ports.admission.authorize(call);
      const assertCallActive = () => { assertActive(); assertAdmission(); };
      try {
        call.signal.throwIfAborted();
        const runtime = await ensure();
        return await executeForumWorkerRequest(runtime.service, request, AbortSignal.any([call.signal, context.scope.signal]), assertCallActive);
      } catch (error) {
        return { ok: false as const, code: "forum-worker-unavailable", message: error instanceof Error ? error.message : String(error) };
      }
    });
    context.handle(FORUM_WORKER_ATTACHMENT_CAPABILITY, async function*(request, call) {
      const assertAdmission = ports.admission.authorize(call);
      const assertCallActive = () => { assertActive(); assertAdmission(); };
      call.signal.throwIfAborted();
      const runtime = await ensure();
      yield* streamForumAttachment(runtime.service, request, AbortSignal.any([call.signal, context.scope.signal]), assertCallActive);
    });
  });
}
