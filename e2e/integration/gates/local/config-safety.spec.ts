import { expect, test } from "@playwright/test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadE2EConfig } from "../../resources/config/loader.js";
import type { LoadedE2EConfig } from "../../resources/config/types.js";
import { CONFIG_SAFETY_GATE } from "../../support/scenarioMetadata.js";

export const GATE_ID = CONFIG_SAFETY_GATE.id;
export const GATE_METADATA = CONFIG_SAFETY_GATE;

async function writeRestrictedFile(file: string, content: string): Promise<void> {
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
}

async function withConfigDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "keymaster-e2e-config-"));
  await chmod(directory, 0o700);
  try {
    await writeRestrictedFile(path.join(directory, "s3.json"), JSON.stringify({
      endpoint: "https://s3.example.test",
      region: "us-east-1",
      bucket: "keymaster-e2e-bucket",
      accessKeyId: "e2e-access",
      secretAccessKey: "test-secret-value",
    }));
    await writeRestrictedFile(path.join(directory, "satsubscription.json"), JSON.stringify({
      websocket: "wss://sat.example.test/socket",
      "webrtc-direct": "/dns4/sat.example.test/tcp/443/wss",
      publickeyhex: "02" + "11".repeat(32),
      testnetApiBaseUrl: "",
    }));
    await writeRestrictedFile(path.join(directory, "seed-key.hex"), `01${"0".repeat(62)}\n`);
    await writeRestrictedFile(path.join(directory, "key01.hex"), `02${"0".repeat(62)}\n`);
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function clearSecrets(config: LoadedE2EConfig | undefined): void {
  config?.s3.secretAccessKey.clear();
  config?.s3.sessionToken?.clear();
  config?.satsubscription.testnetApiAuthorization?.clear();
  config?.testnet.privateKeyHex.clear();
  config?.testnet.trackingKeyPrivateKeyHex.clear();
}

/**
 * 业务结果：真实资源测试的配置错误必须在读取资源前被拒绝，不能让错误路径、
 * 凭据或工作树中的文件进入后续 E2E。这里验证的是配置文件安全边界，不模拟
 * S3、testnet 或 SatSubscription 的服务行为；真实服务行为由 resources/s3/satsubscription 执行档验证。
 */
test(`${GATE_ID}：仓库外配置和秘密容器通过安全校验`, async () => {
  await withConfigDirectory(async (directory) => {
    let config: LoadedE2EConfig | undefined;
    try {
      config = await loadE2EConfig({ workspaceRoot: process.cwd(), configDir: directory });
      expect(config.s3.endpoint).toBe("https://s3.example.test");
      expect(String(config.s3.secretAccessKey)).toBe("[REDACTED_SECRET]");
      expect(String(config.testnet.privateKeyHex)).toBe("[REDACTED_SECRET]");
      expect(String(config.testnet.trackingKeyPrivateKeyHex)).toBe("[REDACTED_SECRET]");
    } finally {
      clearSecrets(config);
    }
  });
});

test(`${GATE_ID}：缺少可追踪测试 Key 时在读取资源前 fail-closed`, async () => {
  await withConfigDirectory(async (directory) => {
    await rm(path.join(directory, "key01.hex"));
    await expect(loadE2EConfig({ workspaceRoot: process.cwd(), configDir: directory })).rejects.toMatchObject({ code: "config-file-missing" });
  });
});

test(`${GATE_ID}：配置目录权限过宽时在读取资源前 fail-closed`, async () => {
  await withConfigDirectory(async (directory) => {
    await chmod(directory, 0o755);
    await expect(loadE2EConfig({ workspaceRoot: process.cwd(), configDir: directory })).rejects.toMatchObject({ code: "config-directory-mode" });
  });
});
