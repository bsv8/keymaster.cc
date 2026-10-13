// Forum owner-session Worker 的受限网络能力。
//
// Forum 的唯一对外网络动作只有一个：按已验证的论坛服务身份做 `forum.roundtrip`。
// 这个能力把**那一个动作**暴露给 Forum 的 Worker 运行单元，而不暴露通用 lane、
// 通用帧或通用 Host：
//
//   - 通用 lane 注册只存在于 Window（`WINDOW_P2P_EXECUTOR_CAPABILITY`），Worker 侧
//     没有也不应该有第二个 Host；这里复用现有 Worker→Window executor bridge，
//     因此唯一 Host 与现有租约机制保持不变。
//   - 帧内容由调用方的业务层校验，Worker 侧只做**形状**校验（kind、公钥、hex、
//     超时上限），不解释业务语义，也不放宽 Window 侧 lane 的判定。
//
// Worker 不可用时调用方必须明确失败：静默退回 Window 本地权威会重新制造两套
// 发布仲裁，与施工单要求的单一 owner-session 权威冲突。

import { defineCapability } from "webloom-framework";

/** 与 Window 侧 lane id 保持一致；不一致会被 lane 直接拒绝。 */
export const FORUM_WORKER_LANE_ID = "forum";

/** 唯一允许的操作 kind。其它 kind 一律拒绝，避免 Worker 变成通用帧通道。 */
export const FORUM_WORKER_ROUNDTRIP_KIND = "forum.roundtrip";

/** 单次 roundtrip 的帧上限，与 Window lane 的 1 MiB + 帧头一致。 */
export const FORUM_WORKER_MAX_FRAME_BYTES = 1024 * 1024 + 16;

/** 单次调用默认超时；Worker 侧不允许超过这个上界。 */
export const FORUM_WORKER_DEFAULT_TIMEOUT_MS = 15_000;

export interface ForumWorkerRoundtripRequest {
  readonly kind: typeof FORUM_WORKER_ROUNDTRIP_KIND;
  /** 完整 multiaddr；Direct 部署给出含 PeerId 与 certhash 的实际地址。 */
  readonly address: string;
  /** 已由业务层验证的论坛服务公钥；拨号后必须与远端身份一致。 */
  readonly forumPublicKeyHex: string;
  readonly requestBytesHex: string;
  readonly timeoutMs?: number;
}

export type ForumWorkerRoundtripOutcome =
  | { readonly ok: true; readonly responseBytesHex: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Worker 侧的受限网络入口。
 *
 * 只有一个方法：把一次已验证的 roundtrip 交给现有的 Window executor bridge 执行。
 * 没有「注册 lane」「取 Host」「发任意帧」这类入口，因此 Worker 拿到它也无法绕过
 * 唯一 Host 与租约机制。
 */
export interface ForumWorkerNetwork {
  /** Host/租约不可用时以 `ok: false` 返回，绝不静默改走别的路径。 */
  roundtrip(request: ForumWorkerRoundtripRequest, signal?: AbortSignal): Promise<ForumWorkerRoundtripOutcome>;
}

export const FORUM_WORKER_NETWORK_CAPABILITY = defineCapability<ForumWorkerNetwork>({
  kind: "local",
  id: "forum.worker-network",
  version: "1",
});

/**
 * Worker 侧的形状校验。
 *
 * 只回答「这是不是一个允许发出去的 roundtrip 帧」，不回答业务上是否该发：
 * 论坛公钥与请求体的业务校验由 Forum 领域层负责，这里保证不会把畸形或超限的
 * 帧推给 Host。
 */
export function isForumWorkerRoundtripRequest(value: unknown): value is ForumWorkerRoundtripRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind !== FORUM_WORKER_ROUNDTRIP_KIND) return false;
  if (typeof record.address !== "string" || record.address.length === 0) return false;
  if (typeof record.forumPublicKeyHex !== "string" || !/^(02|03)[0-9a-f]{64}$/u.test(record.forumPublicKeyHex)) return false;
  if (typeof record.requestBytesHex !== "string") return false;
  if (!/^([0-9a-fA-F]{2})+$/u.test(record.requestBytesHex)) return false;
  if (record.requestBytesHex.length / 2 > FORUM_WORKER_MAX_FRAME_BYTES) return false;
  if (record.timeoutMs !== undefined) {
    if (typeof record.timeoutMs !== "number" || !Number.isInteger(record.timeoutMs)) return false;
    // 上界与 Window lane 一致：Worker 侧不能借超时把 Host 占住更久。
    if (record.timeoutMs <= 0 || record.timeoutMs > FORUM_WORKER_DEFAULT_TIMEOUT_MS) return false;
  }
  return true;
}

