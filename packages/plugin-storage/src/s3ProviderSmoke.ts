import { describe, expect, it } from "vitest";
import type { NormalizedStorageProviderConfig } from "@keymaster/contracts";
import { STORAGE_PART_SIZE_BYTES } from "@keymaster/contracts";
import { createS3ObjectStore, type S3ObjectStore } from "./s3ObjectStore.js";
import { buildNamespaceRoot } from "./storageNamespace.js";
import { normalizeProviderPrefix } from "./storagePath.js";

interface SmokeFixture {
  label: string;
  config: NormalizedStorageProviderConfig;
}

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const basePrefix = normalizeProviderPrefix(process.env.KEYMASTER_STORAGE_SMOKE_BASE_PREFIX?.trim() ?? "");
const smokePrefix = `${basePrefix}keymaster-smoke/${runId}/`;
const smokeIdentity = {
  version: 1 as const,
  publisherPublicKeyHex: `02${"ab".repeat(32)}`,
  appId: "smoke-fixture",
  appName: "Keymaster Storage Smoke",
  identityDigestHex: "00".repeat(32)
};
const namespaceRoot = buildNamespaceRoot(smokePrefix, smokeIdentity);
const providerSelection = (process.env.KEYMASTER_STORAGE_SMOKE_PROVIDER ?? "all").trim().toLowerCase();
const fixtures = buildFixtures(providerSelection);

describe("Keymaster Storage real provider smoke", () => {
  for (const fixture of fixtures) {
    it(`${fixture.label}: probe, directory/list, conditional put, range, multipart and cancellation`, async () => {
      const store = createS3ObjectStore(fixture.config);
      const cleanupKeys = new Set<string>();
      const cleanupErrors: unknown[] = [];
      let completedUploadId: string | undefined;
      let abortedUploadId: string | undefined;
      let testError: unknown = null;
      try {
        await store.probe(smokePrefix);

        const directoryKey = `${namespaceRoot}directory/`;
        await store.put({ namespaceRoot, key: directoryKey, bytes: new Uint8Array(0), contentType: "application/x-directory", ifNoneMatch: "*" });
        cleanupKeys.add(directoryKey);

        const conditionalKey = `${namespaceRoot}conditional.txt`;
        const content = new TextEncoder().encode(`Keymaster storage smoke ${runId}`);
        await store.put({ namespaceRoot, key: conditionalKey, bytes: content, contentType: "text/plain", ifNoneMatch: "*" });
        cleanupKeys.add(conditionalKey);
        await expect(store.put({ namespaceRoot, key: conditionalKey, bytes: content, ifNoneMatch: "*" })).rejects.toBeTruthy();

        const listingKeys = new Set<string>();
        const listingPrefixes = new Set<string>();
        let continuationToken: string | undefined;
        do {
          const page = await store.list({ namespaceRoot, prefix: namespaceRoot, delimiter: "/", maxKeys: 1, continuationToken });
          for (const object of page.objects) listingKeys.add(object.key);
          for (const prefix of page.commonPrefixes) listingPrefixes.add(prefix);
          continuationToken = page.nextContinuationToken;
        } while (continuationToken);
        expect(listingKeys).toContain(conditionalKey);
        // S3-compatible providers normally expose delimiter directories via
        // CommonPrefixes rather than returning the zero-byte marker object.
        expect(listingPrefixes.has(directoryKey) || listingKeys.has(directoryKey)).toBe(true);

        const ranged = await store.get({ namespaceRoot, key: conditionalKey, range: "bytes=1-3" });
        expect(new TextDecoder().decode(ranged.bytes)).toBe(new TextDecoder().decode(content.slice(1, 4)));
        expect(ranged.totalSize).toBe(content.byteLength);

        const multipartKey = `${namespaceRoot}complete.bin`;
        completedUploadId = await store.createMultipart({ namespaceRoot, key: multipartKey, contentType: "application/octet-stream" });
        const firstPart = new Uint8Array(STORAGE_PART_SIZE_BYTES);
        firstPart.fill(1);
        const finalPart = new Uint8Array([2]);
        const firstEtag = await store.uploadPart({ namespaceRoot, key: multipartKey, uploadId: completedUploadId, partNumber: 1, bytes: firstPart });
        const finalEtag = await store.uploadPart({ namespaceRoot, key: multipartKey, uploadId: completedUploadId, partNumber: 2, bytes: finalPart });
        await store.completeMultipart({ namespaceRoot, key: multipartKey, uploadId: completedUploadId, parts: [{ partNumber: 1, etag: firstEtag }, { partNumber: 2, etag: finalEtag }] });
        cleanupKeys.add(multipartKey);
        completedUploadId = undefined;

        const abortKey = `${namespaceRoot}abort.bin`;
        abortedUploadId = await store.createMultipart({ namespaceRoot, key: abortKey, contentType: "application/octet-stream" });
        await store.abortMultipart({ namespaceRoot, key: abortKey, uploadId: abortedUploadId });
        abortedUploadId = undefined;

        const cancelled = new AbortController();
        cancelled.abort(new Error("smoke cancellation"));
        await expect(store.list({ namespaceRoot, prefix: namespaceRoot, maxKeys: 1, signal: cancelled.signal })).rejects.toBeTruthy();
      } catch (error) {
        testError = error;
      } finally {
        if (completedUploadId) await collectCleanupError(cleanupErrors, () => store.abortMultipart({ namespaceRoot, key: `${namespaceRoot}complete.bin`, uploadId: completedUploadId! }));
        if (abortedUploadId) await collectCleanupError(cleanupErrors, () => store.abortMultipart({ namespaceRoot, key: `${namespaceRoot}abort.bin`, uploadId: abortedUploadId! }));
        for (const key of cleanupKeys) await collectCleanupError(cleanupErrors, () => store.delete({ namespaceRoot, key }));
        store.dispose();
      }
      throwSmokeErrors(testError, cleanupErrors, `${fixture.label} cleanup failed`);
    }, 600_000);
  }
});

