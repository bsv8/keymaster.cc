// 一次性退役清理：彻底硬删旧论坛资金与协议责任（决定 B）。
//
// 只删除可明确归属旧论坛的记录，不触碰 BitFS、普通转账与公共协议账本。
// 幂等：缺失视为已清理，不计入删除；读取失败、删除失败明确抛错，不计成功。
// 顺序：收集完整关联 → manager 硬删除 → 硬删对应内存 → 删协议文件 → 删 funding 文件。
// manager 清理成功前保留全部关联证据；失败抛错，不静默。

import type { BorrowedModuleFileStore } from "@keymaster/contracts";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { openP2pkhStateRepository, createP2pkhStateRepository } from "./storage/p2pkhStateRepository.js";

export interface RetiredForumPurgeResult {
  deletedFundingFiles: string[];
  deletedProtocolFiles: string[];
  deletedSubmissionIds: string[];
  deletedClaimIds: string[];
  cancelledManagerSubmissionIds: string[];
  keptProtocolFiles: number;
  /** 成功时恒为空；无法确定关联的损坏文件会在删除前抛错。 */
  unreadableProtocolFiles: string[];
}

export interface RetiredForumManagerPort {
  retireForumProtocolSubmission(input: { ownerPublicKeyHex: string; network: "main" | "test"; submissionId: string }): Promise<{ deleted: boolean; allocationId?: string }>;
}

function isForumFundingId(fundingId: string): boolean {
  return fundingId.startsWith("forum:");
}

