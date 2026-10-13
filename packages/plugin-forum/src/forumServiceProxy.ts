import { FORUM_WORKER_SERVICE_CAPABILITY, FORUM_WORKER_ATTACHMENT_CAPABILITY, FORUM_WORKER_METHODS, type ForumService, type ForumWorkerRequest } from "@keymaster/contracts";
import { collectForumAttachment } from "./attachmentStream.js";
import type { CapabilityClient } from "webloom-framework";

/** No repository, key, wallet or fallback implementation lives in this Window facade. */
export function createForumServiceProxy(client: CapabilityClient<typeof FORUM_WORKER_SERVICE_CAPABILITY>, attachments: CapabilityClient<typeof FORUM_WORKER_ATTACHMENT_CAPABILITY>): ForumService {
  const methods = Object.fromEntries(FORUM_WORKER_METHODS.map(method => [method, async (...input: unknown[]) => {
    let signal: AbortSignal | undefined;
    const args = input.map(arg => {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) return arg;
      const { signal: candidate, ...rest } = arg as Record<string, unknown>;
      if (candidate instanceof AbortSignal) signal = candidate;
      return rest;
    });
    const result = await client.call({ method, args } as ForumWorkerRequest, { ...(signal ? { signal } : {}), timeoutMs: 120_000 });
    if (!result.ok) { const error = new Error(result.message); Object.assign(error, { code: result.code }); throw error; }
    return result.value;
  }]));
  methods.readAttachmentContent = async (configId: unknown, seedHashHex: unknown, options: unknown) => {
    const chunks: import("@keymaster/contracts").ForumWorkerAttachmentChunk[] = [];
    let total = 0;
    const subscription = attachments.subscribe({ configId: configId as string, seedHashHex: seedHashHex as string }, {
      ...((options as { signal?: AbortSignal } | undefined)?.signal ? { signal: (options as { signal: AbortSignal }).signal } : {}),
      initialCredit: 2, initialByteCredit: 1024 * 1024,
      onNext(chunk) { total += chunk.data.byteLength; if (total > 32 * 1024 * 1024) throw new Error("Forum attachment exceeds limit"); chunks.push(chunk); },
    });
    await subscription.closed;
    return collectForumAttachment(chunks);
  };
  return Object.freeze(methods) as unknown as ForumService;
}
