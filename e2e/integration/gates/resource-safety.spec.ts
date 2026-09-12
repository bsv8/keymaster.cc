import { expect, test } from "@playwright/test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadE2EConfig } from "../resources/config/loader.js";
import type { E2ES3Config } from "../resources/config/types.js";
import { S3CleanupResource } from "../resources/s3/s3CleanupResource.js";
import type { S3CleanupApi } from "../../../packages/platform-storage/src/testing/s3CleanupAdapter.js";
import { SatSubscriptionHealthResource } from "../resources/satsubscription/healthResource.js";
import { deriveTestnetP2pkhAddressFromPrivateKey, RecoveryLedger, TestnetFundingResource, type TestnetChainAdapter } from "../resources/testnet/fundingResource.js";
import { SecretString } from "../support/secretString.js";
import { RESOURCE_SAFETY_GATE } from "../support/scenarioMetadata.js";

export const GATE_ID = RESOURCE_SAFETY_GATE.id;
export const GATE_METADATA = RESOURCE_SAFETY_GATE;

/**
 * 业务结果：真实资源测试只能触碰维护者明确授权的资源，并且结果未知时不能盲目重发。
 *
 * 这是 Node Resource 的安全 Gate，不连接真实 S3、testnet 或 SatSubscription；它用受控
 * adapter 验证 fail-closed 规则。真实网络身份和资金余额仍由 real-resource 层另行证明。
 */

