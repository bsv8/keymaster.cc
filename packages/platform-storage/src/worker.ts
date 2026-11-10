import { STORAGE_PRIVATE_S3_CAPABILITY } from "./connect-s3/protocol.js";
import {
  defineBuiltinWorkerPlugin, STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY,
  COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY,
} from "@keymaster/contracts";
import type { LocalServiceOf, RpcHandler } from "webloom-framework";
import { STORAGE_PRIVATE_BROWSE_CAPABILITY, projectStorageBrowseResponse, type StorageBrowsePrivateCommand } from "./assembly.js";

export function createStorageWorkerPlugin(ports: {
  files: LocalServiceOf<typeof STORAGE_FILE_CLIENTS_CAPABILITY>;
  keyValues: LocalServiceOf<typeof STORAGE_KV_CLIENTS_CAPABILITY>;
  owner: RpcHandler<typeof COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY>;
  platform: RpcHandler<typeof COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY>;
  authorize(call: import("webloom-framework").HandlerCallContext): string;
  browse(request: StorageBrowsePrivateCommand, peerId: string, signal: AbortSignal): Promise<import("@keymaster/contracts").CoordinatorResponse>;
  s3(request: import("./connect-s3/protocol.js").ConnectS3Request, signal: AbortSignal): Promise<import("./connect-s3/protocol.js").ConnectS3Response>;
  revokeBrowse(): void;
  revokeS3(): void;
}) {
  return defineBuiltinWorkerPlugin("storage", [STORAGE_FILE_CLIENTS_CAPABILITY, STORAGE_KV_CLIENTS_CAPABILITY,
    COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY, STORAGE_PRIVATE_BROWSE_CAPABILITY, STORAGE_PRIVATE_S3_CAPABILITY], context => {
      context.provide(STORAGE_FILE_CLIENTS_CAPABILITY, ports.files);
      context.provide(STORAGE_KV_CLIENTS_CAPABILITY, ports.keyValues);
      context.handle(COORDINATOR_OWNER_STORAGE_RPC_CAPABILITY, ports.owner);
      context.handle(COORDINATOR_PLATFORM_STORAGE_RPC_CAPABILITY, ports.platform);
      context.scope.onRevoke(ports.revokeBrowse);
      context.scope.onRevoke(ports.revokeS3);
      context.handlePrivate(STORAGE_PRIVATE_S3_CAPABILITY, async (request, call) => {
        ports.authorize(call);
        return ports.s3(request, call.signal);
      });
      context.handlePrivate(STORAGE_PRIVATE_BROWSE_CAPABILITY, async (request, call) => {
        const peerId = ports.authorize(call);
        const response = await ports.browse({ ...request, clientId: peerId, requestId: call.operationId ?? crypto.randomUUID() }, peerId, call.signal);
        const { requestId: _requestId, ...result } = response;
        return projectStorageBrowseResponse(request, result);
      });
    });
}

export { createStorageWorkerRequests, type CoordinatorStorageBinding } from "./workerRequests.js";

export { createStorageWorkerRoot } from "./workerRoot.js";

export { createStorageWorkerControl } from "./workerControl.js";
export type { ConnectS3Config, ConnectS3Summary, ConnectS3Request, ConnectS3Response, ConnectS3Failure } from "./connect-s3/protocol.js";
export type { ConnectFileStore } from "./connect-s3/fileStore.js";
