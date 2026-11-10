import { sha256 } from "@noble/hashes/sha2.js";
import { normalizeRelativeStoragePath, type OwnerAppStorageGrant, type VaultSealedSecret } from "@keymaster/contracts";
import { STORAGE_MAX_PAYLOAD_BYTES } from "@keymaster/contracts/connect-public";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { connectS3Root, type ConnectFileStore } from "./fileStore.js";
import type { ConnectS3Secrets } from "./runtime.js";

const FORMAT = "keymaster.storage.encrypted-file";
const MAX_METADATA_BYTES = 4096;
const MAX_PACKED_BYTES = STORAGE_MAX_PAYLOAD_BYTES + MAX_METADATA_BYTES + 4;
const MAX_ENVELOPE_BYTES = (MAX_PACKED_BYTES + 16) * 2 + 1024;
const ENCRYPTED_MIME = "application/vnd.keymaster.encrypted-file+json";
const encode = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });
function failure(): StorageRuntimeError { return new StorageRuntimeError("storage_provider_error", "Encrypted storage object could not be opened"); }

/** 钱包私钥由 Vault 使用；scope 绑定网络、钱包、App 公钥和完整对象键，不绑定 origin/显示名称。 */
function secretScope(ctx: OwnerAppStorageGrant, path: string): string {
  if (normalizeRelativeStoragePath(path) !== path) throw new StorageRuntimeError("storage_invalid_path", "Invalid encrypted object path");
  const digest = sha256(encode.encode(connectS3Root(ctx) + path));
  return `storage.encrypted-file.v1|${Array.from(digest, value => value.toString(16).padStart(2, "0")).join("")}`;
}

/** 不向 App 发布密码学句柄；该包装只在 Storage Worker 的真实授权句柄内使用。 */
export function createEncryptedFileStore(base: ConnectFileStore, ctx: OwnerAppStorageGrant, secrets: ConnectS3Secrets,
  assertLive: () => void, lifetime: AbortSignal): ConnectFileStore {
  let closed = false;
  const assert = (signal?: AbortSignal) => { if (closed) throw new StorageRuntimeError("storage_unavailable", "Encrypted storage handle is closed"); assertLive(); lifetime.throwIfAborted(); signal?.throwIfAborted(); };
  return {
    ...base,
    close() { closed = true; base.close(); },
    async put(path, bytes, options) {
      assert(options?.signal);
      if (bytes.byteLength > STORAGE_MAX_PAYLOAD_BYTES) throw new StorageRuntimeError("storage_limit_exceeded", "Encrypted object exceeds the payload limit");
      const metadata = encode.encode(JSON.stringify({ contentType: options?.contentType ?? "application/octet-stream" }));
      if (metadata.length > MAX_METADATA_BYTES) throw new StorageRuntimeError("storage_limit_exceeded", "Encrypted object metadata is too large");
      const packed = new Uint8Array(4 + metadata.length + bytes.length);
      new DataView(packed.buffer).setUint32(0, metadata.length);
      packed.set(metadata, 4); packed.set(bytes, 4 + metadata.length);
      try {
        const sealed = await secrets.seal(secretScope(ctx, path), packed);
        assert(options?.signal);
        const envelope = encode.encode(JSON.stringify({ format: FORMAT, version: 1, sealed }));
        const result = await base.put(path, envelope, { ...options, contentType: ENCRYPTED_MIME });
        assert(options?.signal); return result;
      } finally { packed.fill(0); }
    },
    async get(path, options) {
      assert(options?.signal);
      const object = await base.get(path, options);
      assert(options?.signal);
      if (!object) return undefined;
      let packed: Uint8Array | undefined;
      try {
        if (object.bytes.length > MAX_ENVELOPE_BYTES) throw failure();
        const envelope = JSON.parse(decode.decode(object.bytes)) as { format: string; version: number; sealed: VaultSealedSecret };
        const sealed = envelope.sealed;
        if (envelope.format !== FORMAT || envelope.version !== 1 || !sealed || sealed.version !== 3 || sealed.keySource !== "active-key-hkdf-v1"
          || !/^[0-9a-f]{32}$/iu.test(sealed.saltHex) || !/^[0-9a-f]{24}$/iu.test(sealed.nonceHex)
          || typeof sealed.ciphertextHex !== "string" || sealed.ciphertextHex.length < 32 || sealed.ciphertextHex.length > (MAX_PACKED_BYTES + 16) * 2
          || sealed.ciphertextHex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(sealed.ciphertextHex)) throw failure();
        packed = await secrets.open(secretScope(ctx, path), sealed);
        assert(options?.signal);
        if (packed.length < 4 || packed.length > MAX_PACKED_BYTES) throw failure();
        const metadataSize = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getUint32(0);
        if (metadataSize > MAX_METADATA_BYTES || 4 + metadataSize > packed.length) throw failure();
        const metadata = JSON.parse(decode.decode(packed.subarray(4, 4 + metadataSize))) as { contentType: string };
        if (typeof metadata.contentType !== "string" || packed.length - 4 - metadataSize > STORAGE_MAX_PAYLOAD_BYTES) throw failure();
        return { ...object, bytes: packed.slice(4 + metadataSize), contentType: metadata.contentType };
      } catch {
        assert(options?.signal);
        throw failure();
      } finally { packed?.fill(0); }
    },
  };
}
