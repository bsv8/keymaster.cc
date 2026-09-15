import { describe, expect, it } from "vitest";
import type { StorageBucketProvider } from "@keymaster/contracts";
import { createHmacRemoteRootAuthenticator, discoverRemoteStorageRoot, encodeRemoteRootManifest, sealRemoteRootManifest, verifyRemoteRootManifest } from "./remoteRootProtocol.js";

function provider(initial?: Uint8Array): StorageBucketProvider & { writes: string[] } {
  const objects = new Map<string, Uint8Array>();
  if (initial) objects.set(".keymaster/root/v1", initial);
  const writes: string[] = [];
  return {
    provider: "s3",
    bucketId: "remote-test",
    writes,
    async probe() { return { ok: true, conditionalWrites: "native", latencyMs: 0 }; },
    async get(path) {
      const bytes = objects.get(path);
      return bytes ? { path, bytes: bytes.slice(), size: bytes.byteLength, etag: `etag-${path}` } : undefined;
    },
    async list() { return { objects: [] }; },
    async put(path, bytes) { writes.push(path); objects.set(path, bytes.slice()); return { etag: `etag-${path}` }; },
    async delete(path) { writes.push(`delete:${path}`); objects.delete(path); },
    dispose() {},
  };
}

const input = {
  remoteStorageId: "remote-root-1",
  namespaceVersion: 1 as const,
  createdAt: 1,
  keyDerivation: { algorithm: "pbkdf2-hmac-sha-256" as const, passwordEncoding: "utf-8" as const, iterations: 100_000, outputLengthBits: 256 as const, saltB64Url: "0123456789ab" },
  rootHead: { path: ".keymaster/hold/v1", revision: 1 },
  system: { schemaPath: ".keymaster/schema", holdHeadPath: ".keymaster/hold/v1" },
  initializationTransactionId: "operation-1",
};

describe("remote root protocol", () => {
  it("authenticates a canonical manifest independent of JSON field order", async () => {
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(7));
    const manifest = await sealRemoteRootManifest(input, authenticator);
    const reordered = JSON.parse(JSON.stringify({
      integrity: manifest.integrity,
      system: manifest.system,
      rootHead: manifest.rootHead,
      keyDerivation: manifest.keyDerivation,
      initializationTransactionId: manifest.initializationTransactionId,
      createdAt: manifest.createdAt,
      namespaceVersion: manifest.namespaceVersion,
      remoteStorageId: manifest.remoteStorageId,
      version: manifest.version,
      format: manifest.format,
    })) as unknown;
    await expect(verifyRemoteRootManifest(reordered, authenticator)).resolves.toMatchObject({ remoteStorageId: "remote-root-1" });
    authenticator.dispose?.();
  });

  it("discovers only the authenticated fixed root and ignores candidate objects", async () => {
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(8));
    const empty = provider();
    expect(await discoverRemoteStorageRoot(empty, { authenticator })).toEqual({ status: "absent" });
    const manifest = await sealRemoteRootManifest(input, authenticator);
    const present = provider(encodeRemoteRootManifest(manifest));
    await expect(discoverRemoteStorageRoot(present, { authenticator, expectedRemoteStorageId: "remote-root-1" })).resolves.toMatchObject({ status: "present", object: { manifest: { remoteStorageId: "remote-root-1" } } });
    expect(present.writes).toEqual([]);
    authenticator.dispose?.();
  });

  it("reports malformed root data as corrupt, not absent", async () => {
    const authenticator = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(9));
    const malformed = provider(new TextEncoder().encode("{}"));
    await expect(discoverRemoteStorageRoot(malformed, { authenticator })).resolves.toMatchObject({ status: "corrupt" });
    authenticator.dispose?.();
  });

  it("distinguishes an authentication failure from a corrupt manifest", async () => {
    const writer = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(10));
    const wrongKey = createHmacRemoteRootAuthenticator(new Uint8Array(32).fill(11));
    const remote = provider(encodeRemoteRootManifest(await sealRemoteRootManifest(input, writer)));
    await expect(discoverRemoteStorageRoot(remote, { authenticator: wrongKey })).resolves.toEqual({ status: "forbidden", diagnostic: "authentication" });
    writer.dispose?.();
    wrongKey.dispose?.();
  });
});