function tryParseJson(bytes: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function outpointKey(txid: string, vout: number): string {
  return `${txid.toLowerCase()}:${vout}`;
}

async function fileExists(files: BorrowedModuleFileStore, path: string): Promise<boolean> {
  const object = await files.get(path);
  return object !== undefined;
}

export async function purgeRetiredForumProtocolData(
  files: BorrowedModuleFileStore,
  manager?: RetiredForumManagerPort,
): Promise<RetiredForumPurgeResult> {
  const deletedFundingFiles: string[] = [];
  const deletedProtocolFiles: string[] = [];
  const deletedSubmissionIds: string[] = [];
  const deletedClaimIds: string[] = [];
  const cancelledManagerSubmissionIds: string[] = [];
  const unreadableProtocolFiles: string[] = [];

  // ---- 阶段 1：收集论坛专款归属（不删除，先确定完整关联集合）。 ----
  // 缺失（get 返回 undefined）视为已清理；读取抛错则直接失败，不当作缺失。
  const forumFundingOutpoints = new Set<string>();
  const forumFundingSubmissionIds = new Set<string>();
  const forumFundingPaths: string[] = [];
  type Scope = { submissionId: string; ownerPublicKeyHex: string; network: "main" | "test" };
  const fundingScopes = new Map<string, Scope>();
  const journalPath = (id: string) => `protocol/${bytesToHex(sha256(new TextEncoder().encode(id)))}.json`;
  function invalid(path: string): never { throw new Error(`Forum retirement cannot determine complete association: ${path}`); }
  {
    let cursor: string | undefined;
    do {
      const page = await files.list({ prefix: "funding/", ...(cursor ? { cursor } : {}) });
      for (const file of page.files) {
        const match = /^funding\/(.+)\.json$/u.exec(file.path);
        const fundingIdFromName = match?.[1];
        const object = await files.get(file.path);
        if (!object) continue;
        const parsed = tryParseJson(object.bytes) as { record?: { fundingId?: unknown; txid?: unknown; vout?: unknown; ownerPluginId?: unknown; submissionId?: unknown; ownerPublicKeyHex?: unknown; network?: unknown } } | undefined;
        const record = parsed?.record;
        if (!record || typeof record !== "object" || Array.isArray(record)) invalid(file.path);
        const fundingId = typeof record.fundingId === "string" ? record.fundingId : fundingIdFromName;
        if (!fundingId && typeof record.ownerPluginId !== "string") invalid(file.path);
        const isForum = (typeof fundingIdFromName === "string" && isForumFundingId(fundingIdFromName)) || (typeof fundingId === "string" && isForumFundingId(fundingId)) || record.ownerPluginId === "forum";
        if (!isForum) continue;
        if (typeof record.txid !== "string" || !/^[a-fA-F0-9]{64}$/u.test(record.txid)
          || !Number.isSafeInteger(record.vout) || (record.vout as number) < 0
          || typeof record.submissionId !== "string" || !record.submissionId
          || typeof record.ownerPublicKeyHex !== "string" || !/^(02|03)[a-fA-F0-9]{64}$/u.test(record.ownerPublicKeyHex)
          || (record.network !== "main" && record.network !== "test")) invalid(file.path);
        const scope: Scope = { submissionId: record.submissionId as string, ownerPublicKeyHex: (record.ownerPublicKeyHex as string).toLowerCase(), network: record.network as "main" | "test" };
        const key = journalPath(scope.submissionId);
        const prior = fundingScopes.get(key);
        if (prior && (prior.ownerPublicKeyHex !== scope.ownerPublicKeyHex || prior.network !== scope.network)) invalid(file.path);
        fundingScopes.set(key, scope);
        forumFundingPaths.push(file.path);
        if (typeof record.txid === "string" && typeof record.vout === "number") {
          forumFundingOutpoints.add(outpointKey(record.txid, record.vout));
        }
        if (typeof record.submissionId === "string" && record.submissionId.length > 0) {
          forumFundingSubmissionIds.add(record.submissionId);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  // ---- 阶段 2：收集论坛协议提交（拆款 + 消费专款），同样先不删除。 ----
  interface ForumSubmissionHit { path: string; submissionId: string; ownerPublicKeyHex: string; network: "main" | "test"; }
  const forumHits: ForumSubmissionHit[] = [];
  const protocolPaths: string[] = [];
  {
    let cursor: string | undefined;
    do {
      const page = await files.list({ prefix: "protocol/", ...(cursor ? { cursor } : {}) });
      for (const file of page.files) protocolPaths.push(file.path);
      cursor = page.nextCursor;
    } while (cursor);
  }
  for (const path of protocolPaths) {
    const object = await files.get(path);
    if (!object) continue;
    const parsed = tryParseJson(object.bytes) as
      | { submission?: { id?: unknown; submissionId?: unknown; publicKeyHex?: unknown; network?: unknown; inputs?: unknown; protectedClaimIds?: unknown } }
      | undefined;
    const fallback = fundingScopes.get(path);
    const submission = parsed?.submission;
    if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
      if (fallback) { forumHits.push({ path, ...fallback }); continue; }
      invalid(path);
    }
    if (fallback && ((submission.publicKeyHex !== undefined && submission.publicKeyHex !== fallback.ownerPublicKeyHex)
      || (submission.network !== undefined && submission.network !== fallback.network))) invalid(path);
    const submissionId = typeof submission.submissionId === "string" && submission.submissionId.length > 0
      ? submission.submissionId
      : typeof (submission as { id?: unknown }).id === "string" ? (submission as { id: string }).id : undefined;
    if (!submissionId) {
      if (fallback) { forumHits.push({ path, ...fallback }); continue; }
      invalid(path);
    }
    if (journalPath(submissionId) !== path) invalid(path);
    if (!Array.isArray(submission.inputs) || !Array.isArray(submission.protectedClaimIds)) {
      if (fallback) { forumHits.push({ path, ...fallback }); continue; }
      invalid(path);
    }
    if (!submission.protectedClaimIds.every(id => typeof id === "string")
      || !submission.inputs.every((row: unknown) => {
        const input = row as { txid?: unknown; vout?: unknown } | null;
        return input && typeof input.txid === "string" && /^[a-fA-F0-9]{64}$/u.test(input.txid)
          && Number.isSafeInteger(input.vout) && (input.vout as number) >= 0;
      })) invalid(path);
    const protectedClaimIds = submission.protectedClaimIds;
    const hasForumClaim = protectedClaimIds.some((id) => typeof id === "string" && id.endsWith(":forum"));
    const isFundingSplit = forumFundingSubmissionIds.has(submissionId);
    let hasForumInput = false;
    if (Array.isArray(submission.inputs)) {
      for (const input of submission.inputs as Array<{ txid?: unknown; vout?: unknown }>) {
        if (typeof input?.txid === "string" && typeof input?.vout === "number" && forumFundingOutpoints.has(outpointKey(input.txid, input.vout))) {
          hasForumInput = true;
          break;
        }
      }
    }
    if (!(hasForumClaim || isFundingSplit || hasForumInput)) continue;
    const ownerPublicKeyHex = typeof submission.publicKeyHex === "string" ? submission.publicKeyHex.toLowerCase() : fallback?.ownerPublicKeyHex;
    const network = submission.network === undefined ? fallback?.network : submission.network === "main" || submission.network === "test" ? submission.network : undefined;
    if (!ownerPublicKeyHex || !/^(02|03)[a-f0-9]{64}$/u.test(ownerPublicKeyHex) || !network) invalid(path);
    if (fallback && (fallback.submissionId !== submissionId || fallback.ownerPublicKeyHex !== ownerPublicKeyHex || fallback.network !== network)) invalid(path);
    forumHits.push({ path, submissionId, ownerPublicKeyHex, network });
  }
  // Funding may survive a prior journal deletion failure/restart. Its original
  // scope is sufficient to retry manager retirement even without the journal.
  const managerHits = new Map<string, Scope>([...fundingScopes.values(), ...forumHits].map(hit => [hit.submissionId, hit]));
  const forumSubmissionIds = new Set(managerHits.keys());

  // ---- 阶段 3：manager 退役硬删除（经一致性边界，普通取消不动）。 ----
  // 先于文件删除执行：关联证据仍完整；失败抛错，文件保留可重试。
  // 缺失（无责任）视为已清理，不计入；歧义抛错，不是清理成功。
  if (manager) {
    for (const hit of managerHits.values()) {
      const outcome = await manager.retireForumProtocolSubmission({ ownerPublicKeyHex: hit.ownerPublicKeyHex, network: hit.network, submissionId: hit.submissionId });
      if (outcome.deleted) cancelledManagerSubmissionIds.push(hit.submissionId);
    }
  }

  // ---- 阶段 4：在最后一份 journal 归属证据消失前硬删对应内存责任。 ----
  // 文件删除部分成功后，重试未必能重新发现发布 submission，不能把内存清理
  // 留到 funding 删除后。这里只删已确认集合，不调用普通释放或清空公共仓储。
  if (forumSubmissionIds.size > 0) {
    const bundle = await openP2pkhStateRepository(files);
    const repository = createP2pkhStateRepository(bundle);
    for (const submissionId of forumSubmissionIds) {
      await repository.removeProtocolSubmission(submissionId);
      for (const claim of bundle.memory.localClaims.values()) {
        if (claim.submissionId === submissionId) {
          bundle.memory.localClaims.delete(claim.id);
          deletedClaimIds.push(claim.id);
        }
      }
    }
  }

  // ---- 阶段 5：删协议后删资金；失败仍抛错，残留文件可幂等重试。 ----
  for (const hit of forumHits) {
    await files.delete(hit.path);
    if (await fileExists(files, hit.path)) throw new Error(`Forum protocol file was not deleted: ${hit.path}`);
    deletedProtocolFiles.push(hit.path);
    deletedSubmissionIds.push(hit.submissionId);
  }
  for (const path of forumFundingPaths) {
    await files.delete(path);
    if (await fileExists(files, path)) throw new Error(`Forum funding file was not deleted: ${path}`);
    deletedFundingFiles.push(path);
  }

  let keptProtocolFiles = 0;
  {
    let cursor: string | undefined;
    do {
      const page = await files.list({ prefix: "protocol/", ...(cursor ? { cursor } : {}) });
      keptProtocolFiles += page.files.length;
      cursor = page.nextCursor;
    } while (cursor);
  }

  return { deletedFundingFiles, deletedProtocolFiles, deletedSubmissionIds, deletedClaimIds, cancelledManagerSubmissionIds, keptProtocolFiles, unreadableProtocolFiles };
}