/** Structured domain methods only: no arbitrary digest, raw broadcast or file access. */
export const FORUM_WORKER_METHODS = [
  "listConfigs", "getConfig", "saveConfig", "removeConfig", "verifyRoot", "getRootVerification",
  "listBoards", "listPosts", "listReplies", "getNode", "ensureContent", "readContent", "openAndFetch", "readAttachment", "readAttachmentContent", "publicationReachability",
  "freezeContent", "preparePublishContent", "preparePublish", "quotePublish", "confirmBudget", "buildAndSubmit", "reconcile",
  "listSelfOutputs", "protectSelfOutputs", "unprotectSelfOutputs", "sweepSelfOutputs", "recoverFunding", "cancelUndispatched", "listPublishTasks", "getPublishTask",
] as const satisfies readonly (keyof import("./forum.js").ForumService)[];
const FORUM_WORKER_ARGUMENTS: Readonly<Record<typeof FORUM_WORKER_METHODS[number], readonly [number, number]>> = {
  listConfigs: [0, 0], getConfig: [1, 1], saveConfig: [1, 1], removeConfig: [1, 1], verifyRoot: [1, 2], getRootVerification: [1, 1],
  listBoards: [1, 1], listPosts: [1, 1], listReplies: [1, 1], getNode: [2, 3], ensureContent: [2, 3], readContent: [2, 3], openAndFetch: [2, 3], readAttachment: [2, 3], readAttachmentContent: [2, 3], publicationReachability: [2, 3],
  freezeContent: [2, 3], preparePublishContent: [2, 3], preparePublish: [1, 1], quotePublish: [1, 2], confirmBudget: [1, 2], buildAndSubmit: [1, 2], reconcile: [1, 2],
  listSelfOutputs: [1, 1], protectSelfOutputs: [2, 2], unprotectSelfOutputs: [1, 1], sweepSelfOutputs: [1, 1], recoverFunding: [1, 1], cancelUndispatched: [1, 1], listPublishTasks: [0, 1], getPublishTask: [1, 1],
};
export type ForumWorkerRequest = { readonly method: typeof FORUM_WORKER_METHODS[number]; readonly args: readonly unknown[] };
export type ForumWorkerResponse = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string; readonly message: string };
export const FORUM_WORKER_SERVICE_CAPABILITY = defineCapability<ForumWorkerRequest, ForumWorkerResponse>({
  kind: "rpc", id: "forum.worker-service", version: "1",
  request: { parse(value) {
    if (!value || typeof value !== "object") throw new TypeError("Invalid Forum request");
    const row = value as Record<string, unknown>;
    if (!(FORUM_WORKER_METHODS as readonly unknown[]).includes(row.method) || !Array.isArray(row.args) || row.args.length > 3) throw new TypeError("Invalid Forum domain method or arguments");
    const [min, max] = FORUM_WORKER_ARGUMENTS[row.method as typeof FORUM_WORKER_METHODS[number]];
    if (row.args.length < min || row.args.length > max) throw new TypeError("Invalid Forum argument count");
    return { method: row.method, args: row.args } as ForumWorkerRequest;
  } },
  response: { parse(value) {
    if (!value || typeof value !== "object") throw new TypeError("Invalid Forum response");
    const row = value as Record<string, unknown>;
    if (row.ok === true) return { ok: true, value: row.value };
    if (row.ok === false && typeof row.code === "string" && typeof row.message === "string") return { ok: false, code: row.code, message: row.message };
    throw new TypeError("Invalid Forum response");
  } },
});


export interface ForumWorkerAttachmentRequest { readonly configId: string; readonly seedHashHex: string; }
export interface ForumWorkerAttachmentChunk { readonly offset: number; readonly data: ArrayBuffer; readonly eof: boolean; readonly seedHashHex: string; readonly byteLength: string; readonly mediaType?: string; readonly fileName?: string; }
export const FORUM_WORKER_ATTACHMENT_CAPABILITY = defineCapability<ForumWorkerAttachmentRequest, ForumWorkerAttachmentChunk>({
  kind: "stream", id: "forum.worker-attachment", version: "1",
  request: { parse(value) { const row = value as ForumWorkerAttachmentRequest; if (!row || typeof row.configId !== "string" || !/^[a-f0-9]{64}$/u.test(row.seedHashHex)) throw new TypeError("Invalid attachment request"); return { configId: row.configId, seedHashHex: row.seedHashHex }; } },
  item: { parse(value) { const row = value as ForumWorkerAttachmentChunk; if (!row || !Number.isSafeInteger(row.offset) || row.offset < 0 || !(row.data instanceof ArrayBuffer) || row.data.byteLength > 256 * 1024 || typeof row.eof !== "boolean" || !/^[a-f0-9]{64}$/u.test(row.seedHashHex) || typeof row.byteLength !== "string") throw new TypeError("Invalid attachment chunk"); return row; } },
  transfer: { item: value => [value.data] },
});
