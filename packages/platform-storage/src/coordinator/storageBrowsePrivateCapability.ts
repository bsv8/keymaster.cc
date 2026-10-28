import { defineCapability } from "webloom-framework";
import type { CoordinatorRpcResponse, SessionEpoch } from "@keymaster/contracts";
import type { StorageBrowsePage, StorageBrowsePreview, StorageBrowseSession } from "../runtime/storageBrowseTypes.js";

/** Trusted Storage package protocol, not a public Coordinator command. */
export type StorageBrowsePrivateData =
 | { type: "browse.list"; browseSessionId: string; prefix: string; cursor?: string; limit?: number }
 | { type: "browse.preview"; browseSessionId: string; path: string; ifRevision?: string };
export type StorageBrowsePrivateRequest =
 | { kind: "storage.browse.open"; expectedSessionEpoch: SessionEpoch }
 | { kind: "storage.browse.data"; data: StorageBrowsePrivateData; expectedSessionEpoch: SessionEpoch }
 | { kind: "storage.browse.close"; browseSessionId: string };
export type StorageBrowsePrivateCommand = StorageBrowsePrivateRequest & { clientId: string; requestId: string };

/** Project transport-owned headers away; the internal DTO itself is trusted. */
function browseRequest(value: unknown): StorageBrowsePrivateRequest {
  const request = value as StorageBrowsePrivateRequest;
  if (request.kind === "storage.browse.close") return { kind: request.kind, browseSessionId: request.browseSessionId };
  if (request.kind === "storage.browse.open") return { kind: request.kind, expectedSessionEpoch: request.expectedSessionEpoch };
  const data = request.data;
  return { kind: request.kind, expectedSessionEpoch: request.expectedSessionEpoch, data: data.type === "browse.list"
    ? { type: data.type, browseSessionId: data.browseSessionId, prefix: data.prefix, cursor: data.cursor, limit: data.limit }
    : { type: data.type, browseSessionId: data.browseSessionId, path: data.path, ifRevision: data.ifRevision } };
}

/** Publish only browse data; never forward internal records or crypto results. */
export function projectStorageBrowseResponse(request: StorageBrowsePrivateRequest, response: CoordinatorRpcResponse): CoordinatorRpcResponse {
  const { sessionEpoch, ack } = response;
  if (ack.status !== "ok" || request.kind === "storage.browse.close") return { sessionEpoch, ack };
  if (request.kind === "storage.browse.open") {
    const { browseSessionId, walletGeneration, sessionEpoch: epoch, runGeneration } = response.operationResult as StorageBrowseSession;
    return { sessionEpoch, ack, operationResult: { browseSessionId, walletGeneration, sessionEpoch: epoch, runGeneration } };
  }
  if (request.data.type === "browse.list") {
    const page = response.operationResult as StorageBrowsePage;
    return { sessionEpoch, ack, operationResult: { entries: page.entries.map(({ path, size, lastModified, revision, contentType }) => ({ path, size, lastModified, revision,
      ...(contentType === undefined ? {} : { contentType }) })), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) } };
  }
  const preview = response.operationResult as StorageBrowsePreview;
  const { path, format, totalSize, returnedSize, truncated, revision, lastModified, contentType, kvError } = preview;
  const payload = preview.kvPayload;
  return { sessionEpoch, ack, operationResult: { path, format, bytes: preview.bytes.slice(), totalSize, returnedSize, truncated, revision, lastModified,
    ...(contentType === undefined ? {} : { contentType }), ...(kvError === undefined ? {} : { kvError }),
    ...(payload === undefined ? {} : { kvPayload: { valueId: payload.valueId, partition: payload.partition, payloadFingerprint: payload.payloadFingerprint, json: payload.json,
      ...(payload.jsonText === undefined ? {} : { jsonText: payload.jsonText }) } }),
  } };
}

export const STORAGE_PRIVATE_BROWSE_CAPABILITY = defineCapability<StorageBrowsePrivateRequest, CoordinatorRpcResponse>({
  kind: "rpc", id: "storage.private.browse", version: "1",
  request: { parse: browseRequest },
  // WebLoom requires a parser. This is a header projection, not validation;
  // the producer projects the request-specific browse result exactly once.
  response: { parse(value: unknown) {
    const { sessionEpoch, ack, operationResult } = value as CoordinatorRpcResponse;
    return { sessionEpoch, ack, ...(operationResult === undefined ? {} : { operationResult }) };
  } },
});
