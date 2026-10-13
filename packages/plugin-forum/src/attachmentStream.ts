import type { ForumAttachmentContent, ForumService, ForumWorkerAttachmentRequest, ForumWorkerAttachmentChunk } from "@keymaster/contracts";

/** One verified MSFile read, bounded transferable chunks; never expose a storage handle. */
export async function* streamForumAttachment(service: ForumService, request: ForumWorkerAttachmentRequest, signal: AbortSignal, assertActive: () => void): AsyncGenerator<ForumWorkerAttachmentChunk> {
  assertActive(); signal.throwIfAborted();
  const content = await service.readAttachmentContent(request.configId, request.seedHashHex, { signal });
  assertActive(); signal.throwIfAborted();
  if (!content) return;
  for (let offset = 0; offset < content.bytes.length || offset === 0; offset += 256 * 1024) {
    assertActive(); signal.throwIfAborted();
    const bytes = content.bytes.slice(offset, offset + 256 * 1024);
    yield { offset, data: bytes.buffer as ArrayBuffer, eof: offset + bytes.length >= content.bytes.length,
      seedHashHex: content.seedHashHex, byteLength: content.byteLength,
      ...(content.mediaType === undefined ? {} : { mediaType: content.mediaType }), ...(content.fileName === undefined ? {} : { fileName: content.fileName }),
    };
  }
}

export function collectForumAttachment(chunks: readonly ForumWorkerAttachmentChunk[]): ForumAttachmentContent | undefined {
  const first = chunks[0];
  if (!first) return undefined;
  const total = Number(first.byteLength);
  if (!Number.isSafeInteger(total) || total < 0 || total > 32 * 1024 * 1024) throw new Error("Invalid Forum attachment size");
  let offset = 0;
  const bytes = new Uint8Array(total);
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.offset !== offset || chunk.seedHashHex !== first.seedHashHex || chunk.byteLength !== first.byteLength || chunk.data.byteLength > total - offset
      || chunk.eof !== (index === chunks.length - 1)) throw new Error("Invalid Forum attachment stream");
    bytes.set(new Uint8Array(chunk.data), offset); offset += chunk.data.byteLength;
  }
  if (offset !== total) throw new Error("Incomplete Forum attachment stream");
  return { seedHashHex: first.seedHashHex, bytes, byteLength: first.byteLength,
    ...(first.mediaType === undefined ? {} : { mediaType: first.mediaType }), ...(first.fileName === undefined ? {} : { fileName: first.fileName }),
  };
}
