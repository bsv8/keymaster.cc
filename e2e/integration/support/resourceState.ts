import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeIdentifier } from "./ids.js";

/** 跨 Playwright setup/teardown 项目传递的非敏感状态；不允许加入凭据或私钥。 */
export interface ResourceRunState {
  readonly version: 1;
  readonly runId: string;
  readonly configFingerprint: string;
  readonly s3LeaseAcquired: boolean;
  /** SatSubscription 的非敏感配置投影；真实连接结果由页面 Journey 验证。 */
  readonly satSubscription: {
    readonly network: "testnet";
    /** satsubscription.json 中的供应商公钥，仅用于配置投影，不代表远端服务身份已验证。 */
    readonly configuredSupplierPublicKeyHex: string;
    /** 是否由资源层探针验证 WebSocket；当前真实测试禁止 Node 探针，因此为 false。 */
    readonly websocketVerified: boolean;
    /** 是否由资源层探针验证 WebRTC Direct；当前仅由页面 Journey 验证。 */
    readonly webrtcDirectVerified: boolean;
  };
  /** testnet 资金库检查的公开投影，不包含 seed 或授权令牌。 */
  readonly testnet: {
    readonly network: "testnet";
    readonly seedAddress: string;
    readonly testnetBalance: number;
    readonly spendableUtxoCount: number;
    readonly tipHeight: number;
  };
  readonly createdAt: string;
}

export function resourceStatePath(): string {
  return path.resolve(process.env.KEYMASTER_E2E_RESOURCE_STATE_FILE ?? "test-results/integration-resource-state.json");
}

export async function writeResourceRunState(state: ResourceRunState): Promise<void> {
  const file = resourceStatePath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readResourceRunState(): Promise<ResourceRunState | null> {
  try {
    const value: unknown = JSON.parse(await readFile(resourceStatePath(), "utf8"));
    if (!value || typeof value !== "object") throw new Error("invalid resource state");
    const state = value as Partial<ResourceRunState>;
    if (
      state.version !== 1
      || typeof state.runId !== "string"
      || typeof state.configFingerprint !== "string"
      || !/^[0-9a-f]{16}$/iu.test(state.configFingerprint)
      || state.s3LeaseAcquired !== true
      || !state.satSubscription
      || state.satSubscription.network !== "testnet"
      || typeof state.satSubscription.websocketVerified !== "boolean"
      || typeof state.satSubscription.webrtcDirectVerified !== "boolean"
      || typeof state.satSubscription.configuredSupplierPublicKeyHex !== "string"
      || state.satSubscription.configuredSupplierPublicKeyHex.length === 0
      || !state.testnet
      || state.testnet.network !== "testnet"
      || typeof state.testnet.seedAddress !== "string"
      || !/^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/u.test(state.testnet.seedAddress)
      || !Number.isSafeInteger(state.testnet.testnetBalance)
      || state.testnet.testnetBalance < 0
      || !Number.isSafeInteger(state.testnet.spendableUtxoCount)
      || state.testnet.spendableUtxoCount < 0
      || !Number.isSafeInteger(state.testnet.tipHeight)
      || state.testnet.tipHeight < 0
      || typeof state.createdAt !== "string"
      || Number.isNaN(Date.parse(state.createdAt))
    ) throw new Error("invalid resource state");
    assertSafeIdentifier(state.runId, "resource run_id");
    return state as ResourceRunState;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return null;
    throw new Error("真实资源运行状态不可读");
  }
}

export async function removeResourceRunState(): Promise<void> {
  await unlink(resourceStatePath()).catch((error: unknown) => {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT")) throw error;
  });
}
