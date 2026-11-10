import { traceDev, type ModuleFileStore, type NetworkIdentity, type OwnerAppStorageGrant, type VaultSealedSecret } from "@keymaster/contracts";
import { StorageRuntimeError } from "../runtime/storageError.js";
import { createConnectS3FileStore, probeConnectS3, ConnectS3ProbeError, type ConnectFileStore } from "./fileStore.js";
import { createEncryptedFileStore } from "./encryptedFiles.js";
import { connectS3Summary, normalizeConnectS3Config } from "./config.js";
import type { ConnectS3Config, ConnectS3Request, ConnectS3Response } from "./protocol.js";

export const CONNECT_S3_SECRET_SCOPE = "storage.connect-s3.v1";
export interface ConnectS3Secrets {
  seal(scope: string, bytes: Uint8Array): Promise<VaultSealedSecret>;
  open(scope: string, sealed: VaultSealedSecret): Promise<Uint8Array>;
}
export function createConnectS3Runtime(deps: {
  identity: NetworkIdentity;
  settings(): Promise<ModuleFileStore>;
  secrets: ConnectS3Secrets;
  assertLive(): void;
}) {
  let lifetime = new AbortController();
  let tail = Promise.resolve();
  const configPath = "connection.json";
  function invalidate() { lifetime.abort(); lifetime = new AbortController(); }
  async function read(): Promise<ConnectS3Config | undefined> {
    deps.assertLive();
    const store = await deps.settings();
    let plaintext: Uint8Array | undefined;
    try {
      const file = await store.get(configPath);
      if (!file) return undefined;
      const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) as { version: number; sealed: VaultSealedSecret };
      if (doc.version !== 1 || !doc.sealed) throw Error("Unsupported S3 configuration");
      plaintext = await deps.secrets.open(CONNECT_S3_SECRET_SCOPE, doc.sealed);
      deps.assertLive();
      return normalizeConnectS3Config(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as ConnectS3Config);
    } catch { throw new StorageRuntimeError("storage_provider_error", "S3 configuration could not be opened"); }
    finally { plaintext?.fill(0); store.close(); }
  }
  function forget(config: ConnectS3Config | undefined) { if (config) { config.accessKeyId = ""; config.secretAccessKey = ""; config.sessionToken = ""; } }
  async function open(ctx: OwnerAppStorageGrant, encrypted = false): Promise<ConnectFileStore> {
    const captured = lifetime;
    const config = await read();
    if (!config) throw new StorageRuntimeError("storage_not_configured", "Configure S3 in wallet settings before using App storage");
    const live = () => { try { deps.assertLive(); return captured === lifetime && !captured.signal.aborted; } catch { return false; } };
    try {
      if (!live()) throw new StorageRuntimeError("storage_unavailable", "S3 configuration changed");
      const base = createConnectS3FileStore(config, ctx, live, captured.signal);
      const store = encrypted ? createEncryptedFileStore(base, ctx, deps.secrets, () => {
        if (!live()) throw new StorageRuntimeError("storage_unavailable", "Encrypted storage session expired");
      }, captured.signal) : base;
      return { ...store, bindingId: captured, close() { store.close(); forget(config); } };
    } catch (error) { forget(config); throw error; }
  }
  async function execute(request: ConnectS3Request, signal?: AbortSignal): Promise<ConnectS3Response> {
    const assertCurrent = () => { deps.assertLive(); signal?.throwIfAborted(); };
    assertCurrent();
    if (request.type === "save" || request.type === "clear") {
      const pending = tail.then(async (): Promise<ConnectS3Response> => {
        let store: ModuleFileStore | undefined;
        let config: ConnectS3Config | undefined;
        let bytes: Uint8Array | undefined;
        try {
          assertCurrent();
          store = await deps.settings();
          if (request.type === "clear") {
            assertCurrent(); await store.delete(configPath); invalidate(); deps.assertLive();
            traceDev("storage.connect-s3", "configuration.cleared", () => ({}));
            return { configured: false };
          }
          const configured = Boolean(await store.get(configPath));
          try { config = normalizeConnectS3Config(request.config); }
          catch { return { configured, failure: { stage: "configuration", cleanupFailed: false } }; }
          const current = lifetime;
          try { await probeConnectS3(config, { identity: deps.identity, lifetime: current.signal, signal, assertLive: deps.assertLive }); }
          catch (error) {
            if (error instanceof ConnectS3ProbeError) return { configured, failure: error.failure };
            throw error;
          }
          assertCurrent();
          if (current !== lifetime) throw new StorageRuntimeError("storage_unavailable", "S3 configuration changed during check");
          // 所有远端步骤（包括清理）通过后，才开始本地加密和事务提交。
          bytes = new TextEncoder().encode(JSON.stringify(config));
          const sealed = await deps.secrets.seal(CONNECT_S3_SECRET_SCOPE, bytes);
          assertCurrent();
          await store.put(configPath, new TextEncoder().encode(JSON.stringify({ version: 1, sealed })), { contentType: "application/json" });
          invalidate(); deps.assertLive();
          traceDev("storage.connect-s3", "configuration.saved", () => ({}));
          return { configured: true, config: connectS3Summary(config) };
        } finally { bytes?.fill(0); forget(config); if (request.type === "save") forget(request.config); store?.close(); }
      });
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    }
    const current = lifetime;
    const config = await read();
    try {
      if (!config) {
        if (request.type === "probe") throw new StorageRuntimeError("storage_unavailable", "S3 is not configured");
        return { configured: false };
      }
      if (request.type === "probe") {
        try { await probeConnectS3(config, { identity: deps.identity, lifetime: current.signal, signal, assertLive: deps.assertLive }); }
        catch (error) {
          if (error instanceof ConnectS3ProbeError) return { configured: true, failure: error.failure };
          throw error;
        }
        if (current !== lifetime) throw new StorageRuntimeError("storage_unavailable", "S3 configuration changed during check");
      }
      assertCurrent();
      return { configured: true, config: connectS3Summary(config) };
    } finally { forget(config); }
  }
  return { open, execute, dispose: invalidate };
}
