import type { ForumService, ForumWorkerRequest, ForumWorkerResponse } from "@keymaster/contracts";

const optionsIndex: Partial<Record<keyof ForumService, number>> = {
  verifyRoot: 1, getNode: 2, ensureContent: 2, readContent: 2, openAndFetch: 2,
  readAttachment: 2, readAttachmentContent: 2, publicationReachability: 2,
  freezeContent: 2, preparePublishContent: 2, quotePublish: 1, confirmBudget: 1, buildAndSubmit: 1, reconcile: 1,
};
const objectSignalMethods = new Set(["listBoards", "listPosts", "listReplies", "preparePublish", "listSelfOutputs", "sweepSelfOutputs"]);

/** Framework call cancellation stays out of structured-clone DTOs. */
export async function executeForumWorkerRequest(service: ForumService, request: ForumWorkerRequest, signal: AbortSignal, assertActive: () => void): Promise<ForumWorkerResponse> {
  try {
    assertActive(); signal.throwIfAborted();
    const args = [...request.args];
    const index = optionsIndex[request.method];
    if (index !== undefined) args[index] = { ...(args[index] as object | undefined), signal };
    if (objectSignalMethods.has(request.method)) args[0] = { ...(args[0] as object | undefined), signal };
    const method = service[request.method] as (...args: unknown[]) => unknown;
    const value = await method.apply(service, args);
    assertActive(); signal.throwIfAborted();
    return { ok: true, value };
  } catch (error) {
    return { ok: false, code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "forum-worker-unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}