function buildFixtures(selection: string): SmokeFixture[] {
  if (!["all", "aws", "r2", "compatible"].includes(selection)) {
    throw new Error("KEYMASTER_STORAGE_SMOKE_PROVIDER must be all, aws, r2 or compatible");
  }
  const fixtures: SmokeFixture[] = [];
  if (selection === "all" || selection === "aws") {
    fixtures.push({
      label: "AWS S3",
      config: {
        version: 1,
        providerId: "aws-s3",
        connection: { region: required("KEYMASTER_STORAGE_SMOKE_AWS_REGION"), bucket: required("KEYMASTER_STORAGE_SMOKE_AWS_BUCKET"), prefix: smokePrefix },
        credentials: { kind: "access-key", accessKeyId: required("KEYMASTER_STORAGE_SMOKE_AWS_ACCESS_KEY_ID"), secretAccessKey: required("KEYMASTER_STORAGE_SMOKE_AWS_SECRET_ACCESS_KEY") }
      }
    });
  }
  if (selection === "all" || selection === "r2") {
    fixtures.push({
      label: "Cloudflare R2",
      config: {
        version: 1,
        providerId: "cloudflare-r2",
        connection: { accountId: required("KEYMASTER_STORAGE_SMOKE_R2_ACCOUNT_ID"), endpointVariant: optional("KEYMASTER_STORAGE_SMOKE_R2_ENDPOINT_VARIANT", "default") as "default" | "eu" | "fedramp", bucket: required("KEYMASTER_STORAGE_SMOKE_R2_BUCKET"), prefix: smokePrefix },
        credentials: { kind: "access-key", accessKeyId: required("KEYMASTER_STORAGE_SMOKE_R2_ACCESS_KEY_ID"), secretAccessKey: required("KEYMASTER_STORAGE_SMOKE_R2_SECRET_ACCESS_KEY") }
      }
    });
  }
  if (selection === "all" || selection === "compatible") {
    fixtures.push({
      label: "S3-compatible",
      config: {
        version: 1,
        providerId: "s3-compatible",
        connection: { endpoint: required("KEYMASTER_STORAGE_SMOKE_COMPAT_ENDPOINT"), region: required("KEYMASTER_STORAGE_SMOKE_COMPAT_REGION"), bucket: required("KEYMASTER_STORAGE_SMOKE_COMPAT_BUCKET"), prefix: smokePrefix, forcePathStyle: optional("KEYMASTER_STORAGE_SMOKE_COMPAT_FORCE_PATH_STYLE", "false") === "true" },
        credentials: { kind: "access-key", accessKeyId: required("KEYMASTER_STORAGE_SMOKE_COMPAT_ACCESS_KEY_ID"), secretAccessKey: required("KEYMASTER_STORAGE_SMOKE_COMPAT_SECRET_ACCESS_KEY") }
      }
    });
  }
  return fixtures;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required smoke-test environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

async function collectCleanupError(errors: unknown[], cleanup: () => Promise<void>): Promise<void> {
  try { await cleanup(); } catch (error) { errors.push(error); }
}

function throwSmokeErrors(testError: unknown, cleanupErrors: unknown[], message: string): void {
  if (testError && cleanupErrors.length) throw new AggregateError([testError, ...cleanupErrors], message);
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, message);
  if (testError) throw testError;
}