async function writeRestrictedFile(file: string, content: string): Promise<void> {
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

async function withConfigDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keymaster-e2e-config-"));
  await chmod(directory, 0o700);
  const seed = `01${"0".repeat(62)}`;
  try {
    await writeRestrictedFile(path.join(directory, "s3.json"), JSON.stringify({
      purpose: "keymaster-e2e",
      allowBucketWideCleanup: true,
      endpoint: "https://s3.example.test",
      region: "us-east-1",
      bucket: "keymaster-e2e-bucket",
      accessKeyId: "e2e-access",
      secretAccessKey: "test-secret-value",
      ownershipKey: ".keymaster-e2e/ownership.json",
      leaseKey: ".keymaster-e2e/lease.json",
    }));
    await writeRestrictedFile(path.join(directory, "satsubscription.json"), JSON.stringify({
      websocket: "wss://sat.example.test/socket",
      "webrtc-direct": "/dns4/sat.example.test/tcp/443/wss",
      testnetApiBaseUrl: "",
    }));
    await writeRestrictedFile(path.join(directory, "seed-key.hex"), `${seed}\n`);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

class FakeS3Api implements S3CleanupApi {
  readonly objects = new Map<string, { body: string; etag: string }>([
    [".keymaster-e2e/ownership.json", { body: JSON.stringify({ owner: "keymaster.cc", purpose: "exclusive-e2e-testing" }), etag: "ownership-v1" }],
    ["business/one", { body: "one", etag: "business-v1" }],
    ["business/two", { body: "two", etag: "business-v2" }],
  ]);
  versions = [
    { key: "business/one", versionId: "v1" },
    { key: "business/old", versionId: "v2" },
    { key: ".keymaster-e2e/ownership.json", versionId: "control-v1" },
  ];
  readonly uploads = [
    { key: "business/upload", uploadId: "upload-1" },
    { key: ".keymaster-e2e/control-upload", uploadId: "control-upload" },
  ];
  readonly deletedObjects: { key: string; versionId?: string }[] = [];
  readonly abortedUploads: string[] = [];
  #etagCounter = 0;

  async getObject(key: string): Promise<{ body: string; etag?: string } | null> {
    const value = this.objects.get(key);
    return value ? { ...value } : null;
  }

  async putObject(key: string, body: string, options: { ifNoneMatch?: string } = {}): Promise<{ etag?: string }> {
    if (options.ifNoneMatch === "*" && this.objects.has(key)) throw new Error("conditional put conflict");
    const etag = `etag-${++this.#etagCounter}`;
    this.objects.set(key, { body, etag });
    return { etag };
  }

  async deleteObject(key: string, options: { ifMatch?: string } = {}): Promise<void> {
    const current = this.objects.get(key);
    if (options.ifMatch !== undefined && current?.etag !== options.ifMatch) throw new Error("conditional delete conflict");
    this.objects.delete(key);
  }

  async listObjectsV2(): Promise<{ keys: readonly string[]; nextCursor?: string }> {
    return { keys: [...this.objects.keys()] };
  }

  async listObjectVersions(): Promise<{ objects: readonly { key: string; versionId?: string }[]; nextCursor?: { key?: string; version?: string } }> {
    return { objects: [...this.versions] };
  }

  async listMultipartUploads(): Promise<{ uploads: readonly { key: string; uploadId: string }[]; nextCursor?: { key?: string; uploadId?: string } }> {
    return { uploads: [...this.uploads] };
  }

  async deleteObjects(objects: readonly { key: string; versionId?: string }[]): Promise<void> {
    for (const object of objects) {
      this.deletedObjects.push({ ...object });
      if (object.versionId === undefined) this.objects.delete(object.key);
      else this.versions = this.versions.filter((item) => item.key !== object.key || item.versionId !== object.versionId);
    }
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.abortedUploads.push(uploadId);
  }
}

function fakeS3Config(secret: SecretString): E2ES3Config {
  return {
    purpose: "keymaster-e2e",
    allowBucketWideCleanup: true,
    endpoint: "https://s3.example.test",
    region: "us-east-1",
    bucket: "keymaster-e2e-bucket",
    accessKeyId: "e2e-access",
    secretAccessKey: secret,
    ownershipKey: ".keymaster-e2e/ownership.json",
    leaseKey: ".keymaster-e2e/lease.json",
  };
}

test(GATE_ID + "：配置目录和文件权限 fail-closed", async () => {
  await withConfigDirectory(async (directory) => {
    const config = await loadE2EConfig({ workspaceRoot: process.cwd(), configDir: directory });
    expect(config.s3.endpoint).toBe("https://s3.example.test");
    expect(String(config.s3.secretAccessKey)).toBe("[REDACTED_SECRET]");
    expect(config.testnet.privateKeyHex.toString()).toBe("[REDACTED_SECRET]");
    config.s3.secretAccessKey.clear();
    config.s3.sessionToken?.clear();
    config.testnet.privateKeyHex.clear();
  });
});

test(GATE_ID + "：配置目录权限过宽时不读取任何资源文件", async () => {
  await withConfigDirectory(async (directory) => {
    await chmod(directory, 0o755);
    await expect(loadE2EConfig({ workspaceRoot: process.cwd(), configDir: directory })).rejects.toMatchObject({ code: "config-directory-mode" });
  });
});

test(GATE_ID + "：S3 ownership、lease、版本和 multipart 清理保持在授权范围", async () => {
  const secret = new SecretString("test-secret-value");
  const api = new FakeS3Api();
  const resource = new S3CleanupResource(fakeS3Config(secret), api);
  await resource.acquireLease("run-resource-safety");
  const competingSecret = new SecretString("competing-secret-value");
  const competing = new S3CleanupResource(fakeS3Config(competingSecret), api);
  await expect(competing.acquireLease("other-run")).rejects.toThrow(/lease is held/iu);
  competingSecret.clear();
  await expect(resource.cleanup("other-run")).rejects.toThrow(/current run lease/iu);
  const summary = await resource.cleanup("run-resource-safety");
  expect(summary).toEqual({ deletedObjects: 2, deletedVersions: 2, abortedMultipartUploads: 1 });
  expect(api.deletedObjects).not.toContainEqual(expect.objectContaining({ key: ".keymaster-e2e/ownership.json" }));
  expect(api.abortedUploads).toEqual(["upload-1"]);
  await resource.releaseLease("run-resource-safety");
  expect(api.objects.has(".keymaster-e2e/lease.json")).toBe(false);
  secret.clear();
});

test(GATE_ID + "：SatSubscription 健康检查拒绝非 testnet 或身份分叉", async () => {
  const serviceKey = `02${"a".repeat(64)}`;
  const config = { websocket: "wss://sat.example.test/socket", webrtcDirect: "/dns4/sat.example.test/tcp/443/wss", testnetApiBaseUrl: "https://api.whatsonchain.com/v1/bsv" };
  const resource = new SatSubscriptionHealthResource(config, {
    checkWebsocket: async () => ({ network: "testnet", servicePublicKeyHex: serviceKey, entrypoint: "websocket" }),
    checkWebrtcDirect: async () => ({ network: "testnet", servicePublicKeyHex: serviceKey, entrypoint: "webrtc-direct" }),
  });
  const result = await resource.verify("run-resource-safety", { requireWebrtcDirect: true });
  expect(result.servicePublicKeyHex).toBe(serviceKey);
  await expect(new SatSubscriptionHealthResource(config, {
    checkWebsocket: async () => ({ network: "mainnet", servicePublicKeyHex: serviceKey, entrypoint: "websocket" }),
    checkWebrtcDirect: async () => ({ network: "testnet", servicePublicKeyHex: serviceKey, entrypoint: "webrtc-direct" }),
  }).verify("run-resource-safety")).rejects.toThrow(/not a testnet/iu);
  await expect(new SatSubscriptionHealthResource(config, {
    checkWebsocket: async () => ({ network: "testnet", servicePublicKeyHex: serviceKey, entrypoint: "websocket" }),
    checkWebrtcDirect: async () => ({ network: "testnet", servicePublicKeyHex: `03${"b".repeat(64)}`, entrypoint: "webrtc-direct" }),
  }).verify("run-resource-safety", { requireWebrtcDirect: true })).rejects.toThrow(/identities differ/iu);
});

test(GATE_ID + "：testnet 结果未知进入恢复账本且禁止盲目重发", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keymaster-e2e-ledger-"));
  await chmod(directory, 0o700);
  const seed = new SecretString(`01${"0".repeat(62)}`);
  const ledger = new RecoveryLedger(path.join(directory, "funding.json"));
  let fundCalls = 0;
  const chain: TestnetChainAdapter = {
    async inspectNetwork() { return { network: "testnet", tipHeight: 1 }; },
    async inspectAddress() { return { testnetBalance: 10_000, mainnetBalance: 0, spendableUtxoCount: 1 }; },
    async fundFromSeed() { fundCalls += 1; return { status: "uncertain", operationId: "run-resource-safety:fund" }; },
    async reconcile() { return { status: "uncertain" }; },
    async returnFunds() { return { status: "uncertain", operationId: "run-resource-safety:return" }; },
  };
  const resource = new TestnetFundingResource(seed, chain, ledger);
  const wallet = resource.createOneTimeWallet("run-resource-safety", "funding");
  try {
    await expect(resource.fund(wallet, 100, { maxFundingSatoshis: 1_000, maxLossSatoshis: 100, feeReserveSatoshis: 10 })).rejects.toThrow(/blind retry is forbidden/iu);
    expect(fundCalls).toBe(1);
    expect((await ledger.uncertain())).toHaveLength(1);
    expect(await readFile(path.join(directory, "funding.json"), "utf8")).not.toContain(wallet.privateKey.read());
  } finally {
    wallet.clear();
    seed.clear();
    await rm(directory, { recursive: true, force: true });
  }
});

test(GATE_ID + "：充值、业务转出和归集按实际金额闭合", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keymaster-e2e-ledger-accounting-"));
  await chmod(directory, 0o700);
  const seed = new SecretString(`01${"0".repeat(62)}`);
  const walletPrivateKey = new SecretString(`02${"0".repeat(62)}`);
  const ledger = new RecoveryLedger(path.join(directory, "funding.json"));
  const seedAddress = deriveTestnetP2pkhAddressFromPrivateKey(seed.read());
  let returnCalls = 0;
  const chain: TestnetChainAdapter = {
    async inspectNetwork() { return { network: "testnet", tipHeight: 1 }; },
    async inspectAddress() { return { testnetBalance: 10_000, mainnetBalance: 0, spendableUtxoCount: 1 }; },
    async fundFromSeed() { return { status: "broadcast", txid: "11".repeat(32), outputSatoshis: 1_000, feeSatoshis: 2 }; },
    async reconcile() { return { status: "broadcast", txid: "11".repeat(32) }; },
    async returnFunds() {
      returnCalls += 1;
      return { status: "broadcast", txid: "33".repeat(32), outputSatoshis: 890, feeSatoshis: 10 };
    },
  };
  const resource = new TestnetFundingResource(seed, chain, ledger);
  const wallet = {
    ...resource.createOneTimeWallet("run-accounting", "funding"),
    privateKey: walletPrivateKey,
  };
  try {
    await resource.fund(wallet, 1_000, { maxFundingSatoshis: 1_000, maxLossSatoshis: 10, feeReserveSatoshis: 10 });
    await resource.recordBusinessTransaction(wallet, "22".repeat(32), 100);
    const returned = await resource.returnRemaining(wallet, seedAddress);
    expect(returned).toMatchObject({
      status: "returned",
      businessSatoshis: 100,
      returnedSatoshis: 890,
      returnFeeSatoshis: 10,
      lossSatoshis: 10,
      returnTxid: "33".repeat(32),
    });
    expect(returnCalls).toBe(1);
    expect(JSON.stringify(await ledger.read())).not.toContain(walletPrivateKey.read());
  } finally {
    wallet.clear();
    walletPrivateKey.clear();
    seed.clear();
    await rm(directory, { recursive: true, force: true });
  }
});
