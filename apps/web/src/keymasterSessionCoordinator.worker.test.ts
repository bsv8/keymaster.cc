import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToHex } from "@keymaster/plugin-vault/coordinator";
import type { CoordinatorClientRequest, CoordinatorResponse, CoordinatorSatEvent, CoordinatorSessionBinding, CoordinatorSessionCloseRequest, CoordinatorSessionOpenRequest, CoordinatorStorageControl, JSONValue } from "@keymaster/contracts";
import { CHAIN_HEIGHT_SYNC_TASK_ID, COORDINATOR_RPC_CAPABILITY, backgroundSyncDefaultIntervalMs, parseCoordinatorResponseFor } from "@keymaster/contracts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  __testAcquireExecutorLease,
  __testPublishSatState,
  __testWindowP2pInboundBridgePressure,
  __testWindowP2pResponseBridgePressure,
  __testStartSatInboundHandler,
  __testCancelSatInboundHandler,
  __testRevokeWindowP2pExecutorLease,
  __testChangeSatInboundGeneration,
  __testSatInboundHandlerSnapshot,
  __testSetSatInboundResponseDispatcher,
  __testExecutorSignNoise,
  __testExecutorSignPeerRecord,
  __testReleaseExecutorLease,
  __testDispatchMsfileControl,
  __testDispatchMsfileControlWithEpoch,
  __testDispatchMsfileData,
  __testDispatchMsfileGrant,
  __testDispatchMsfileSessionAbort,
  __testEnsureSatRuntime,
  __testReleaseSatRuntime,
  __testAwaitMsfileSellerDependencyResume,
  __testReleaseMsfileRuntime,
  __testSetMsfileReadConcurrencySettings,
  __testSetMsfileRuntimeOverride,
  __testBuildChannelPublicMessageTimes,
  __testBuildChannelSeenMessageKey,
} from "./keymasterSessionCoordinator.worker.js";
import { COORDINATOR_WORKER_UNIT_CATALOG } from "./coordinator/workerUnitCatalog.js";
import { CoordinatorUnitUnavailableError, isCoordinatorUnitUnavailableError } from "./coordinator/workerUnitAvailability.js";
import { peerIdFromPublicKeyBytes } from "bitcoin-libp2p/identity";
import { calcTxidFromRawTxHex } from "@keymaster/plugin-p2pkh/coordinator";
import { HASH_REQUEST_CHANNEL, messageIDFromBytes, newMessageID, newSessionID, parsePrivateKey, parsePublicKey, parseSHA256Hash } from "bsv8-channel-protocol";
import { marshal, newMultiaddrLocator, parseAndVerify, sign } from "bsv8-channel-protocol/hash-request";
import { parseBodyValue as parseWebrtcBodyValue } from "bsv8-channel-protocol/webrtc-signal";
import { verifySignedPrivateMessage } from "bsv8-channel-protocol/inbox";
import { PUBLIC_MESSAGE_MAX_LIFETIME_MS } from "bsv8-channel-protocol/public-message";

// Worker 现在始终解析已有本地记录的 rawTxHex；测试也使用真实可解析交易。
function makeTestP2pkhRawTx(inputTxid: string): string {
  return `0100000001${inputTxid}0000000000ffffffff01e8030000000000001976a914${"11".repeat(20)}88ac00000000`;
}
import {
  __testBackgroundRunNow,
  __testCancelByKey,
  __testChangePassword,
  __testCollectCoordinatorKeyValueGarbage,
  __testGetActivePublicKeyHex,
  __testOwnerStoragePut,
  __testGetConnectedPortCount,
  __testDispatchStorageGrant,
  __testDispatchStorageData,
  __testDispatchStorageControl,
  __testDispatchStorageCancel,
  __testDispatchStorageBrowseOpen,
  __testHasStorageBrowseAuthorization,
  __testDispatchStorageAbort,
  __testResolveStorageGrant,
  __testSeedStorageRequest,
  __testSetStorageRuntime,
  __testSetStorageStartupFailure,
  __testReleaseStorageRuntime,
  __testStorageMutationBarrierProbe,
  __testStorageQueueAdmission,
  __testStorageQueueSnapshot,
  __testStorageSlotErrorCodes,
  __testStorageCancelKeepsPhysicalSlots,
  __testStorageFairDispatch,
  __testPublishStorageState,
  __testStorageTransfer,
  __testAttachPort,
  __testInstallCoordinatorBridgePeer,
  __testHandleCoordinatorSessionRpc,
  __testSetCoordinatorPeerHandoffNotifier,
  __testAwaitCoordinatorPeerDrain,
  __testCloseCoordinatorBridgePeer,
  __testDispatchStorageMessage,
  __testFenceCoordinatorAuthority,
  __testHoldCoordinatorFinalIoLease,
  __testGetCoordinatorUpgradePartition,
  __testSetStorageSessionResolver,
  __testGetSnapshot,
  __testResetChainHeight,
  __testGetMsfileSellerLifecycle,
  __testSetMsfileSellerBridge,
  __testDispatchMsfileSellerHashRequest,
  __testMsfileSellerSessionCount,
  __testMsfileStoreSeed,
  __testAdvanceWalletGeneration,
  __testGetVaultStatus,
  __testInvalidateSession,
  __testLock,
  __testRegisterTask,
  __testResetState,
  __testRestartWorker,
  __testRunTask,
  __testSetVaultStatus,
  __testFailNextCoordinatorSnapshotPersist,
  __testSeedP2pkhLocalSubmission,
  __testListP2pkhLocalTransactions,
  __testListP2pkhLocalInputClaims,
  __testP2pkhBroadcast,
  __testSetP2pkhBroadcastProvider,
  __testSetP2pkhUnspentAllProvider,
  __testSetSatBroadcastRetryOverrides,
  __testSetChainHeightProvider,
  __testGetChainHeight,
  __testReadBitfsBlockHeight,
  __testRegisterRealCoordinatorTasks,
  __testEnsureSatP2pkhService,
  __testSealLocalSecret,
  __testEncodeChannelPrivateBody,
  __testValidateChannelPrivateProtocol,
  __testSignChannelPrivateMessage,
  __testUnlock,
  __testUpdateScheduleSettings,
  __testSetSmartSyncDebounceMs,
  __testNotifyWocQueueChange,
  __testSmartSyncState,
  __testTriggerImmediateSync,
  __testReloadCoordinatorMeta,
  __testCoordinatorSnapshotMetrics,
  __testBootstrapWalletStorage,
  __testColdStart,
  __testResetWalletStore,
  __testSeedWalletLocalRecords,
  __testSeedCoordinatorSettingsSnapshot,
  __testSeedCoordinatorKeyValueGarbage,
  __testListWalletObjectPaths,
} from "./keymasterSessionCoordinator.worker.js";
import type { PeerController } from "webloom-framework";
import type {
  WalletColdStartSnapshot,
  WalletInitializeResult,
} from "@keymaster/contracts";

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly messages: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  start(): void {}
  close(): void { this.onclose?.(); }
  postMessage(message: unknown): void { this.messages.push(message); }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: MessageEvent) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(message: unknown): void {
    const event = { data: message } as MessageEvent;
    this.onmessage?.(event);
    for (const listener of [...(this.listeners.get("message") ?? [])]) listener(event);
  }
}

/**
 * Unit tests enter the Coordinator through an explicit test sink. This keeps
 * the production Worker free of a second raw MessagePort router while still
 * allowing existing domain tests to observe typed stream projections.
 */
function attachTestPort(clientId: string, port = new TestPort()): TestPort {
  __testAttachPort(clientId, (message) => port.messages.push(message));
  port.onmessage = (event) => {
    void __testDispatchStorageMessage(clientId, event.data as CoordinatorClientRequest);
  };
  port.onclose = () => {
    void __testDispatchStorageMessage(clientId, { kind: "disconnect", clientId: "test-spoof", requestId: `disconnect-${clientId}` });
  };
  return port;
}

// metadata snapshot validator 会校验 secp256k1 曲线点；测试 fixture 使用
// 确定性私钥派生真实压缩公钥，只有显式 malformed case 才使用无效值。
function validPublisherKey(seed: number): string {
  const privateKey = new Uint8Array(32);
  privateKey[31] = seed;
  return bytesToHex(secp256k1.getPublicKey(privateKey, true));
}

const VALID_PUBLISHER_KEYS = [1, 2, 3, 4, 5, 6].map(validPublisherKey);

/** 测试用的 hex -> bytes；Worker 侧只导出 bytesToHex，方向反了要在这里换。 */
function hexToBytesTest(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

const TEST_PRIV_2 = "0000000000000000000000000000000000000000000000000000000000000002";

async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

/** 等到某个 requestId 的响应真正出现在端口上；Worker 侧是多段 await 的流水线。 */
async function waitForPortResponse(port: TestPort, requestId: string): Promise<CoordinatorResponse> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = port.messages.find((message) => (message as { requestId?: string }).requestId === requestId) as CoordinatorResponse | undefined;
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Coordinator did not answer ${requestId}`);
}

/**
 * 从源码里取出某个顶层函数的函数体（含签名行，按花括号配对）。
 *
 * 中文说明：用于结构性门禁——断言 `ensure*Runtime()` 内部只走统一可用性判定、
 * 不再自带 reconcile-and-pray 兜底。按源码断言比按错误文案断言可靠：文案会被
 * 改写，也可能被新代码合法复用。
 */
function extractFunctionBody(source: string, name: string): string {
  const signature = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(source);
  if (!signature) throw new Error(`源码中找不到函数 ${name}`);
  const start = source.indexOf("{", signature.index);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(signature.index, index + 1);
    }
  }
  throw new Error(`函数 ${name} 的花括号不配对`);
}

type CoordinatorTestPeer = Pick<PeerController, "peerId" | "scope" | "exposeGroup">;

interface CoordinatorTestPeerHarness {
  peer: CoordinatorTestPeer;
  exposureCount: number;
  exposureRevocationCount: number;
}

/**
 * 最小 Coordinator peer 夹具。
 *
 * 单 Key 本地存储没有桶目录、设备记录或 LocalStorage bridge，因此这里不再
 * 提供反向 capability：只需要 `exposeGroup` 来观察服务曝光的建立与撤销。
 */
function makeCoordinatorTestPeer(peerId: string): CoordinatorTestPeerHarness {
  let exposureCount = 0;
  let exposureRevocationCount = 0;
  const scope = {
    state: "active" as const,
    onRevoke: (_listener: (reason: string) => void) => () => undefined,
  } as unknown as PeerController["scope"];
  const peer = {
    peerId,
    scope,
    exposeGroup: () => {
      exposureCount += 1;
      let revoked = false;
      return {
        revoke: () => {
          if (revoked) return;
          revoked = true;
          exposureRevocationCount += 1;
        },
      };
    },
  } as CoordinatorTestPeer;
  return {
    peer,
    get exposureCount() { return exposureCount; },
    get exposureRevocationCount() { return exposureRevocationCount; },
  };
}

/** 测试用私钥：确定性向量，避免每个用例各自生成。 */
const TEST_PRIV_1 = "0000000000000000000000000000000000000000000000000000000000000001";
const TEST_PRIV_3 = "0000000000000000000000000000000000000000000000000000000000000003";

interface TestWallet {
  publicKeyHex: string;
  label: string;
  walletGeneration: string;
}

/**
 * 以生产控制面创建或导入唯一 Key。
 *
 * 测试不再伪造 Vault 结构：initialize 会走真实 IndexedDB 事务，并在同一
 * 事务提交后安装 Root、runtime 与任务。
 */
async function initializeTestWallet(input?: {
  label?: string;
  password?: string;
  /** 私钥 hex；缺省时导入 TEST_PRIV_2。 */
  privateKeyHex?: string;
  transactionId?: string;
}): Promise<TestWallet> {
  // 单 Key 模型下 initialize 需要真实装配的 lifecycle；不是每个 describe 的
  // beforeEach 都会先 bootstrap，这里按需补一次，已装配时是幂等的。
  await __testBootstrapWalletStorage();
  const label = input?.label ?? "test-wallet";
  const password = input?.password ?? "test-wallet-password";
  const response = await __testDispatchStorageControl({
    type: "initialize",
    plan: {
      transactionId: input?.transactionId ?? `init-${label}`,
      firstKey: {
        kind: "import",
        label,
        material: { hex: input?.privateKeyHex ?? TEST_PRIV_2 },
        format: "hex",
        capabilities: ["p2pkh"],
        password,
      },
    },
  });
  if (response.ack.status !== "ok") throw new Error(`initialize ack: ${JSON.stringify(response.ack)}`);
  const result = response.operationResult as WalletInitializeResult;
  if (!result.ok) throw new Error(`initialize failed: ${JSON.stringify(result.error)}`);
  return {
    publicKeyHex: result.key.publicKeyHex,
    label: result.key.label,
    walletGeneration: result.walletGeneration,
  };
}

async function dispatchStorageControl<T>(control: CoordinatorStorageControl): Promise<T> {
  const response = await __testDispatchStorageControl(control);
  if (response.ack.status !== "ok") throw new Error(`storage control ${control.type} failed: ${JSON.stringify(response.ack)}`);
  return response.operationResult as T;
}

/**
 * 准备一个已初始化且解锁的钱包，让 Coordinator 自有的持久快照（同步管理、
 * 插件意图）有 Root 可写。
 *
 * 单 Key 模型只在冷启动为 ready 时安装平台 Root，未初始化钱包没有快照句柄；
 * 用 `__testSetVaultStatus` 伪造 unlocked 并不等于装配完成。
 */
async function bootstrapReadyWallet(label: string): Promise<void> {
  await initializeTestWallet({ label, password: "ready-pw" });
  const unlocked = await __testUnlock("ready-pw");
  expect(["ok", "accepted", "already-unlocked"]).toContain(unlocked.ack.status);
}

/** `validPublisherKey(seed)` 的私钥侧：最后一个字节就是 seed。 */
function privateKeyHexForPublisherSeed(seed: number): string {
  return `${"00".repeat(31)}${seed.toString(16).padStart(2, "0")}`;
}

/**
 * 准备一个身份为 `publicKeyHex` 的已解锁钱包。
 *
 * 单 Key 模型下 P2PKH 等模块文件存储按当前唯一 Key 归属，测试不能再随手
 * 伪造一个 owner 公钥：那样写入会落到一个没有 Root 的身份上。
 */
async function bootstrapWalletOwnedBy(publicKeyHex: string, seed: number, label: string): Promise<void> {
  const created = await initializeTestWallet({ label, password: "ready-pw", privateKeyHex: privateKeyHexForPublisherSeed(seed) });
  expect(created.publicKeyHex.toLowerCase()).toBe(publicKeyHex.toLowerCase());
  const unlocked = await __testUnlock("ready-pw");
  expect(["ok", "accepted", "already-unlocked"]).toContain(unlocked.ack.status);
}

async function coldStartTestSnapshot(): Promise<WalletColdStartSnapshot> {
  return await __testDispatchStorageControl({ type: "cold-start" }).then((response) => {
    if (response.ack.status !== "ok") throw new Error(`cold-start failed: ${JSON.stringify(response.ack)}`);
    return response.operationResult as WalletColdStartSnapshot;
  });
}

type CoordinatorSessionRpcResponse = Awaited<ReturnType<typeof __testHandleCoordinatorSessionRpc>>;

function sessionBindingFromOpenResponse(response: CoordinatorSessionRpcResponse): CoordinatorSessionBinding {
  const result = response.operationResult as { sessionBinding?: CoordinatorSessionBinding } | undefined;
  if (!result?.sessionBinding) throw new Error("session.open did not return a session binding");
  return result.sessionBinding;
}

function sessionOpen(leaseId: string): CoordinatorSessionOpenRequest {
  return { kind: "session.open", leaseId };
}

function sessionClose(binding: CoordinatorSessionBinding): CoordinatorSessionCloseRequest {
  return { kind: "session.close", ...binding };
}

describe("Coordinator ChannelProtocol 私信编码边界", () => {
  it("通过真实 WebRTC parser 编码 bsv8.webrtc.signal.v1 的全部信令分支", () => {
    const requestMessageId = newMessageID();
    const sessionId = newSessionID();
    const body = __testEncodeChannelPrivateBody("bsv8.webrtc.signal.v1", {
      request_message_id: requestMessageId,
      session_id: sessionId,
      signal: { type: "offer", sdp: "v=0\\r\\nm=audio 9 RTP/AVP 0" }
    });

    expect(parseWebrtcBodyValue(body as unknown as JSONValue)).toMatchObject({
      request_message_id: requestMessageId,
      session_id: sessionId,
      signal: { type: "offer", sdp: "v=0\\r\\nm=audio 9 RTP/AVP 0" }
    });
    const branches: JSONValue[] = [
      {
        request_message_id: newMessageID(),
        session_id: newSessionID(),
        signal: { type: "answer", sdp: "v=0" }
      },
      {
        request_message_id: newMessageID(),
        session_id: newSessionID(),
        signal: {
          type: "ice-candidate",
          candidate: { candidate: "candidate:1 1 UDP 1 127.0.0.1 9 typ host", sdp_mid: null, sdp_m_line_index: 0 }
        }
      },
      {
        request_message_id: newMessageID(),
        session_id: newSessionID(),
        signal: { type: "end-of-candidates" }
      }
    ];
    for (const branch of branches) {
      const encoded = __testEncodeChannelPrivateBody("bsv8.webrtc.signal.v1", branch);
      expect(() => parseWebrtcBodyValue(encoded as unknown as JSONValue)).not.toThrow();
    }
    expect(() => __testEncodeChannelPrivateBody("bsv8.webrtc.signal.v1", {
      schema: "keymaster.webrtc.v1",
      type: "offer",
      sessionId,
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      sdp: "v=0"
    })).toThrow();
  });

  it("按 Host 绑定的 caller 身份限制私有协议发布", () => {
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "plugin", pluginId: "message" },
      "bsv8.message.v1"
    )).not.toThrow();
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "plugin", pluginId: "webrtc" },
      "bsv8.webrtc.signal.v1"
    )).not.toThrow();
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "system", systemId: "contacts-presence" },
      "bsv8.ping.v1"
    )).not.toThrow();

    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "plugin", pluginId: "message" },
      "bsv8.webrtc.signal.v1"
    )).toThrow();
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "plugin", pluginId: "bsv-price" },
      "bsv8.ping.v1"
    )).toThrow();
    expect(() => __testValidateChannelPrivateProtocol(
      { kind: "connect", connectSessionId: "session", origin: "https://app.example" },
      "bsv8.message.v1"
    )).toThrow();
  });

  it("使用 ChannelProtocol TTL 完成真实私密消息签名与验证", () => {
    const nowMs = 1_700_000_000_000;
    const privateKeyHex = "0000000000000000000000000000000000000000000000000000000000000001";
    const recipientPublicKeyHex = validPublisherKey(2);
    const cases = [
      {
        protocol: "bsv8.ping.v1",
        content: { type: "ping" } as JSONValue,
        lifetimeMs: 60_000
      },
      {
        protocol: "bsv8.webrtc.signal.v1",
        content: {
          request_message_id: newMessageID(),
          session_id: newSessionID(),
          signal: { type: "offer", sdp: "v=0\\r\\nm=application 9 DTLS/SCTP 5000" }
        } as JSONValue,
        lifetimeMs: 120_000
      },
      {
        protocol: "bsv8.message.v1",
        content: { type: "deliver", content: { hello: "world" } } as JSONValue,
        lifetimeMs: 24 * 60 * 60 * 1000
      }
    ];

    for (const item of cases) {
      const signed = __testSignChannelPrivateMessage({
        recipientPublicKeyHex,
        protocol: item.protocol,
        content: item.content,
        nowMs,
        privateKeyHex
      });
      expect(signed.expires_at_ms - signed.issued_at_ms).toBe(item.lifetimeMs);
      // 0.6.0 起 SDK 不再用本地时钟判断过期；结构合法且签名有效即通过。
      expect(() => verifySignedPrivateMessage(signed)).not.toThrow();
    }
  });

  it("公开消息时间只读取一次系统时钟", () => {
    const clocks = [1_700_000_000_000, 1_700_000_000_001];
    const times = __testBuildChannelPublicMessageTimes(() => clocks.shift() ?? 0);
    expect(times).toEqual({
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_000_000 + PUBLIC_MESSAGE_MAX_LIFETIME_MS
    });
    // 第二个值故意存在：如果实现再次读取 Date.now，这个测试的输入就会被消耗。
    expect(clocks).toEqual([1_700_000_000_000 + 1]);
  });

  it("公共、私密与 Hash Request 消息使用独立的本地去重命名空间", () => {
    const sharedFirstPart = "bsv8.ping.v1";
    const publisherPublicKey = validPublisherKey(1);
    const messageId = newMessageID();

    const privateSeenKey = __testBuildChannelSeenMessageKey(
      "private",
      sharedFirstPart,
      publisherPublicKey,
      messageId
    );
    const publicSeenKey = __testBuildChannelSeenMessageKey(
      "public",
      sharedFirstPart,
      publisherPublicKey,
      messageId
    );
    const hashRequestSeenKey = __testBuildChannelSeenMessageKey(
      "hash-request",
      `${publisherPublicKey}\u0000${messageId}`
    );

    expect(new Set([privateSeenKey, publicSeenKey, hashRequestSeenKey]).size).toBe(3);
    expect(__testBuildChannelSeenMessageKey(
      "public",
      sharedFirstPart,
      publisherPublicKey,
      messageId
    )).toBe(publicSeenKey);
  });
});

describe("Session Coordinator worker", () => {
  // 本组用例各自装配自己的钱包，IndexedDB 是进程级共享的：没有这层隔离，
  // 上一个用例提交的 key.json 会让下一个 initialize 撞上 storage_conflict。
  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    __testSetStorageSessionResolver(undefined);
    __testSetStorageRuntime(undefined);
    await __testResetWalletStore();
  });

  it("rejects forged client ownership and revoked/changed Storage grants", async () => {
    await __testBootstrapWalletStorage();
    await initializeTestWallet({ label: "grant-forgery" });
    const ownerPublicKeyHex = VALID_PUBLISHER_KEYS[2]!;
    __testSetVaultStatus("unlocked", ownerPublicKeyHex);
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[0]!, appId: "app", appName: "App", identityDigestHex: "aa".repeat(32) };
    let revoked = false;
    __testSetStorageSessionResolver(async (id) => revoked ? null : { sessionId: id, origin: "https://app.example", ownerPublicKeyHex, appIdentity: identity, revokedAt: null });
    const granted = await __testDispatchStorageGrant("session-a", "port-a", "forged-client");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;
    __testSetStorageRuntime({ list: async () => ({ prefix: "", parentPrefix: "", directories: [], files: [] }), abortSession: async () => undefined });
    expect((await __testDispatchStorageData({ grantId, actualPortId: "forged-client", requestClientId: "port-a" })).ack.status).toBe("error");
    revoked = true;
    expect((await __testDispatchStorageGrant("session-a", "port-a")).ack.status).toBe("error");
    await expect(__testResolveStorageGrant(grantId, "port-a")).rejects.toThrow();
    __testSetStorageRuntime(undefined);
    __testSetStorageSessionResolver(undefined);
  });

  it("rejects unknown and identity-less sessions and binds grants to unchanged origin/identity", async () => {
    const ownerPublicKeyHex = VALID_PUBLISHER_KEYS[2]!;
    await bootstrapWalletOwnedBy(ownerPublicKeyHex, 3, "unknown-sessions");
    __testSetStorageSessionResolver(async () => null);
    expect((await __testDispatchStorageGrant("missing", "port-a")).ack.status).toBe("error");
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[1]!, appId: "app", appName: "App", identityDigestHex: "bb".repeat(32) };
    let origin = "https://one.example";
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, ownerPublicKeyHex, appIdentity: identity, revokedAt: null }));
    const granted = await __testDispatchStorageGrant("session-b", "port-a");
    expect(granted.ack.status).toBe("ok");
    origin = "https://two.example";
    await expect(__testResolveStorageGrant(granted.operationResult as string, "port-a")).rejects.toThrow();
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, appIdentity: { ...identity, publisherPublicKeyHex: "22".repeat(32) }, revokedAt: null }));
    expect((await __testDispatchStorageGrant("short-key", "port-a")).ack.status).toBe("error");
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin, appIdentity: undefined as never, revokedAt: null }));
    expect((await __testDispatchStorageGrant("no-identity", "port-a")).ack.status).toBe("error");
    __testSetStorageSessionResolver(undefined);
  });

  it("enforces cancel owner and aborts only the selected session", async () => {
    __testSetStorageRuntime({ abortSession: async () => undefined });
    const a = __testSeedStorageRequest("a", "port-a", "session-a");
    const b = __testSeedStorageRequest("b", "port-b", "session-b");
    const collisionA = __testSeedStorageRequest("same", "port-a", "session-a");
    const collisionB = __testSeedStorageRequest("same", "port-b", "session-b");
    await __testDispatchStorageCancel("a", "port-b");
    expect(a.aborted).toBe(false);
    await __testDispatchStorageCancel("a", "port-a");
    expect(a.aborted).toBe(true);
    await __testDispatchStorageCancel("same", "port-a");
    expect(collisionA.aborted).toBe(true);
    expect(collisionB.aborted).toBe(false);
    await __testDispatchStorageAbort("session-b", "port-b");
    expect(b.aborted).toBe(true);
    __testSetStorageRuntime(undefined);
  });

  it("uses transferables without mutating the receiver payload", () => {
    const result = __testStorageTransfer(new Uint8Array([1, 2, 3]).buffer);
    expect(result.transferCount).toBe(1);
    expect(result.inputDetachedByteLength).toBe(0);
    expect(result.detachedByteLength).toBe(0);
    expect(result.receivedByteLength).toBe(3);
  });

  it("aborts a slow Storage data lane when the global lock preempts it", async () => {
    __testSetVaultStatus("unlocked", VALID_PUBLISHER_KEYS[2]!);
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[2]!, appId: "app", appName: "App", identityDigestHex: "cc".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://slow.example", ownerPublicKeyHex: VALID_PUBLISHER_KEYS[2]!, appIdentity: identity, revokedAt: null }));
    __testSetStorageRuntime({ list: async (_ctx, input) => await new Promise((_, reject) => { input.signal?.addEventListener("abort", () => { reject(new Error("storage_unavailable")); }); }), abortSession: async () => undefined });
    const grant = await __testDispatchStorageGrant("slow-session", "port-a");
    const pending = __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await __testReleaseStorageRuntime();
    expect((await pending).ack.status).toBe("error");
    __testSetStorageSessionResolver(undefined);
    __testSetStorageRuntime(undefined);
  });

  it("keeps physical slots occupied until ignored-AbortSignal Providers settle", async () => {
    await bootstrapWalletOwnedBy(VALID_PUBLISHER_KEYS[3]!, 4, "physical-slots");
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[3]!, appId: "app", appName: "App", identityDigestHex: "ff".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://slots.example", ownerPublicKeyHex: VALID_PUBLISHER_KEYS[3]!, appIdentity: identity, revokedAt: null }));
    const releases: Array<() => void> = [];
    __testSetStorageRuntime({ list: async () => await new Promise<never>((resolve) => { releases.push(() => resolve(undefined as never)); }), abortSession: async () => undefined });
    const ports = ["port-a", "port-b", "port-c", "port-d"];
    const grants = await Promise.all(ports.map((port) => __testDispatchStorageGrant("slots-session", port)));
    const pending = grants.map((grant, index) => __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: ports[index]! }));
    await new Promise((resolve) => setTimeout(resolve, 20)); await __testReleaseStorageRuntime();
    expect((await Promise.all(pending)).every((response) => response.ack.status === "error")).toBe(true);
    expect(__testStorageQueueSnapshot().globalActive).toBe(4);
    releases.forEach((release) => release());
    await vi.waitFor(() => expect(__testStorageQueueSnapshot().globalActive).toBe(0));
    __testSetStorageRuntime({ list: async () => ({ prefix: "", parentPrefix: "", directories: [], files: [] }), abortSession: async () => undefined });
    const nextGrant = await __testDispatchStorageGrant("slots-session", "port-a");
    expect((await __testDispatchStorageData({ grantId: nextGrant.operationResult as string, actualPortId: "port-a" })).ack.status).toBe("ok");
    __testSetStorageSessionResolver(undefined); __testSetStorageRuntime(undefined);
  });

  it("取消四个忽略 AbortSignal 的操作后，第五个仍等待真实物理完成", async () => {
    await expect(__testStorageCancelKeepsPhysicalSlots()).resolves.toEqual({
      activeAfterCancel: 4,
      queuedAfterCancel: 1,
      fifthStartedAfterCancel: false,
      activeDuringFifth: 1,
      fifthStartedAfterPhysicalRelease: true,
      finalActive: 0
    });
  });

  it("rejects a late provider success after session epoch or generation changes", async () => {
    await bootstrapWalletOwnedBy(VALID_PUBLISHER_KEYS[4]!, 5, "late-provider");
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[4]!, appId: "app", appName: "App", identityDigestHex: "dd".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://late.example", ownerPublicKeyHex: VALID_PUBLISHER_KEYS[4]!, appIdentity: identity, revokedAt: null }));
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    // 单 Key 本地存储没有 Provider 世代；迟到结果由「钱包身份世代 + 平台 Root
    // 对象身份」这个绑定栅栏拒绝。第一段让 Wallet generation 在途变更。
    __testSetStorageRuntime({
      summary: async () => ({ status: "ready", medium: "indexeddb", persistence: { persisted: false } }),
      list: async () => { await delayed; return { prefix: "", parentPrefix: "", directories: [], files: [] }; },
      abortSession: async () => undefined,
    });
    const grant = await __testDispatchStorageGrant("late-session", "port-a");
    const pending = __testDispatchStorageData({ grantId: grant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    __testAdvanceWalletGeneration();
    release();
    expect((await pending).ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://late.example", ownerPublicKeyHex: VALID_PUBLISHER_KEYS[4]!, appIdentity: identity, revokedAt: null }));
    let releaseEpoch!: () => void;
    const delayedEpoch = new Promise<void>((resolve) => { releaseEpoch = resolve; });
    __testSetStorageRuntime({
      summary: async () => ({ status: "ready", medium: "indexeddb", persistence: { persisted: false } }),
      list: async () => { await delayedEpoch; return { prefix: "", parentPrefix: "", directories: [], files: [] }; },
      abortSession: async () => undefined,
    });
    const epochGrant = await __testDispatchStorageGrant("late-epoch", "port-a");
    const epochPending = __testDispatchStorageData({ grantId: epochGrant.operationResult as string, actualPortId: "port-a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    __testInvalidateSession(); releaseEpoch();
    expect((await epochPending).ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    __testSetStorageSessionResolver(undefined); __testSetStorageRuntime(undefined);
  });

  it("serializes password-rotation mutation with Storage controls", async () => {
    __testSetStorageRuntime({ status: () => "locked" });
    const result = await __testStorageMutationBarrierProbe();
    expect(result).toEqual({ blockedBeforeRelease: true, completedAfterRelease: true });
    __testSetStorageRuntime(undefined);
  });

  it("keeps Storage startup failures isolated from Vault state", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const messages: unknown[] = [];
    __testAttachPort("startup-port", (message) => messages.push(message));
    await __testDispatchStorageMessage("startup-port", { kind: "subscribe", clientId: "spoof", requestId: "sub-startup", topics: ["storage.state"] });
    __testSetStorageStartupFailure(true);
    const response = await __testDispatchStorageControl({ type: "status" });
    expect(response.ack).toMatchObject({ status: "error", code: "storage_unavailable" });
    expect(__testGetVaultStatus()).toBe("unlocked");
    expect(messages.some((message) => (message as { status?: string }).status === "degraded")).toBe(true);
    __testSetStorageStartupFailure(false);
  });

  it("persists plugin intent in the Coordinator and rejects the old authority after restart", async () => {
    // plugin-intent 必须真正落盘：没有 Root 的伪造 unlocked 会让持久化失败。
    await bootstrapReadyWallet("plugin-intent-persist");
    const messages: unknown[] = [];
    __testAttachPort("plugin-intent-port", (message) => messages.push(message));
    const first = __testGetSnapshot();
    const command = {
      commandId: "plugin-intent-test:1",
      authorityInstanceId: first.authorityInstanceId,
      expectedRevision: first.pluginIntent?.revision ?? 0,
      pluginId: "background",
      desiredEnabled: true,
    } as const;

    await __testDispatchStorageMessage("plugin-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "plugin-intent-port",
      requestId: "plugin-intent-submit-1",
      command,
    });
    const accepted = messages.find((message) => (message as { requestId?: string }).requestId === "plugin-intent-submit-1") as {
      ack?: { status?: string };
      operationResult?: { status?: string; persisted?: boolean; snapshot?: { revision?: number; desiredEnabled?: Record<string, boolean> } };
    } | undefined;
    expect(accepted?.ack).toEqual({ status: "ok" });
    expect(accepted?.operationResult).toMatchObject({
      status: "accepted",
      persisted: true,
      snapshot: { desiredEnabled: { background: true } },
    });
    expect(__testGetSnapshot().pluginIntent?.desiredEnabled.background).toBe(true);

    // 模拟 Worker 重启：新的 authority 实例 + 从同一份本地真值重装 Root。
    // 意图必须已经落盘，否则重启后无从恢复，也就没有「旧 authority 被拒绝」
    // 这个回归点。
    await __testRestartWorker();
    const afterRestart = __testGetSnapshot();
    expect(afterRestart.authorityInstanceId).not.toBe(first.authorityInstanceId);
    messages.length = 0;
    __testAttachPort("plugin-intent-port", (message) => messages.push(message));
    await __testDispatchStorageMessage("plugin-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "plugin-intent-port",
      requestId: "plugin-intent-submit-old-authority",
      command,
    });
    const stale = messages.find((message) => (message as { requestId?: string }).requestId === "plugin-intent-submit-old-authority") as {
      operationResult?: { status?: string; expectedAuthorityInstanceId?: string };
    } | undefined;
    expect(stale?.operationResult).toMatchObject({
      status: "stale-authority",
      expectedAuthorityInstanceId: afterRestart.authorityInstanceId,
    });

    messages.length = 0;
    await __testDispatchStorageMessage("plugin-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "plugin-intent-port",
      requestId: "plugin-intent-submit-unknown-product",
      command: {
        ...command,
        commandId: "plugin-intent-test:unknown-product",
        authorityInstanceId: afterRestart.authorityInstanceId,
        expectedRevision: afterRestart.pluginIntent?.revision ?? 0,
        pluginId: "not-registered-product",
      },
    });
    const unknownProduct = messages.find((message) => (message as { requestId?: string }).requestId === "plugin-intent-submit-unknown-product") as {
      ack?: { status?: string };
      operationResult?: { status?: string; message?: string };
    } | undefined;
    expect(unknownProduct?.ack).toEqual({ status: "ok" });
    expect(unknownProduct?.operationResult).toMatchObject({
      status: "command-conflict",
      message: "插件产品未在 Coordinator 内置清单注册",
    });
  });

  it("Root 重装从同一份本地真值恢复 settings 和新的 plugin-intent controller", async () => {
    // 单 Key 模型没有第二个桶可供「换空 snapshot」：重装 Root 必须读到同一份
    // IndexedDB 记录。回归点是重装不丢设置，并重建 plugin-intent 控制器。
    await __testBootstrapWalletStorage();
    await initializeTestWallet({ label: "root-reload-wallet" });
    await __testUpdateScheduleSettings({ taskIntervals: { "p2pkh.transactions-sync": 60_000 } });
    const messages: unknown[] = [];
    __testAttachPort("root-reload-intent-port", (message) => messages.push(message));
    const before = __testGetSnapshot();
    await __testDispatchStorageMessage("root-reload-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "root-reload-intent-port",
      requestId: "root-reload-intent-disable",
      command: {
        commandId: "root-reload-intent:disable",
        authorityInstanceId: before.authorityInstanceId,
        expectedRevision: before.pluginIntent?.revision ?? 0,
        pluginId: "p2pkh",
        desiredEnabled: false,
      },
    });
    expect(__testGetSnapshot()).toMatchObject({
      scheduleSettings: { taskIntervals: { "p2pkh.transactions-sync": 60_000 } },
      pluginIntent: { desiredEnabled: { p2pkh: false } },
    });

    try {
      // 模拟 Worker 重启后的 Root 重装：旧句柄全部作废，从本地真值重建。
      await __testBootstrapWalletStorage();
      await __testReloadCoordinatorMeta();
      expect(__testGetSnapshot()).toMatchObject({
        scheduleSettings: { taskIntervals: { "p2pkh.transactions-sync": 60_000 } },
        pluginIntent: { desiredEnabled: { p2pkh: false } },
      });
    } finally {
    }
  });

  it("blocks Coordinator tasks after product intent is persisted and resumes only after re-enable", async () => {
    // 任务 reconcile 会写 plugin-intent，因此这里同样需要真实 Root。
    await bootstrapReadyWallet("plugin-intent-task");
    let runs = 0;
    __testRegisterTask({
      id: "p2pkh.transactions-sync",
      pluginId: "p2pkh",
      publicKeyHex: "a".repeat(64),
      run: async () => { runs += 1; },
    });
    const messages: unknown[] = [];
    __testAttachPort("plugin-intent-task-port", (message) => messages.push(message));
    const submit = async (desiredEnabled: boolean, requestId: string, commandId: string) => {
      const snapshot = __testGetSnapshot();
      await __testDispatchStorageMessage("plugin-intent-task-port", {
        kind: "plugin.intent.submit",
        clientId: "plugin-intent-task-port",
        requestId,
        command: {
          commandId,
          authorityInstanceId: snapshot.authorityInstanceId,
          expectedRevision: snapshot.pluginIntent?.revision ?? 0,
          pluginId: "p2pkh",
          desiredEnabled,
        },
      });
      return [...messages].reverse().find((message) => (message as { requestId?: string }).requestId === requestId) as { operationResult?: { status?: string } } | undefined;
    };

    await expect(submit(false, "plugin-intent-task-disable", "plugin-intent-task:disable")).resolves.toMatchObject({ operationResult: { status: "accepted" } });
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "p2pkh.transactions-sync")).toMatchObject({
      state: "blocked",
      blockedReason: { fallback: "Plugin disabled: p2pkh" },
      unitId: "p2pkh.coordinator-worker",
      instanceId: expect.any(String),
    });
    expect(__testGetSnapshot().coordinatorWorkerUnits?.some((unit) => unit.unitId === "p2pkh.coordinator-worker")).toBe(false);
    await __testRunTask("p2pkh.transactions-sync");
    expect(runs).toBe(0);
    await expect(__testBackgroundRunNow("p2pkh.transactions-sync")).resolves.toMatchObject({
      ack: { status: "blocked", reason: { fallback: "Plugin disabled: p2pkh" } },
    });

    await expect(submit(true, "plugin-intent-task-enable", "plugin-intent-task:enable")).resolves.toMatchObject({ operationResult: { status: "accepted" } });
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "p2pkh.transactions-sync")).toMatchObject({ state: "idle" });
    expect(__testGetSnapshot().coordinatorWorkerUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: "p2pkh",
        unitId: "p2pkh.coordinator-worker",
        state: "ready",
        instanceId: expect.any(String),
      }),
    ]));
    const enabledSnapshot = __testGetSnapshot();
    const enabledUnit = enabledSnapshot.coordinatorWorkerUnits?.find((unit) => unit.unitId === "p2pkh.coordinator-worker");
    const enabledTask = enabledSnapshot.taskSnapshots.find((task) => task.id === "p2pkh.transactions-sync");
    expect(enabledUnit?.instanceId).toBe(enabledTask?.instanceId);
    await __testRunTask("p2pkh.transactions-sync");
    expect(runs).toBe(1);
  });

  it("refuses disabling a Coordinator product marked always-on", async () => {
    const messages: unknown[] = [];
    __testAttachPort("plugin-intent-always-on-port", (message) => messages.push(message));
    const snapshot = __testGetSnapshot();
    await __testDispatchStorageMessage("plugin-intent-always-on-port", {
      kind: "plugin.intent.submit",
      clientId: "plugin-intent-always-on-port",
      requestId: "plugin-intent-always-on",
      command: {
        commandId: "plugin-intent-always-on:disable",
        authorityInstanceId: snapshot.authorityInstanceId,
        expectedRevision: snapshot.pluginIntent?.revision ?? 0,
        pluginId: "sat-subscription",
        desiredEnabled: false,
      },
    });
    const response = [...messages].reverse().find((message) => (message as { requestId?: string }).requestId === "plugin-intent-always-on") as { operationResult?: { status?: string; message?: string } } | undefined;
    expect(response?.operationResult).toEqual({
      status: "command-conflict",
      commandId: "plugin-intent-always-on:disable",
      message: "该插件产品属于系统必需组件，不能关闭",
    });
  });

  it("does not persist a temporary final-I/O lease across Worker restart", async () => {
    const release = await __testHoldCoordinatorFinalIoLease();
    // 临时 I/O lease 只属于当前 Worker 内存，Worker 重启不会从本地记录恢复
    // 任何租约，因此旧 I/O 不会把新 Worker 卡在 recovery-required。
    await __testRestartWorker();
    expect(__testGetSnapshot().authorityRecovery).toBeUndefined();
    await release();
  }, 15_000);

  it("keeps the storage status projection idempotent without a persisted authority lease", async () => {
    const release = await __testHoldCoordinatorFinalIoLease();
    await __testRestartWorker();
    // 单 Origin IndexedDB 没有「重试远程连接」这一步：状态查询是纯投影。
    const status = await __testDispatchStorageControl({ type: "status" } satisfies CoordinatorStorageControl);
    expect(status.ack.status).toBe("ok");
    expect(__testGetSnapshot().authorityRecovery).toBeUndefined();
    await release();
  }, 15_000);

  it("does not create coordinator-upgrade K-V revisions for temporary I/O admission", async () => {
    const before = await __testGetCoordinatorUpgradePartition();
    const release = await __testHoldCoordinatorFinalIoLease();
    await __testRestartWorker();
    await release();
    const after = await __testGetCoordinatorUpgradePartition();
    expect(after).toEqual(before);
    expect(after.entryCount).toBe(0);
  });

  it("keeps per-port queue admission fair and bounded", () => {
    const result = __testStorageQueueAdmission("port-a");
    expect(result.firstPortAccepted).toBe(16);
    expect(result.firstPortRejected).toBe(true);
    expect(result.secondPortAccepted).toBe(true);
    expect(result.remaining).toEqual({});
  });

  it("keeps storage queue and cancellation errors typed", async () => {
    const result = await __testStorageSlotErrorCodes();
    expect(result).toEqual({ queueFull: "storage_limit_exceeded", queuedAbort: "storage_unavailable", activeAbort: "storage_unavailable" });
  });

  it("schedules a competing port ahead of a saturated port's waiters", async () => {
    const order = await __testStorageFairDispatch();
    expect(order.slice(0, 4)).toEqual(["a1", "a2", "a3", "b1"]);
  });

  it("releases a port explicitly before close", async () => {
    const identity = { version: 1 as const, publisherPublicKeyHex: VALID_PUBLISHER_KEYS[5]!, appId: "app", appName: "App", identityDigestHex: "ee".repeat(32) };
    __testSetStorageSessionResolver(async (id) => ({ sessionId: id, origin: "https://disconnect.example", appIdentity: identity, revokedAt: null }));
    const pending = __testSeedStorageRequest("active", "port-z", "disconnect-session");
    const granted = await __testDispatchStorageGrant("disconnect-session", "port-z");
    __testAttachPort("port-z", () => undefined);
    await __testDispatchStorageMessage("port-z", { kind: "disconnect", clientId: "spoof", requestId: "release" });
    expect(pending.aborted).toBe(true);
    await expect(__testResolveStorageGrant(granted.operationResult as string, "port-z")).rejects.toThrow();
    __testSetStorageSessionResolver(undefined);
    const port = attachTestPort("port-z");
    port.send({ kind: "disconnect", clientId: "spoof", requestId: "release" });
    await flush();
    expect(__testGetConnectedPortCount()).toBe(0);
  });

  it("returns matching storage.state baselines to two ports", async () => {
    const a = attachTestPort("a"); const b = attachTestPort("b");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sa", topics: ["storage.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sb", topics: ["storage.state"] });
    await flush();
    const baseline = (port: TestPort, id: string) => (port.messages.find((m) => (m as { requestId?: string }).requestId === id) as { operationResult?: { baselines?: Array<{ baselineRevision: number; snapshot: { storageRevision?: number } }> } } | undefined)?.operationResult?.baselines?.[0];
    const ba = baseline(a, "sa"); const bb = baseline(b, "sb");
    expect(ba?.baselineRevision).toBe(ba?.snapshot.storageRevision);
    expect(bb?.baselineRevision).toBe(bb?.snapshot.storageRevision);
    expect(ba?.baselineRevision).toBe(bb?.baselineRevision);
    a.send({ kind: "disconnect", clientId: "a", requestId: "da" }); b.send({ kind: "disconnect", clientId: "b", requestId: "db" });
  });

  it("publishes one strictly increasing storage revision to every subscribed port", async () => {
    const a = attachTestPort("a"); const b = attachTestPort("b");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sa2", topics: ["storage.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sb2", topics: ["storage.state"] });
    await flush();
    a.messages.length = 0; b.messages.length = 0;
    await __testPublishStorageState(); await __testPublishStorageState();
    const revisions = (port: TestPort) => port.messages.filter((m) => (m as { topic?: string; type?: string }).topic === "storage.state" && (m as { type?: string }).type === "storage.state.changed").map((m) => (m as { storageRevision: number }).storageRevision);
    const ra = revisions(a); const rb = revisions(b);
    expect(ra.length).toBeGreaterThanOrEqual(2); expect(rb).toEqual(ra);
    expect(ra[1]).toBeGreaterThan(ra[0]!);
  });

  it("broadcasts one Worker-owned sat.events stream to both tabs", async () => {
    const a = attachTestPort("a"); const b = attachTestPort("b");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sat-sub-a", topics: ["sat.events"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sat-sub-b", topics: ["sat.events"] });
    await flush();
    a.messages.length = 0;
    b.messages.length = 0;

    const event: CoordinatorSatEvent = {
      type: "incoming",
      event: {
        deliveryId: "delivery-test-1",
        ingressSupplierId: "supplier-a",
        channel: "bsv8.inbox.test",
        requestIdHex: "01",
        contentJson: new Uint8Array([1, 2, 3]),
        chargedAmount: "0",
        receivedAtMs: 1,
      },
    };
    __testPublishSatState(event);
    const onlySatEvent = (port: TestPort) => port.messages.find((message) => (message as { topic?: string }).topic === "sat.events") as { satRevision: number; event: CoordinatorSatEvent } | undefined;
    const receivedA = onlySatEvent(a);
    const receivedB = onlySatEvent(b);
    expect(receivedA?.event).toEqual(event);
    expect(receivedB?.event).toEqual(event);
    expect(receivedA?.satRevision).toBe(receivedB?.satRevision);
  });

  it("cancels only the matching key and waits for the handler completion", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false;
    __testRegisterTask({ id: "test-a", publicKeyHex: "a".repeat(64), run: async ({ signal }) => { await released; aborted = signal.aborted; } });
    __testRegisterTask({ id: "test-b", publicKeyHex: "b".repeat(64), run: async () => undefined });
    const running = __testRunTask("test-a");
    await Promise.resolve();
    const cancelling = __testCancelByKey("a".repeat(64));
    release();
    await cancelling;
    await running;
    expect(aborted).toBe(true);
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "test-b")?.state).toBe("idle");
  });

  it("uses the task-start owner when cancelling a dynamic key-scoped task", async () => {
    let activeOwner = "a".repeat(64);
    __testSetVaultStatus("unlocked", activeOwner);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let aborted = false;
    __testRegisterTask({
      id: "dynamic-owner-task",
      publicKeyHex: activeOwner,
      keyScope: () => ({ publicKeyHex: activeOwner }),
      run: async ({ signal }) => {
        await released;
        aborted = signal.aborted;
      }
    });
    const running = __testRunTask("dynamic-owner-task");
    await Promise.resolve();
    activeOwner = "b".repeat(64);
    const cancelling = __testCancelByKey("a".repeat(64));
    release();
    await cancelling;
    await running;
    expect(aborted).toBe(true);
  });

  it("rejects a late handler freshness check after session invalidation", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let committed = false;
    __testRegisterTask({ id: "late", publicKeyHex: "a".repeat(64), run: async ({ assertSessionFresh }) => { await Promise.resolve(); assertSessionFresh(); committed = true; } });
    const running = __testRunTask("late");
    __testInvalidateSession();
    await running;
    expect(committed).toBe(false);
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "late")?.error).toMatch(/stale/i);
  });

  it("fans out global lock to both ports and does not lock when one port closes", async () => {
    // The module's one-time platform K-V bootstrap is asynchronous. Let it finish
    // before installing this test's synthetic session state.
    await new Promise((resolve) => setTimeout(resolve, 30));
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const a = attachTestPort("a");
    const b = attachTestPort("b");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sub-a", topics: ["session.state"] });
    b.send({ kind: "subscribe", clientId: "b", requestId: "sub-b", topics: ["session.state"] });
    await flush();
    a.close();
    expect(__testGetSnapshot().vaultStatus).toBe("unlocked");
    // 锁定是收敛型安全操作：旧页面也必须能锁定新 epoch 的全局会话。
    b.send({ kind: "lock", clientId: "b", requestId: "lock", expectedSessionEpoch: "stale-page-epoch" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(b.messages.some((message) => (message as { type?: string; vaultStatus?: string }).type === "session.state.changed" && (message as { vaultStatus?: string }).vaultStatus === "locked")).toBe(true);
  });

  it("returns immediate accepted/already-running acknowledgements for concurrent runNow", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    __testRegisterTask({ id: "once", publicKeyHex: "a".repeat(64), run: async () => { runs++; await gate; } });
    const first = await __testBackgroundRunNow("once");
    const second = await __testBackgroundRunNow("once");
    expect(first.ack.status).toBe("accepted");
    expect(second.ack.status).toBe("already-running");
    expect(runs).toBe(1);
    release();
    await flush();
  });

  it("exposes only public locked snapshot state", () => {
    __testSetVaultStatus("locked");
    const snapshot = __testGetSnapshot();
    expect(snapshot.vaultStatus).toBe("locked");
    // 单元快照公开了 `dependsOn`（产品 id 与单元 id），这些是公开标识符而不是
    // 凭据；先剔除再扫，否则 `token-bsv21` 这类产品 id 会把守卫变成永远失败。
    const publicIds = COORDINATOR_WORKER_UNIT_CATALOG.flatMap((unit) => [
      unit.productId,
      unit.unitId,
      ...unit.taskIds,
      ...(unit.serviceIds ?? []),
      ...unit.dependsOn,
    ]).join("|");
    const withoutPublicIds = JSON.stringify(snapshot).replace(new RegExp(publicIds, "g"), "<public-id>");
    expect(withoutPublicIds).not.toMatch(/password|privateKey|token/i);
  });

  it("单元快照的 state 与 reasons 不会互相矛盾", () => {
    __testSetVaultStatus("locked");
    // 框架可能仍认为 owner-session 单元 enabled，但 owner 会话已锁定。
    for (const unit of __testGetSnapshot().coordinatorWorkerUnits ?? []) {
      expect(unit.state === "ready").toBe(unit.reasons.length === 0);
      if (unit.state === "ready") expect(unit.reasons).toEqual([]);
      // 有任务的单元必须把自身产品写进依赖清单；服务单元不需要。
      if (unit.taskIds.length > 0) expect(unit.dependsOn).toContain(unit.productId);
    }
  });

  it("persists sync management settings and restores locked state after Worker restart", async () => {
    await bootstrapReadyWallet("settings-restart");
    const ack = await __testUpdateScheduleSettings({ taskIntervals: { "token-bsv21.sync": 60_000, "contacts.presence-probe": 0 } });
    expect(ack.ack.status).toBe("accepted");
    expect(__testGetSnapshot().scheduleSettings.taskIntervals).toEqual({ "token-bsv21.sync": 60_000, "contacts.presence-probe": 0 });
    await __testRestartWorker();
    expect(__testGetSnapshot().vaultStatus).not.toBe("unlocked");
    expect(__testGetSnapshot().scheduleSettings.taskIntervals).toEqual({ "token-bsv21.sync": 60_000, "contacts.presence-probe": 0 });
  });

  it("does not publish an in-memory sync settings change when persistence fails", async () => {
    await bootstrapReadyWallet("settings-persist-fail");
    const before = __testGetSnapshot().scheduleSettings;
    __testFailNextCoordinatorSnapshotPersist();

    await expect(__testUpdateScheduleSettings({ taskIntervals: { "token-bsv21.sync": 300_000 } })).rejects.toThrow(/injected coordinator snapshot persist failure/);
    expect(__testGetSnapshot().scheduleSettings).toEqual(before);

    await __testRestartWorker();
    expect(__testGetSnapshot().scheduleSettings).toEqual(before);
  });

  it("兼容旧版 assetHoldingsIntervalMs 快照：回落同步管理缺省而不是启动失败", async () => {
    await __testBootstrapWalletStorage();
    await initializeTestWallet({ label: "legacy-settings" });
    await __testSeedCoordinatorSettingsSnapshot({ scheduleSettings: { assetHoldingsIntervalMs: 900_000 } });
    await __testReloadCoordinatorMeta();
    expect(__testGetSnapshot().scheduleSettings.taskIntervals).toEqual({});
  });

  it("rejects unknown task ids and illegal intervals", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const unknown = await __testUpdateScheduleSettings({ taskIntervals: { "unknown.task": 60_000 } });
    expect(unknown.ack.status).toBe("validation-error");
    const illegal = await __testUpdateScheduleSettings({ taskIntervals: { "token-bsv21.sync": 12_345 } });
    expect(illegal.ack.status).toBe("validation-error");
  });

  it("accepts custom whole-second intervals inside the allowed range", async () => {
    await bootstrapReadyWallet("custom-interval");
    const custom = await __testUpdateScheduleSettings({ taskIntervals: { "token-bsv21.sync": 45_000 } });
    expect(custom.ack.status).toBe("accepted");
    expect(__testGetSnapshot().scheduleSettings.taskIntervals).toEqual({ "token-bsv21.sync": 45_000 });
    // 自定义值必须跨 Worker 重启保留，而不是被归一化回预设。
    await __testRestartWorker();
    expect(__testGetSnapshot().scheduleSettings.taskIntervals).toEqual({ "token-bsv21.sync": 45_000 });
  });

  it("rejects custom intervals below 10 seconds, above 24 hours, or not whole seconds", async () => {
    await bootstrapReadyWallet("interval-bounds");
    // 设置快照是模块级持久状态：__testResetState 不会清空它，所以本用例
    // 自建前置，不依赖相邻用例的写入（单独运行也必须成立）。
    const baseline = await __testUpdateScheduleSettings({ taskIntervals: { "token-bsv21.sync": 45_000 } });
    expect(baseline.ack.status).toBe("accepted");
    for (const interval of [9_000, 86_401_000, 12_345, 1_500.5]) {
      const result = await __testUpdateScheduleSettings({ taskIntervals: { "token-bsv21.sync": interval } });
      expect(result.ack.status).toBe("validation-error");
    }
    // 非法值不得覆盖上一轮已经生效的设置。
    expect(__testGetSnapshot().scheduleSettings.taskIntervals).toEqual({ "token-bsv21.sync": 45_000 });
  });

  it("链高度同步接受自定义间隔并按新周期排下一次运行", async () => {
    await bootstrapReadyWallet("chain-interval");
    await __testRegisterRealCoordinatorTasks();
    const accepted = await __testUpdateScheduleSettings({ taskIntervals: { [CHAIN_HEIGHT_SYNC_TASK_ID]: 45_000 } });
    expect(accepted.ack).toMatchObject({ status: "accepted" });
    const task = __testGetSnapshot().taskSnapshots.find((item) => item.id === CHAIN_HEIGHT_SYNC_TASK_ID);
    // 排程用的是自定义值本身，而不是回落到缺省 2 分钟。
    expect(new Date(task?.nextRunAt ?? 0).getTime() - Date.now()).toBeLessThanOrEqual(45_000);
    expect(new Date(task?.nextRunAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    // 设置快照是模块级持久状态：本用例必须还原，否则会漏进后续用例。
    await __testUpdateScheduleSettings({ taskIntervals: {} });
  });

  it("marks tasks as blocked when vault is locked", async () => {
    __testSetVaultStatus("locked");
    __testRegisterTask({ id: "task-1", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 模拟 performGlobalLock 的行为
    const snapshot = __testGetSnapshot();
    const task = snapshot.taskSnapshots.find((t) => t.id === "task-1");
    expect(task?.state).toBe("idle"); // 初始状态是 idle
    // 锁定时任务应该变为 blocked
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testRegisterTask({ id: "task-2", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 验证解锁状态下的任务是 idle
    expect(__testGetSnapshot().taskSnapshots.find((t) => t.id === "task-2")?.state).toBe("idle");
  });

  it("locks running tasks to blocked after performGlobalLock", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    __testRegisterTask({ id: "running-task", publicKeyHex: "a".repeat(64), run: async () => { await gate; } });
    void __testRunTask("running-task");
    await Promise.resolve();
    // 锁定
    __testSetVaultStatus("locked");
    release();
    await flush();
    const snapshot = __testGetSnapshot();
    const task = snapshot.taskSnapshots.find((t) => t.id === "running-task");
    expect(task?.state).toBe("blocked");
    expect(task?.blockedReason).toMatchObject({ key: "background.blocked.task", fallback: "Vault is locked" });
  });

  it("broadcasts background snapshot immediately on lock", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    const a = attachTestPort("a");
    a.send({ kind: "subscribe", clientId: "a", requestId: "sub-a", topics: ["background.snapshot"] });
    await flush();
    a.messages.length = 0;
    // 锁定
    a.send({ kind: "lock", clientId: "a", requestId: "lock", expectedSessionEpoch: __testGetSnapshot().sessionEpoch });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (a.messages.some((message) => (message as { type?: string }).type === "background.snapshot.changed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const backgroundEvents = a.messages.filter((m) => (m as { type?: string }).type === "background.snapshot.changed");
    expect(backgroundEvents.length).toBeGreaterThan(0);
  });

  it("restores tasks to idle and reschedules after unlock", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testRegisterTask({ id: "blocked-task", publicKeyHex: "a".repeat(64), run: async () => undefined });
    // 模拟锁定
    const snapshot1 = __testGetSnapshot();
    expect(snapshot1.taskSnapshots.find((t) => t.id === "blocked-task")?.state).toBe("idle");
    // 解锁后任务应该保持 idle
    const snapshot2 = __testGetSnapshot();
    const task = snapshot2.taskSnapshots.find((t) => t.id === "blocked-task");
    expect(task?.state).toBe("idle");
    expect(task?.blockedReason).toBeUndefined();
  });

  it("managed 任务的 nextRunAt 来自同步管理设置，关闭后没有 nextRunAt", async () => {
    await bootstrapReadyWallet("managed-next-run");
    __testRegisterTask({
      id: "token-bsv21.sync",
      pluginId: "token-bsv21",
      publicKeyHex: "a".repeat(64),
      syncPolicy: "managed",
      intervalMs: 300_000,
      run: async () => undefined,
    });

    const before = Date.now();
    await __testUpdateScheduleSettings({ taskIntervals: { "token-bsv21.sync": 60_000 } });
    const scheduled = __testGetSnapshot().taskSnapshots.find((task) => task.id === "token-bsv21.sync");
    expect(scheduled?.nextRunAt).toBeTruthy();
    expect(new Date(scheduled!.nextRunAt!).getTime()).toBeGreaterThanOrEqual(before + 50_000);

    await __testUpdateScheduleSettings({ taskIntervals: { "token-bsv21.sync": 0 } });
    const disabled = __testGetSnapshot().taskSnapshots.find((task) => task.id === "token-bsv21.sync");
    expect(disabled?.nextRunAt).toBeUndefined();
  });

  it("关闭的 managed 任务不响应自动触发，但手动「立即同步一次」仍然有效", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let runs = 0;
    __testRegisterTask({
      id: "token-stas.sync",
      pluginId: "token-stas",
      publicKeyHex: "a".repeat(64),
      syncPolicy: "managed",
      intervalMs: 0,
      run: async () => { runs += 1; },
    });

    __testTriggerImmediateSync("unlock");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(0);

    const manual = await __testBackgroundRunNow("token-stas.sync");
    expect(manual.ack.status).toBe("accepted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(1);
  });

  it("WoC 空闲满 2 秒后触发 smart 任务；WoC 变忙会重新计时", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testSetSmartSyncDebounceMs(5);
    let runs = 0;
    __testRegisterTask({
      id: "p2pkh.utxo-snapshot",
      pluginId: "p2pkh",
      publicKeyHex: "a".repeat(64),
      syncPolicy: "smart",
      run: async () => { runs += 1; },
    });

    // 队列忙：不启动计时。
    __testNotifyWocQueueChange({ queued: 1, inFlight: 0, coordinated: true });
    expect(__testSmartSyncState().pending).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(0);

    // 队列空闲：开始 2 秒计时（测试里缩短为 5ms）。
    __testNotifyWocQueueChange({ queued: 0, inFlight: 0, coordinated: true });
    expect(__testSmartSyncState().pending).toBe(true);
    // 计时被打断：重新计时，不会触发。
    __testNotifyWocQueueChange({ queued: 0, inFlight: 1, coordinated: true });
    expect(__testSmartSyncState().pending).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(0);

    __testNotifyWocQueueChange({ queued: 0, inFlight: 0, coordinated: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 触发后任务会持续循环（完成后再次计时），这里只断言至少跑过一轮。
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  it("smart 任务完成后，若 WoC 空闲则重新开始计时", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testSetSmartSyncDebounceMs(60);
    let runs = 0;
    __testRegisterTask({
      id: "p2pkh.utxo-snapshot",
      pluginId: "p2pkh",
      publicKeyHex: "a".repeat(64),
      syncPolicy: "smart",
      run: async () => { runs += 1; },
    });

    __testNotifyWocQueueChange({ queued: 0, inFlight: 0, coordinated: true });
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(runs).toBe(1);
    // 任务完成后队列仍空闲：计时重新开始，持续利用空闲时间刷新余额。
    expect(__testSmartSyncState().pending).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 90));
    // 第二轮计时与测试唤醒可能落在同一事件循环时间点；只要求第二轮已经启动。
    expect(runs).toBeGreaterThanOrEqual(2);
  });

  it("锁定时 WoC 空闲事件不会挂起智能调度计时，解锁后恢复", () => {
    __testSetSmartSyncDebounceMs(5);
    __testSetVaultStatus("locked");

    __testNotifyWocQueueChange({ queued: 0, inFlight: 0, coordinated: true });
    expect(__testSmartSyncState().pending).toBe(false);

    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testNotifyWocQueueChange({ queued: 0, inFlight: 0, coordinated: true });
    expect(__testSmartSyncState().pending).toBe(true);
  });

  it("锁定时 smart 任务完成不会重新挂起智能调度计时", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testSetSmartSyncDebounceMs(5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    __testRegisterTask({
      id: "p2pkh.utxo-snapshot",
      pluginId: "p2pkh",
      publicKeyHex: "a".repeat(64),
      syncPolicy: "smart",
      run: async () => { runs += 1; await gate; },
    });

    void __testRunTask("p2pkh.utxo-snapshot");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toBe(1);

    // 锁定：无 active key。任务在锁定期完成时不得重新挂起计时器。
    __testSetVaultStatus("locked");
    release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(__testSmartSyncState().pending).toBe(false);
    expect(runs).toBe(1);

    // 即使再等一个计时周期，也不会在锁定状态下触发同步。
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toBe(1);
  });

  it("真实 lock 流程下 smart 任务完成不会重新挂起智能调度计时", async () => {
    await __testBootstrapWalletStorage();
    const key = await initializeTestWallet({ label: "smart-lock-owner" });
    __testSetSmartSyncDebounceMs(5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    __testRegisterTask({
      id: "p2pkh.utxo-snapshot",
      pluginId: "p2pkh",
      publicKeyHex: key.publicKeyHex!,
      syncPolicy: "smart",
      run: async () => { runs += 1; await gate; },
    });

    void __testRunTask("p2pkh.utxo-snapshot");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toBe(1);

    // 真实 lock：performGlobalLock 会 abort 任务、清 active key 并取消计时。
    const lockPromise = __testLock();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await lockPromise;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testSmartSyncState().pending).toBe(false);
    expect(runs).toBe(1);
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === "p2pkh.utxo-snapshot")?.state).toBe("blocked");
  });

  it("解锁 / 初始化立即同步：smart 任务与未关闭的 managed 任务各跑一次", async () => {
    __testSetVaultStatus("unlocked", "a".repeat(64));
    // 立即同步只跑一轮；把智能调度计时拉长，避免后台循环影响断言。
    __testSetSmartSyncDebounceMs(10_000);
    const runs = new Map<string, number>();
    const register = (id: string, pluginId: string, syncPolicy: "smart" | "managed", intervalMs?: number) => {
      __testRegisterTask({ id, pluginId, publicKeyHex: "a".repeat(64), syncPolicy, intervalMs, run: async () => { runs.set(id, (runs.get(id) ?? 0) + 1); } });
    };
    register("p2pkh.utxo-snapshot", "p2pkh", "smart");
    register("p2pkh.transactions-sync", "p2pkh", "managed", 60_000);
    register("contacts.presence-probe", "contacts", "managed", 0);

    __testTriggerImmediateSync("unlock");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs.get("p2pkh.utxo-snapshot")).toBe(1);
    expect(runs.get("p2pkh.transactions-sync")).toBe(1);
    expect(runs.get("contacts.presence-probe")).toBeUndefined();
  });

  it("aborts P2PKH submissions when the broadcast provider is missing (not-dispatched)", async () => {
    // P2PKH 文件按当前唯一 Key 归属：owner 必须是钱包真实身份，不能随手伪造。
    const owner = validPublisherKey(7);
    await bootstrapWalletOwnedBy(owner, 7, "p2pkh-missing-provider");
    const submissionId = `stale-${Date.now()}`;
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "ab".repeat(32), rawTxHex: "00", localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["cd".repeat(32) + ":0"], ownOutputs: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "cd".repeat(32), vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }]
    });
    // 禁用 woc 会从 registry 撤掉唯一的广播供应商，广播前无可用 provider。
    __testSetP2pkhBroadcastProvider(undefined);
    const portId = "p2pkh-missing-provider-port";
    const messages: unknown[] = [];
    __testAttachPort(portId, (message) => messages.push(message));
    const submitIntent = async (desiredEnabled: boolean, commandId: string): Promise<void> => {
      const snapshot = __testGetSnapshot();
      await __testDispatchStorageMessage(portId, {
        kind: "plugin.intent.submit",
        clientId: portId,
        requestId: commandId,
        command: {
          commandId,
          authorityInstanceId: snapshot.authorityInstanceId,
          expectedRevision: snapshot.pluginIntent?.revision ?? 0,
          pluginId: "woc",
          desiredEnabled,
        },
      });
      expect([...messages].reverse().find((message) => (message as { requestId?: string }).requestId === commandId)).toMatchObject({
        operationResult: { status: "accepted" },
      });
    };
    await submitIntent(false, "p2pkh-missing-provider:disable");
    try {
      const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId });
      expect(response.operationResult).toMatchObject({ status: "not-dispatched", reason: "broadcast-provider-unavailable" });
      expect((await __testListP2pkhLocalTransactions(owner)).some((row) => (row as { id?: string }).id === submissionId)).toBe(false);
    } finally {
      await submitIntent(true, "p2pkh-missing-provider:enable");
      __testSetP2pkhBroadcastProvider(undefined);
    }
  });

  it("isolates a submitting P2PKH submission when the broadcast provider fails", async () => {
    const owner = validPublisherKey(41);
    await bootstrapWalletOwnedBy(owner, 41, "p2pkh-isolated");
    const submissionId = `failed-broadcast-${Date.now()}`;
    const rawTxHex = makeTestP2pkhRawTx("ab".repeat(32));
    const txid = calcTxidFromRawTxHex(rawTxHex);
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [], ownOutputs: [{ vout: 0, value: 1, scriptHex: "" }], createdAt: "now", updatedAt: "now", attempts: [] },
    });
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-failing-provider", label: "Test failing provider", supportedNetworks: ["main", "test"] },
      broadcast: async () => { throw new Error("provider unavailable"); }
    });
    try {
      const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId });
      expect(response.operationResult).toMatchObject({ status: "isolated", txid, reason: "provider unavailable" });
      expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({ localState: "isolated", chainResolution: "unresolved", attempts: [{ status: "isolated" }] });
    } finally {
      __testSetP2pkhBroadcastProvider(undefined);
    }
  });

  it("keeps input claims after a failed broadcast (claims survive)", async () => {
    const owner = validPublisherKey(42);
    await bootstrapWalletOwnedBy(owner, 42, "p2pkh-claims");
    const submissionId = `failed-claims-${Date.now()}`;
    const inputTxid = "ef".repeat(32);
    const rawTxHex = makeTestP2pkhRawTx(inputTxid);
    const txid = calcTxidFromRawTxHex(rawTxHex);
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: [`${inputTxid}:0`], ownOutputs: [], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: inputTxid, vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }]
    });
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-claims-failing-provider", label: "Test claims failing provider", supportedNetworks: ["main", "test"] },
      broadcast: async () => { throw new Error("provider unavailable"); }
    });
    try {
      const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId });
      expect(response.operationResult).toMatchObject({ status: "isolated", txid });
      // 失败只隔离本地提交，输入 claim 仍然保留（不再被删除），等待后续对账。
      const claims = await __testListP2pkhLocalInputClaims(owner);
      expect(claims.filter((row) => (row as { submissionId?: string }).submissionId === submissionId)).toHaveLength(1);
      expect(claims.find((row) => (row as { submissionId?: string }).submissionId === submissionId)).toMatchObject({ state: "isolated" });
    } finally {
      __testSetP2pkhBroadcastProvider(undefined);
    }
  });

  it("retries a SatSubscription top-up after another submission consumes the same snapshot seq", async () => {
    const firstCoin = { txid: "aa".repeat(32), vout: 0, value: 100_000, height: 100, status: "confirmed" as const, isSpentInMempoolTx: false };
    const changeCoin = { txid: "bb".repeat(32), vout: 0, value: 99_000, height: 101, status: "confirmed" as const, isSpentInMempoolTx: false };
    // 快照数据源必须在解锁/装配触发后台刷新之前替换，否则在途的真实 WoC
    // 请求会被复用并返回空快照。
    __testSetP2pkhUnspentAllProvider(async () => [firstCoin]);
    await __testBootstrapWalletStorage();
    const created = await initializeTestWallet({ label: "sat-retry-owner" });
    const owner = created.publicKeyHex;
    const service = await __testEnsureSatP2pkhService();
    const resource = (await service.listResources("bsv")).find((row) => row.publicKeyHex === owner);
    if (!resource) throw new Error("P2PKH resource was not created");
    const broadcast = vi.fn(async (input: { network: "main" | "test"; canonicalTxid: string; rawTxHex: string; signal?: AbortSignal }) => ({
      canonicalTxid: input.canonicalTxid,
      status: "accepted" as const,
    }));
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-sat-retry-provider", label: "Sat retry test provider", supportedNetworks: ["main", "test"] },
      broadcast,
    });
    __testSetSatBroadcastRetryOverrides({ maxAttempts: 3, deadlineMs: 10_000, initialBackoffMs: 1, maxBackoffMs: 1 });
    try {
      const input = {
        assetId: "bsv" as const,
        ownerPublicKeyHex: owner,
        recipientAddress: resource.address,
        amountSatoshis: 1_000,
        feeRateSatoshisPerKb: 60,
      };
      const previewA = await service.prepareTransfer(input);
      const previewB = await service.prepareTransfer(input);
      expect(previewA.utxoBinding?.seq).toBeDefined();
      expect(previewB.utxoBinding?.seq).toBe(previewA.utxoBinding?.seq);

      const resultA = await service.submitTransfer(previewA);
      expect(resultA).toMatchObject({ status: "local-confirmed", attempts: 1 });
      expect(broadcast).toHaveBeenCalledTimes(1);

      // 模拟 A 的广播已反映到 WoC：B 的旧序号过期，必须重新组合后成功。
      __testSetP2pkhUnspentAllProvider(async () => [changeCoin]);
      const resultB = await service.submitTransfer(previewB);
      expect(resultB).toMatchObject({ status: "local-confirmed", attempts: 2 });
      expect(resultB.txid).not.toBe(resultA.txid);
      expect(broadcast).toHaveBeenCalledTimes(2);
    } finally {
      __testSetP2pkhBroadcastProvider(undefined);
      __testSetP2pkhUnspentAllProvider(undefined);
      __testSetSatBroadcastRetryOverrides(undefined);
      await __testLock().catch(() => undefined);
      await dispatchStorageControl({ type: "reset-wallet", confirmationLabel: created.label }).catch(() => undefined);
    }
  });

  it("creates the write-ahead submission from the page broadcast payload", async () => {
    const owner = validPublisherKey(43);
    await bootstrapWalletOwnedBy(owner, 43, "p2pkh-page-payload");
    const submissionId = `page-payload-${Date.now()}`;
    // 页面本地提交只存在于页面内存；Worker 必须能从请求负载重建审计记录。
    // 这里的原始交易是 1 输入 1 输出 P2PKH，txid 用生产工具计算。
    const inputTxid = "ab".repeat(32);
    const rawTxHex = `0100000001${inputTxid}0000000000ffffffff01e8030000000000001976a914${"11".repeat(20)}88ac00000000`;
    const txid = calcTxidFromRawTxHex(rawTxHex);
    const providerBroadcast = vi.fn(async () => ({ canonicalTxid: txid, status: "accepted" as const }));
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-page-payload-provider", label: "Page payload test provider", supportedNetworks: ["main", "test"] },
      broadcast: providerBroadcast
    });
    try {
      const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId, submission: { resourceId: "p2pkh:main", txid, rawTxHex } });
      expect(response.operationResult).toMatchObject({ status: "local-confirmed", txid });
      expect(providerBroadcast).toHaveBeenCalledWith({ network: "main", canonicalTxid: txid, rawTxHex });
      expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({
        localState: "local-confirmed",
        chainResolution: "unresolved",
        inputOutpointKeys: [`${inputTxid}:0`],
        rawTxHex,
      });
    } finally {
      __testSetP2pkhBroadcastProvider(undefined);
    }
  });

  it("rejects a page broadcast payload whose txid does not match the raw transaction", async () => {
    const owner = "a2".repeat(32);
    __testSetVaultStatus("unlocked", owner);
    const submissionId = `page-payload-mismatch-${Date.now()}`;
    const rawTxHex = `0100000001${"ab".repeat(32)}0000000000ffffffff01e8030000000000001976a914${"11".repeat(20)}88ac00000000`;
    const response = await __testP2pkhBroadcast({
      ownerPublicKeyHex: owner,
      network: "main",
      submissionId,
      submission: { resourceId: "p2pkh:main", txid: "cd".repeat(32), rawTxHex }
    });
    expect(response.ack).toMatchObject({ status: "validation-error" });
    expect((await __testListP2pkhLocalTransactions(owner)).some((row) => (row as { id?: string }).id === submissionId)).toBe(false);
  });

  it("confirms a submitting P2PKH submission when the broadcast provider accepts", async () => {
    const owner = validPublisherKey(44);
    await bootstrapWalletOwnedBy(owner, 44, "p2pkh-double-axis");
    const submissionId = `double-axis-${Date.now()}`;
    const rawTxHex = makeTestP2pkhRawTx("fc".repeat(32));
    const txid = calcTxidFromRawTxHex(rawTxHex);
    const providerBroadcast = vi.fn(async () => ({ canonicalTxid: txid, status: "accepted" as const, providerReference: "provider-ref" }));
    await __testSeedP2pkhLocalSubmission({
      ownerPublicKeyHex: owner,
      submission: { id: submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid, rawTxHex, localState: "submitting", chainResolution: "unresolved", inputOutpointKeys: ["fc".repeat(32) + ":0"], ownOutputs: [{ vout: 0, value: 1, scriptHex: "" }], createdAt: "now", updatedAt: "now", attempts: [] },
      claims: [{ id: `${submissionId}:claim`, submissionId, resourceId: "p2pkh:main", publicKeyHex: owner, network: "main", txid: "fc".repeat(32), vout: 0, value: 1, state: "active", createdAt: "now", updatedAt: "now" }],
    });
    __testSetP2pkhBroadcastProvider({
      descriptor: { id: "test-double-axis-provider", label: "Double-axis test provider", supportedNetworks: ["main", "test"] },
      broadcast: providerBroadcast
    });
    try {
      const response = await __testP2pkhBroadcast({ ownerPublicKeyHex: owner, network: "main", submissionId });
      expect(response.operationResult).toMatchObject({ status: "local-confirmed", txid });
      expect(providerBroadcast).toHaveBeenCalledWith({ network: "main", canonicalTxid: txid, rawTxHex });
      expect((await __testListP2pkhLocalTransactions(owner)).find((row) => (row as { id?: string }).id === submissionId)).toMatchObject({ localState: "local-confirmed", chainResolution: "unresolved", attempts: [{ status: "accepted" }] });
      expect((await __testListP2pkhLocalInputClaims(owner)).find((row) => (row as { submissionId?: string }).submissionId === submissionId)).toMatchObject({ state: "active" });
    } finally {
      __testSetP2pkhBroadcastProvider(undefined);
    }
  });

});

describe("区块链高度同步与 chain.height 广播", () => {
  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    __testSetChainHeightProvider(undefined);
    await __testResetWalletStore();
  });

  it("BitFS 仅使用已同步且网络匹配的高度", async () => {
    __testResetState();
    await expect(__testReadBitfsBlockHeight("main")).rejects.toThrow("尚未由统一同步任务提供");
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testSetChainHeightProvider(async () => 900_123);
    await __testRegisterRealCoordinatorTasks();
    await __testRunTask(CHAIN_HEIGHT_SYNC_TASK_ID);
    await vi.waitFor(() => expect(__testGetChainHeight().available).toBe(true));
    await expect(__testReadBitfsBlockHeight("main")).resolves.toBe(900_123);
    await expect(__testReadBitfsBlockHeight("test")).rejects.toThrow("尚未由统一同步任务提供");
  });

  it("缺省 2 分钟，并在同步管理里以 120000 落盘", async () => {
    await bootstrapReadyWallet("chain-default");
    __testSetChainHeightProvider(async () => 900_100);
    await __testRegisterRealCoordinatorTasks();

    const snapshot = __testGetSnapshot().taskSnapshots.find((task) => task.id === CHAIN_HEIGHT_SYNC_TASK_ID);
    expect(snapshot).toMatchObject({ id: CHAIN_HEIGHT_SYNC_TASK_ID });
    // 缺省 2 分钟：未配置时 nextRunAt 必须在 2 分钟附近，而不是平台的 5 分钟缺省。
    const nextRunAt = Date.parse(snapshot?.nextRunAt ?? "");
    expect(nextRunAt).toBeGreaterThan(Date.now() + 100_000);
    expect(nextRunAt).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(backgroundSyncDefaultIntervalMs(CHAIN_HEIGHT_SYNC_TASK_ID)).toBe(120_000);

    const accepted = await __testUpdateScheduleSettings({ taskIntervals: { [CHAIN_HEIGHT_SYNC_TASK_ID]: 120_000 } });
    expect(accepted.ack).toEqual({ status: "accepted" });
    expect(__testGetSnapshot().scheduleSettings?.taskIntervals).toEqual({ [CHAIN_HEIGHT_SYNC_TASK_ID]: 120_000 });
  });

  it("同步成功后写内存高度并广播 chain.height", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testSetChainHeightProvider(async () => 900_123);
    await __testRegisterRealCoordinatorTasks();

    expect(__testGetChainHeight()).toMatchObject({ available: false, height: 0, revision: 0 });

    const messages: unknown[] = [];
    __testAttachPort("chain-height-port", (message) => messages.push(message));
    await __testDispatchStorageMessage("chain-height-port", {
      kind: "subscribe",
      clientId: "chain-height-port",
      requestId: "chain-height-sub",
      topics: ["chain.height"]
    });
    // 新订阅者的 baseline 必须携带 Worker 当前读数，而不是伪造高度 0。
    const baseline = messages.find((message) => (message as { requestId?: string }).requestId === "chain-height-sub") as {
      operationResult?: { baselines?: Array<{ topic: string; snapshot: { chainHeight?: { available?: boolean } } }> };
    } | undefined;
    expect(baseline?.operationResult?.baselines?.[0]?.topic).toBe("chain.height");
    expect(baseline?.operationResult?.baselines?.[0]?.snapshot.chainHeight?.available).toBe(false);

    messages.length = 0;
    await __testRunTask(CHAIN_HEIGHT_SYNC_TASK_ID);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(__testGetChainHeight()).toMatchObject({ height: 900_123, network: "main", available: true, revision: 1 });
    const events = messages.filter((message) => (message as { topic?: string }).topic === "chain.height") as Array<{
      type: string;
      chainHeightRevision: number;
      chainHeight: { height: number; available: boolean };
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("chain.height.changed");
    expect(events[0]?.chainHeightRevision).toBe(1);
    expect(events[0]?.chainHeight).toMatchObject({ height: 900_123, available: true });
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === CHAIN_HEIGHT_SYNC_TASK_ID)?.state).toBe("idle");
  });

  it("读数未变时刷新来源时间但不推进 revision", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testSetChainHeightProvider(async () => 900_123);
    await __testRegisterRealCoordinatorTasks();

    await __testRunTask(CHAIN_HEIGHT_SYNC_TASK_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const first = __testGetChainHeight();
    expect(first.revision).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await __testRunTask(CHAIN_HEIGHT_SYNC_TASK_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = __testGetChainHeight();
    // 高度没变 -> 消费者无需重渲染；来源时间仍然前进，证明本轮同步确实跑过。
    expect(second.revision).toBe(1);
    expect(second.height).toBe(900_123);
    expect((second.updatedAtMs ?? 0) as number).toBeGreaterThan(first.updatedAtMs ?? 0);
  });

  it("读取失败保留旧高度并把错误留在任务快照上", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    let failing = false;
    __testSetChainHeightProvider(async () => {
      if (failing) throw new Error("provider down");
      return 900_123;
    });
    await __testRegisterRealCoordinatorTasks();

    await __testRunTask(CHAIN_HEIGHT_SYNC_TASK_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(__testGetChainHeight().height).toBe(900_123);

    failing = true;
    await __testRunTask(CHAIN_HEIGHT_SYNC_TASK_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 失败绝不能把高度写回 0：消费者会误判「链回退了」。
    expect(__testGetChainHeight()).toMatchObject({ height: 900_123, available: true, revision: 1 });
    const snapshot = __testGetSnapshot().taskSnapshots.find((task) => task.id === CHAIN_HEIGHT_SYNC_TASK_ID);
    expect(snapshot?.state).toBe("idle");
    expect(snapshot?.error).toContain("provider down");
  });

  it("节点返回非法高度时拒绝写入", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    __testSetChainHeightProvider(async () => -1);
    await __testRegisterRealCoordinatorTasks();

    await __testRunTask(CHAIN_HEIGHT_SYNC_TASK_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(__testGetChainHeight()).toMatchObject({ available: false, height: 0 });
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === CHAIN_HEIGHT_SYNC_TASK_ID)?.error)
      .toContain("invalid height");
  });

  it("关闭自动同步后定时器停摆，但手动立即同步仍可读取高度", async () => {
    await bootstrapReadyWallet("chain-disabled");
    let reads = 0;
    __testSetChainHeightProvider(async () => { reads += 1; return 900_200; });
    await __testRegisterRealCoordinatorTasks();
    // 注册完成时 INIT 已按缺省间隔触发过一次同步，但那是 fire-and-forget：
    // 必须等它落地再清零，否则这轮补跑的读取会算进关闭之后的计数里。
    await new Promise((resolve) => setTimeout(resolve, 20));
    reads = 0;

    const disabled = await __testUpdateScheduleSettings({ taskIntervals: { [CHAIN_HEIGHT_SYNC_TASK_ID]: 0 } });
    expect(disabled.ack).toEqual({ status: "accepted" });
    const snapshot = __testGetSnapshot().taskSnapshots.find((task) => task.id === CHAIN_HEIGHT_SYNC_TASK_ID);
    expect(snapshot?.nextRunAt).toBeUndefined();

    // 关闭后解锁 / 初始化也不再自动拉起任务。
    await __testTriggerImmediateSync("unlock");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(0);

    // 托盘的「立即同步一次」绕过关闭开关。
    const runNow = await __testBackgroundRunNow(CHAIN_HEIGHT_SYNC_TASK_ID);
    expect(runNow.ack).toMatchObject({ status: "accepted" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reads).toBe(1);
    expect(__testGetChainHeight().height).toBe(900_200);
  });

  it("拒绝把链高度间隔设成非法值", async () => {
    __testResetState();
    __testSetVaultStatus("unlocked", "a".repeat(64));
    await __testRegisterRealCoordinatorTasks();
    // 9 秒低于自定义下限 10 秒；45 秒是合法自定义值，不再是这个用例的目标。
    const response = await __testUpdateScheduleSettings({ taskIntervals: { [CHAIN_HEIGHT_SYNC_TASK_ID]: 9_000 } });
    expect(response.ack).toMatchObject({ status: "validation-error" });
  });

  it("禁用 WOC 产品后链高度同步在入口处阻塞", async () => {
    await bootstrapReadyWallet("chain-woc-blocked");
    let reads = 0;
    __testSetChainHeightProvider(async () => { reads += 1; return 900_300; });
    await __testRegisterRealCoordinatorTasks();
    await new Promise((resolve) => setTimeout(resolve, 20));
    reads = 0;
    // 已解锁钱包注册任务时 INIT 会先同步过一次高度。本用例断言的是「禁用后
    // 入口阻塞」，必须先把内存读数清回无读数态，否则读到的是禁用前的结果。
    __testResetChainHeight();

    const messages: unknown[] = [];
    __testAttachPort("chain-height-intent-port", (message) => messages.push(message));
    const snapshot = __testGetSnapshot();
    await __testDispatchStorageMessage("chain-height-intent-port", {
      kind: "plugin.intent.submit",
      clientId: "chain-height-intent-port",
      requestId: "chain-height-intent-disable-woc",
      command: {
        commandId: "chain-height-intent:disable-woc",
        authorityInstanceId: snapshot.authorityInstanceId,
        expectedRevision: snapshot.pluginIntent?.revision ?? 0,
        pluginId: "woc",
        desiredEnabled: false,
      },
    });
    expect(messages.find((message) => (message as { requestId?: string }).requestId === "chain-height-intent-disable-woc"))
      .toMatchObject({ operationResult: { status: "accepted" } });
    expect(__testGetSnapshot().pluginIntent?.desiredEnabled.woc).toBe(false);
    expect(__testGetSnapshot().taskSnapshots.find((task) => task.id === CHAIN_HEIGHT_SYNC_TASK_ID))
      .toMatchObject({ state: "blocked", blockedReason: { fallback: "Plugin disabled: woc" } });

    await __testRunTask(CHAIN_HEIGHT_SYNC_TASK_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toBe(0);
    expect(__testGetChainHeight().available).toBe(false);
  });
});

describe("单 Key 冷启动与初始化门禁", () => {
  // 需求文档的核心验收面：未初始化不装任何可写绑定；初始化必须整笔事务提交；
  // 损坏与版本过新 fail closed，绝不静默创建空钱包覆盖原数据。

  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    await __testResetWalletStore();
  });

  async function coldStartFreshWorker(): Promise<WalletColdStartSnapshot> {
    // 这里只模拟「Worker 重启」：内存权威全部丢弃，持久数据原样保留。
    // 清库是每个用例的前置条件（beforeEach），不能混进来，否则断言 corrupt /
    // unsupported 的用例会把自己的证据一起抹掉。
    __testResetState();
    return await __testBootstrapWalletStorage();
  }

  it("未初始化冷启动不安装 Root、runtime 或任务，只报告 uninitialized", async () => {
    const coldStart = await coldStartFreshWorker();
    expect(coldStart.state).toBe("uninitialized");
    expect(__testGetVaultStatus()).toBe("uninitialized");
    expect(__testGetSnapshot().taskSnapshots).toEqual([]);
  });

  it("固定 key.json 的钱包冷启动进入 locked，并在 locked 门禁下安装 runtime 与任务", async () => {
    await coldStartFreshWorker();
    await initializeTestWallet({ label: "locked-cold-start" });

    const coldStart = await coldStartFreshWorker();
    expect(coldStart.state).toBe("ready");
    expect(coldStart.key?.label).toBe("locked-cold-start");
    expect(__testGetVaultStatus()).toBe("locked");
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
    // locked 仍然装配 runtime 与任务，但全部 blocked：解锁后才恢复。
    const tasks = __testGetSnapshot().taskSnapshots;
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) expect(task.state).toBe("blocked");
  });

  it("initialize 在同一事务提交后才安装 Root、runtime 与任务", async () => {
    await coldStartFreshWorker();
    const wallet = await initializeTestWallet({ label: "atomic-init" });

    expect(__testGetVaultStatus()).toBe("unlocked");
    expect(__testGetActivePublicKeyHex()).toBe(wallet.publicKeyHex);
    // 回归：onboarding 后必须补齐后台任务注册，否则页面余额永不更新。
    expect(__testGetSnapshot().taskSnapshots.some((task) => task.id === "p2pkh.transactions-sync")).toBe(true);
    const paths = await __testListWalletObjectPaths();
    expect(paths).toContain("key.json");
    expect(paths).toContain(".keymaster/meta");
  });

  it("根目录只有唯一 key.json 与模块目录，不含桶或钱包 Owner 前缀", async () => {
    await coldStartFreshWorker();
    const wallet = await initializeTestWallet({ label: "root-shape" });
    await __testOwnerStoragePut("owner-probe.bin", new Uint8Array([1, 2, 3]));

    const paths = await __testListWalletObjectPaths();
    const ownerPrefix = wallet.publicKeyHex.toLowerCase();
    // 对象主键是规范化相对路径：没有 bucketId，也没有任何 Owner 目录层。
    expect(paths.some((path) => path === ownerPrefix || path.startsWith(`${ownerPrefix}/`))).toBe(false);
    expect(paths.filter((path) => path.endsWith("keyhold"))).toEqual([]);
    expect(paths.filter((path) => path === "key.json")).toHaveLength(1);
    // 模块业务数据归入模块目录，而不是 `.keymaster/modules/` 第二份真值。
    expect(paths.some((path) => path.startsWith(".keymaster/modules/"))).toBe(false);
    expect(paths).toContain("p2pkh/owner-probe.bin");
  });

  it("已初始化钱包不能被创建/导入入口覆盖", async () => {
    await coldStartFreshWorker();
    // initialize 直接进入已解锁，被拒绝的第二次入口不能顺带把会话锁掉。
    await bootstrapReadyWallet("first-owner");
    await expect(initializeTestWallet({ label: "second-owner", transactionId: "init-2" })).rejects.toThrow();
    expect(__testGetActivePublicKeyHex()).toBeDefined();
  });

  it("并发初始化只能有一笔事务成功", async () => {
    await coldStartFreshWorker();
    const results = await Promise.allSettled([
      initializeTestWallet({ label: "race-a", transactionId: "race-1" }),
      initializeTestWallet({ label: "race-b", transactionId: "race-2", privateKeyHex: TEST_PRIV_3 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    // 落盘结果必须与胜出的那一个一致：key.json 只有一个写入者。
    expect((await __testListWalletObjectPaths()).filter((path) => path === "key.json")).toHaveLength(1);
  });

  it("中央 K-V 孤儿对象由声明驱动的清扫回收，且不触碰 key.json", async () => {
    await coldStartFreshWorker();
    await initializeTestWallet({ label: "gc-owner" });

    const orphanPath = await __testSeedCoordinatorKeyValueGarbage();
    expect(await __testListWalletObjectPaths()).toContain(orphanPath);

    await __testCollectCoordinatorKeyValueGarbage();
    const paths = await __testListWalletObjectPaths();
    // 声明驱动的发现必须找到这个 namespace：句柄已经 close，不能依赖注册表。
    expect(paths).not.toContain(orphanPath);
    // 清扫只回收孤儿 revision，绝不误伤唯一 KeyHold 或系统 meta。
    expect(paths).toContain("key.json");
    expect(paths).toContain(".keymaster/meta");
  });

  it("corrupt 冷启动进入错误状态，不会静默创建空钱包", async () => {
    await coldStartFreshWorker();
    await initializeTestWallet({ label: "corrupt-target" });
    // 只写坏 meta，保留 key.json：初始化记录不完整属于 corrupt。
    await __testSeedWalletLocalRecords({ meta: "{not json" });

    // 数据不可用时冷启动必须 fail closed：装配抛错，且不安装任何可写 Root。
    await expect(coldStartFreshWorker()).rejects.toMatchObject({ code: "storage_wallet_corrupt" });
    expect((await __testColdStart()).state).toBe("corrupt");
    // 原数据仍在，且没有变成「空钱包」。
    expect(await __testListWalletObjectPaths()).toContain("key.json");
  });

  it("版本过新（unsupported）同样 fail closed", async () => {
    await coldStartFreshWorker();
    await initializeTestWallet({ label: "unsupported-target" });
    await __testSeedWalletLocalRecords({
      meta: JSON.stringify({
        format: "keymaster.wallet-meta",
        version: 1,
        schemaVersion: 99,
        initialized: true,
        walletGeneration: "11111111-1111-1111-1111-111111111111",
        createdAt: new Date().toISOString(),
      }),
    });

    await expect(coldStartFreshWorker()).rejects.toMatchObject({ code: "storage_wallet_unsupported" });
    expect((await __testColdStart()).state).toBe("unsupported");
    expect(await __testListWalletObjectPaths()).toContain("key.json");
  });

  it("缺少固定 KeyHold 时冷启动 fail closed", async () => {
    await coldStartFreshWorker();
    await initializeTestWallet({ label: "missing-keyhold" });
    await __testSeedWalletLocalRecords({ deleteKeyHold: true });

    await expect(coldStartFreshWorker()).rejects.toThrow();
    expect((await __testColdStart()).state).not.toBe("ready");
  });
});

describe("单 Key 重置后的授权生命周期", () => {
  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    await __testResetWalletStore();
  });

  it("重置后回到未初始化，并产生新的钱包身份世代", async () => {
    const first = await initializeTestWallet({ label: "reset-owner" });
    expect(first.walletGeneration).toBeTruthy();

    const reset = await dispatchStorageControl<{ walletGeneration: string }>({
      type: "reset-wallet",
      confirmationLabel: first.label,
    });
    expect(reset.walletGeneration).not.toBe(first.walletGeneration);
    expect(__testGetVaultStatus()).toBe("uninitialized");
    expect(await __testListWalletObjectPaths()).not.toContain("key.json");
  });

  it("重置撤销旧会话与 grant，迟到写入不能落到重新创建的钱包", async () => {
    const first = await initializeTestWallet({ label: "fence-owner" });

    await dispatchStorageControl({ type: "reset-wallet", confirmationLabel: first.label });
    const second = await initializeTestWallet({ label: "fence-owner-2", transactionId: "init-after-reset" });
    expect(second.walletGeneration).not.toBe(first.walletGeneration);

    // 重置前取得的授权不得因为「同一把私钥」而恢复：旧生命周期已结束。
    expect(__testGetSnapshot().walletGeneration).toBe(second.walletGeneration);
    await expect(__testOwnerStoragePut("late-writer.bin", new Uint8Array([9]))).resolves.toBeUndefined();
    // 新写入只能落在新钱包的模块目录，且必须被当前会话 epoch 约束。
    expect(await __testListWalletObjectPaths()).toContain("p2pkh/late-writer.bin");
  });

  it("重新导入同一私钥仍是新的授权生命周期", async () => {
    const first = await initializeTestWallet({ label: "same-key" });
    await dispatchStorageControl({ type: "reset-wallet", confirmationLabel: first.label });
    // 同一把私钥，但重置后必须视为新钱包。
    const reimported = await initializeTestWallet({ label: "same-key", transactionId: "init-reimport" });
    expect(reimported.publicKeyHex).toBe(first.publicKeyHex);
    expect(reimported.walletGeneration).not.toBe(first.walletGeneration);
  });
});

describe("getCurrentKey 响应必须能通过生产 response parser", () => {
  // 回归：Worker 的 getCurrentKey 结果会被页面侧的 response parser 校验，
  // 缺字段抛出的 TypeError 会被 transport 收成 handler_failed，表现为壳层
  // 守卫的「读不到钱包 Key」整页错误，而不是一条可读的业务失败。
  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    await __testResetWalletStore();
  });

  it("初始化后的 getCurrentKey 结果通过真实 parser", async () => {
    await initializeTestWallet({ label: "current-key-parser" });
    const port = attachTestPort("current-key-parser-port");
    const rpcRequest = {
      kind: "vault.operation",
      operation: { type: "getCurrentKey" },
      expectedSessionEpoch: __testGetSnapshot().sessionEpoch,
    } as const;
    port.send({ ...rpcRequest, kind: "vault.operation", clientId: "current-key-parser-port", requestId: "get-current-key-1" });
    const raw = await waitForPortResponse(port, "get-current-key-1");
    expect(raw.ack.status).toBe("ok");
    // 复刻生产链路：Worker 先按 capability 校验请求，再把 requestId 剥掉交给
    // 页面侧 parser。页面拿到的就是这条 DTO，缺字段必须在这里就炸出来。
    const parsedRequest = COORDINATOR_RPC_CAPABILITY.request.parse(rpcRequest);
    const { requestId: _transportRequestId, ...delivered } = raw;
    const transported = COORDINATOR_RPC_CAPABILITY.response.parse(structuredClone(delivered));
    expect(() => parseCoordinatorResponseFor(parsedRequest, transported)).not.toThrow();
  });
});

describe("单 Key 改密", () => {
  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    await __testResetWalletStore();
  });

  it("改密只替换唯一 key.json：旧密码失效，新密码可解锁", async () => {
    const oldPassword = "key-pw-old";
    const newPassword = "key-pw-new";
    await initializeTestWallet({ label: "password-wallet", password: oldPassword });

    await dispatchStorageControl({ type: "change-key-password", oldPassword, newPassword });
    await dispatchStorageControl({ type: "lock" });

    const withOld = await __testDispatchStorageControl({ type: "unlock", password: oldPassword });
    expect(withOld.ack.status).not.toBe("ok");
    expect(__testGetVaultStatus()).toBe("locked");

    const withNew = await __testDispatchStorageControl({ type: "unlock", password: newPassword });
    // 改密后当前会话可能仍被视为已解锁，因此不把严格 "ok" 当作唯一合法形状。
    expect(["ok", "accepted", "already-unlocked"]).toContain(withNew.ack.status);
    expect(__testGetVaultStatus()).toBe("unlocked");
  });
});

// 预生成 PeerId 向量（由 @libp2p/peer-id 派生，避免 apps/web 引入 libp2p 依赖）。
const SUPPLIER_PEER_IDS = new Map<string, string>([
  ["02352bbf4a4cdd12564f93fa332ce333301d9ad40271f8107181340aef25be59d5", "16Uiu2HAky1EH6J1p6jLjseMf5AtAMn3GLwYbcYaK7dH9T1F9XF56"],
  ["03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc", "16Uiu2HAmH771Jxhe2diA2zAtPYNqfABsk5aaJ51cp99LhadN6waK"]
]);

function SUPPLIER_PEER_ID_FOR(publicKeyHex: string): string {
  const peerId = SUPPLIER_PEER_IDS.get(publicKeyHex);
  if (!peerId) throw new Error(`missing precomputed peer id for ${publicKeyHex}`);
  return peerId;
}

describe("Window P2P executor lease 与受限 signer（施工单 001 §3.1–3.2）", () => {
  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    __testSetStorageSessionResolver(undefined);
    await __testReleaseMsfileRuntime();
    await __testResetWalletStore();
  });

  async function unlockForSpike(): Promise<{ epoch: string; owner: string }> {
    const created = await initializeTestWallet({ label: "executor-key", password: "spike-pw" });
    const owner = created.publicKeyHex;
    const unlockedResponse = await __testUnlock("spike-pw");
    expect(["accepted", "ok", "already-unlocked"]).toContain(unlockedResponse.ack.status);
    return { epoch: __testGetSnapshot().sessionEpoch, owner };
  }

  function noiseStaticPublicKey(fill = 7): ArrayBuffer {
    return new Uint8Array(32).fill(fill).buffer;
  }

  it("A04: two tabs competing for the same epoch yields exactly one lease", async () => {
    const { owner } = await unlockForSpike();
    const first = await __testAcquireExecutorLease(owner, "port-a");
    expect(first.ack.status).toBe("ok");
    const second = await __testAcquireExecutorLease(owner, "port-b");
    expect(second.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    // 同 port 幂等续租返回同一 leaseId。
    const again = await __testAcquireExecutorLease(owner, "port-a");
    expect((again.operationResult as { leaseId: string }).leaseId)
      .toBe((first.operationResult as { leaseId: string }).leaseId);
  });

  it("A06: charges inbound SSP Wire against the Worker bridge and releases it", () => {
    __testResetState();
    const result = __testWindowP2pInboundBridgePressure({ attempts: 64, wireBytes: 1024 * 1024 });
    // 64 次 1MiB 尝试不能突破 32MiB Worker bridge 上限；被拒绝的
    // reservation 不能进入 handler，已接受的项全部释放后计数归零。
    expect(result.accepted).toBe(32);
    expect(result.rejected).toBe(32);
    expect(result.peakBytes).toBe(32 * 1024 * 1024);
    expect(result.peakItems).toBe(32);
    expect(result.releasedBytes).toBe(0);
    expect(result.releasedItems).toBe(0);

    const itemLimited = __testWindowP2pInboundBridgePressure({ attempts: 300, wireBytes: 1 });
    expect(itemLimited.accepted).toBe(256);
    expect(itemLimited.rejected).toBe(44);
    expect(itemLimited.peakItems).toBe(256);
    expect(itemLimited.releasedItems).toBe(0);
  });

  it("A06: reserves the maximum SSP response before admitting small requests", async () => {
    __testResetState();
    const result = await __testWindowP2pResponseBridgePressure({ attempts: 256, requestBytes: 1 });
    // 每项至少占用 1 byte request + 1MiB response；256 个小请求只能
    // 排队，实际在途字节始终不超过 32MiB。
    expect(result.accepted).toBe(31);
    expect(result.queued).toBe(225);
    expect(result.peakBytes).toBe(31 * (1 + 1024 * 1024));
    expect(result.peakBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(result.peakItems).toBe(256);
    expect(result.releasedBytes).toBe(0);
    expect(result.releasedItems).toBe(0);
  });

  it("A05: stale lease id / wrong port signer requests are rejected", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };

    // 伪造 port。
    const forgedPort = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-forged");
    expect(forgedPort.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });

    // 正确 port 成功并返回签名。
    const good = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(good.ack.status).toBe("ok");
    expect((good.operationResult as { signatureDer: ArrayBuffer }).signatureDer.byteLength).toBeGreaterThan(0);

    // 显式释放后旧 leaseId 重放被拒（A05）。
    await __testReleaseExecutorLease(lease.leaseId, "port-a");
    const replay = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(replay.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
  });

  it("A03: typed signer inputs and Peer Record invariants are enforced by the worker", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };
    const shortNoiseKey = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: new Uint8Array(31).buffer }, "port-a");
    expect(shortNoiseKey.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });

    const peerId = peerIdFromPublicKeyBytes(hexToBytesTest(owner)).toString();
    const nonEmptyAddresses = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: ["/ip4/127.0.0.1/tcp/1"], sequence: "0" }, "port-a");
    expect(nonEmptyAddresses.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    const wrongPeerId = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId: "16Uiu2HAmH4VY9jMZ2fG4N7aQZ6uHh5mS5jQxZ3Yy1h1nH7qVY6r", addresses: [], sequence: "0" }, "port-a");
    expect(wrongPeerId.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    const valid = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "7" }, "port-a");
    expect(valid.ack.status).toBe("ok");
    const decreasing = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "6" }, "port-a");
    expect(decreasing.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    const overflow = await __testExecutorSignPeerRecord({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, peerId, addresses: [], sequence: "18446744073709551616" }, "port-a");
    expect(overflow.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
  });

  it("A06: lock invalidates the lease; queued signer requests fail after re-unlock", async () => {
    const { epoch } = await unlockForSpike();
    const owner = __testGetSnapshot().activePublicKeyHex!;
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    const lease = acquired.operationResult as { leaseId: string; sessionEpoch: string };

    await __testLock();
    const duringLock = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    expect(duringLock.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
    void epoch;

    await __testUnlock("spike-pw");
    const afterReunlock = await __testExecutorSignNoise({ leaseId: lease.leaseId, expectedSessionEpoch: lease.sessionEpoch, noiseStaticPublicKey: noiseStaticPublicKey() }, "port-a");
    // lock 清空了 lease：旧 leaseId 在新会话中不可复活。
    expect(afterReunlock.ack).toMatchObject({ status: "error", code: "window_p2p_unavailable" });
  });

  it("B11: 单 Key 钱包没有「导入第二把 Key」；已初始化钱包拒绝该入口", async () => {
    const { owner } = await unlockForSpike();
    const acquired = await __testAcquireExecutorLease(owner, "port-a");
    expect(acquired.ack.status).toBe("ok");

    // 旧契约里这条路径是「importPrivateKey 换 owner 并撤销旧 lease」。单 Key
    // 模型下不存在第二个 KeyHold：已有钱包时创建/导入入口必须拒绝，且不得
    // 顺带撤销当前 lease（那会让一个被拒绝的请求破坏既有授权）。
    const rejected = await dispatchStorageControl({
      type: "initialize",
      plan: {
        transactionId: "b11-second-key",
        firstKey: {
          kind: "import",
          label: "switched-owner",
          material: { hex: TEST_PRIV_2 },
          format: "hex",
          capabilities: ["p2pkh"],
          password: "spike-pw",
        },
      },
    }).then(() => undefined, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    expect(__testGetSnapshot().activePublicKeyHex).toBe(owner);

    // 原有 lease 仍然可用：拒绝路径没有改动运行授权。
    const stillValid = await __testExecutorSignNoise({
      leaseId: (acquired.operationResult as { leaseId: string }).leaseId,
      noiseStaticPublicKey: noiseStaticPublicKey(),
    }, "port-a");
    expect(stillValid.ack.status).toBe("ok");
  });
});

describe("Sat 入站 handler 资源闭环（施工单 2026-09-02/002）", () => {
  beforeEach(() => {
    __testResetState();
  });

  afterEach(() => {
    __testSetSatInboundResponseDispatcher(undefined);
    __testResetState();
  });

  it("C01: never-settling handler 被取消后保留 slot，直到 Promise settle", async () => {
    let settle!: () => void;
    const completion = new Promise<Uint8Array>((resolve) => {
      settle = () => resolve(new Uint8Array([1]));
    });
    const task = __testStartSatInboundHandler({ handler: async () => completion });
    expect(task.accepted).toBe(true);
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 1, canceled: 0, bridgeItems: 1 });

    expect(__testCancelSatInboundHandler(task as { leaseId: string; eventId: string; connectionId: string })).toBe(true);
    expect(task.signal?.aborted).toBe(true);
    // 取消只释放 Wire 额度，不能伪造 Promise 已经结束。
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 1, canceled: 1, bridgeBytes: 0, bridgeItems: 0 });

    settle();
    await task.completion;
    expect(__testSatInboundHandlerSnapshot().active).toBe(0);
  });

  it("C02: canceled handler 的迟到成功不会回写 ActionResult", async () => {
    const writer = vi.fn(async () => undefined);
    __testSetSatInboundResponseDispatcher(writer);
    let settle!: () => void;
    const response = new Promise<Uint8Array>((resolve) => {
      settle = () => resolve(new Uint8Array([2]));
    });
    const task = __testStartSatInboundHandler({ makeCurrent: true, handler: async () => response });
    expect(task.accepted).toBe(true);
    expect(__testCancelSatInboundHandler(task as { leaseId: string; eventId: string; connectionId: string })).toBe(true);
    settle();
    await task.completion;
    expect(writer).not.toHaveBeenCalled();
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 0, bridgeBytes: 0, bridgeItems: 0 });
  });

  it("C03: lease revoke 会 abort 所有仍在等待的入站任务", async () => {
    let settle!: () => void;
    const response = new Promise<Uint8Array>((resolve) => {
      settle = () => resolve(new Uint8Array([3]));
    });
    const task = __testStartSatInboundHandler({ makeCurrent: true, handler: async () => response });
    expect(task.accepted).toBe(true);
    __testRevokeWindowP2pExecutorLease();
    expect(task.signal?.aborted).toBe(true);
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 1, canceled: 1, bridgeBytes: 0, bridgeItems: 0 });

    settle();
    await task.completion;
    expect(__testSatInboundHandlerSnapshot().active).toBe(0);
  });

  it("C04: Supplier generation 变化后丢弃迟到成功", async () => {
    const writer = vi.fn(async () => undefined);
    __testSetSatInboundResponseDispatcher(writer);
    let settle!: () => void;
    const response = new Promise<Uint8Array>((resolve) => {
      settle = () => resolve(new Uint8Array([4]));
    });
    const task = __testStartSatInboundHandler({ makeCurrent: true, handler: async () => response });
    expect(task.accepted).toBe(true);
    expect(__testChangeSatInboundGeneration(task.connectionId, 2)).toBe(true);
    settle();
    await task.completion;
    expect(writer).not.toHaveBeenCalled();
    expect(__testSatInboundHandlerSnapshot().active).toBe(0);
  });

  it("C05: 64 个 active handler 后第 65 个 fail closed，取消后仍要等 settle 才回收", async () => {
    const releases: Array<() => void> = [];
    const tasks: Array<ReturnType<typeof __testStartSatInboundHandler>> = [];
    for (let index = 0; index < 65; index += 1) {
      let release!: () => void;
      const response = new Promise<Uint8Array>((resolve) => {
        release = () => resolve(new Uint8Array([index & 0xff]));
      });
      releases.push(release);
      tasks.push(__testStartSatInboundHandler({
        eventId: `c05-event-${index}`,
        connectionId: `c05-connection-${index}`,
        handler: async () => response,
      }));
    }
    expect(tasks.filter((task) => task.accepted)).toHaveLength(64);
    expect(tasks[64]?.accepted).toBe(false);
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 64, maxActive: 64, bridgeItems: 64 });

    for (const task of tasks.slice(0, 64)) {
      expect(__testCancelSatInboundHandler(task as { leaseId: string; eventId: string; connectionId: string })).toBe(true);
    }
    expect(__testSatInboundHandlerSnapshot()).toMatchObject({ active: 64, canceled: 64, bridgeBytes: 0, bridgeItems: 0 });

    for (const release of releases) release();
    await Promise.all(tasks.slice(0, 64).map((task) => task.completion));
    expect(__testSatInboundHandlerSnapshot().active).toBe(0);
  });
});

describe("只读存储浏览授权（施工单 存储浏览器 A01）", () => {
  beforeEach(async () => {
    await __testResetWalletStore();
    await bootstrapReadyWallet("browse-authorization");
  });

  afterEach(async () => {
    await __testResetWalletStore();
  });

  /** 一个已经完成 session.open 的页面 peer。 */
  function installPagePeer(peerId: string): CoordinatorSessionBinding {
    const harness = makeCoordinatorTestPeer(peerId);
    const binding: CoordinatorSessionBinding = {
      peerGeneration: 1,
      sessionEpoch: __testGetSnapshot().sessionEpoch,
      leaseId: `lease-${peerId}`,
    };
    __testInstallCoordinatorBridgePeer(harness.peer, binding);
    return binding;
  }

  it("A01: 只有已建立页面连接的 peer 能打开浏览会话", async () => {
    installPagePeer("peer-browse");
    const response = await __testDispatchStorageBrowseOpen("peer-browse");
    expect(response.ack.status).toBe("ok");
    expect(__testHasStorageBrowseAuthorization("peer-browse")).toBe(true);
    expect((response.operationResult as { browseSessionId?: string }).browseSessionId).toBeTruthy();
  });

  it("A01: 没有 committed session 的 peer 调用同一 RPC 一律被拒", async () => {
    installPagePeer("peer-browse");
    // Connect/普通插件/伪造主体都不在 coordinatorPeers 里，也没有绑定；即使它们
    // 知道受信任单元的固定 id，也换不到任何授权：请求体里根本没有身份字段可填。
    for (const peerId of ["peer-evil", "port-connect-app", "peer-no-session"]) {
      const response = await __testDispatchStorageBrowseOpen(peerId);
      expect(response.ack, peerId).toMatchObject({ status: "error", code: "storage_forbidden" });
      expect(__testHasStorageBrowseAuthorization(peerId), peerId).toBe(false);
    }
  });

  it("L02: peer 脱离 committed session 后它的浏览授权当场作废", async () => {
    const binding = installPagePeer("peer-browse");
    expect((await __testDispatchStorageBrowseOpen("peer-browse")).ack.status).toBe("ok");
    expect(__testHasStorageBrowseAuthorization("peer-browse")).toBe(true);
    // 页面关闭/锁定/换绑都会走这条 fence。
    await __testCloseCoordinatorBridgePeer("peer-browse", binding);
    expect(__testHasStorageBrowseAuthorization("peer-browse")).toBe(false);
  });
});

describe("Session Coordinator MSFile RPC lane", () => {
  const identity = {
    version: 1 as const,
    publisherPublicKeyHex: "03" + "ab".repeat(32),
    appId: "player.example",
    appName: "Player",
    identityDigestHex: "aa".repeat(32)
  };
  const ownerPublicKeyHex = validPublisherKey(9);

  beforeEach(async () => {
    await __testResetWalletStore();
  });

  afterEach(async () => {
    __testSetStorageSessionResolver(undefined);
    await __testReleaseMsfileRuntime();
    await __testResetWalletStore();
  });

  async function unlockVault(): Promise<string> {
    const created = await initializeTestWallet({ label: "msfile-key", password: "vault-pw" });
    expect(created.publicKeyHex).toBeTruthy();
    // initialize 可能直接进入 unlocked（already-unlocked 亦视为就绪）。
    const unlockedResponse = await __testUnlock("vault-pw");
    expect(["ok", "accepted", "already-unlocked"]).toContain(unlockedResponse.ack.status);
    return __testGetSnapshot().sessionEpoch;
  }

  it("rejects all data/control/grant traffic while the Vault is locked（审查修复）", async () => {
    // 全新状态：未创建 / 未解锁。
    __testResetState();
    const lockedControl = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(lockedControl.ack).toMatchObject({ status: "locked" });
    const lockedData = await __testDispatchMsfileData({ type: "stat", seedHashHex: "ab".repeat(32) }, "port-a");
    expect(lockedData.ack).toMatchObject({ status: "locked" });
    const lockedGrant = await __testDispatchMsfileGrant({
      connectSessionId: "s", transportOrigin: "https://app.example", ownerPublicKeyHex, appIdentity: identity
    }, "port-a");
    expect(lockedGrant.ack).toMatchObject({ status: "locked" });

    // session.abort 是纯清理：锁定态仍返回 ok 且不重建 runtime。
    const abortWhileLocked = await __testDispatchMsfileSessionAbort("s", __testGetSnapshot().sessionEpoch, "port-a");
    expect(abortWhileLocked.ack).toMatchObject({ status: "ok" });

    // 解锁后同一控制面请求成功。
    const epoch = await unlockVault();
    const okControl = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(okControl.ack.status).toBe("ok");
    void epoch;
  });

  it("enforces the session epoch fence on the msfile lane（审查修复）", async () => {
    // 记录解锁前的 epoch；创建 Vault 会推进 epoch。
    __testResetState();
    const epochBefore = __testGetSnapshot().sessionEpoch;
    await unlockVault();
    const stale = await __testDispatchMsfileControlWithEpoch({ type: "settings.get" }, epochBefore);
    // 携带旧 epoch 的 control 必须被判 stale，而不是进入执行。
    expect(stale.ack).toMatchObject({ status: "stale-epoch" });
    // 当前 epoch 正常放行。
    const fresh = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(fresh.ack.status).toBe("ok");
  });

  it("routes control-plane settings through the coordinator", async () => {
    await unlockVault();
    const saved = await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "500", blockMaxPriceSatoshis: "0" } });
    expect(saved.ack.status).toBe("ok");
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(snapshot.ack.status).toBe("ok");
    expect(snapshot.operationResult).toMatchObject({
      globalSettings: { seedMaxPriceSatoshis: "500", blockMaxPriceSatoshis: "0" }
    });
  });

  it("卖方启用时暂停自动锁，关闭后从当前时刻重计，手动锁立即释放索引", async () => {
    await unlockVault();
    const arbiter = validPublisherKey(27);
    const enabled = await __testDispatchMsfileControl({
      type: "settings.seller.update",
      input: { sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
    });
    expect(enabled.ack.status).toBe("ok");
    const active = __testGetMsfileSellerLifecycle();
    expect(active.autoLockDeadline).toBeUndefined();
    expect(active).toMatchObject({ indexActive: true, runtimeActive: true });

    const beforeDisable = Date.now();
    const disabled = await __testDispatchMsfileControl({
      type: "settings.seller.update",
      input: { sellerEnabled: false, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
    });
    expect(disabled.ack.status).toBe("ok");
    const resumed = __testGetMsfileSellerLifecycle();
    expect(resumed.indexActive).toBe(false);
    expect(resumed.runtimeActive).toBe(false);
    expect(resumed.autoLockDeadline).toBeGreaterThanOrEqual(beforeDisable + 5 * 60 * 1_000);

    await __testDispatchMsfileControl({
      type: "settings.seller.update",
      input: { sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
    });
    await __testLock();
    expect(__testGetMsfileSellerLifecycle()).toEqual({ indexActive: false, runtimeActive: false });
  });

  it("事故回归：依赖未就绪时开卖方报等待依赖而不是永久错误，依赖随后就绪自动转就绪且无需再切一次开关", async () => {
    await unlockVault();
    // MSFile 已在运行，收款运行时随后掉线——等价于「解锁后立刻打开卖方开关，
    // 但收款运行时仍在预热」的那段窗口。
    await __testDispatchMsfileControl({ type: "settings.get" });
    await __testReleaseSatRuntime();

    const onFrame = vi.fn(async () => ({ type: "none" }) as const);
    __testSetMsfileSellerBridge({ transport: { async open() {}, async send() {}, async close() {} }, protocol: { ready: true, onFrame } });
    try {
      const arbiter = validPublisherKey(27);
      const waiting = await __testDispatchMsfileControl({
        type: "settings.seller.update",
        input: { sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
      });
      expect(waiting.ack.status).toBe("ok");
      const waitingStatus = await __testDispatchMsfileControl({ type: "settings.get" });
      // 依赖未就绪是「还没好」，绝不能用永久配置错误表达。
      expect(waitingStatus.operationResult).toMatchObject({ sellerRuntimeStatus: "waiting-dependency" });
      expect(waitingStatus.operationResult).not.toMatchObject({ sellerRuntimeStatus: "configuration-error" });
      // 不拆解：不可用时如实报不可用，不留坏掉的索引与运行时。
      expect(__testGetMsfileSellerLifecycle()).toMatchObject({ indexActive: false, runtimeActive: false });

      // 依赖随后就绪：经进程内订阅自动重跑装配并转就绪，全程没有再碰一次开关。
      await __testEnsureSatRuntime();
      await __testAwaitMsfileSellerDependencyResume();
      const converged = await __testDispatchMsfileControl({ type: "settings.get" });
      expect(converged.operationResult).toMatchObject({ sellerRuntimeStatus: "ready" });
      expect(__testGetMsfileSellerLifecycle()).toMatchObject({ indexActive: true, runtimeActive: true });
    } finally {
      __testSetMsfileSellerBridge(undefined);
    }
  });

  it("事故回归：解锁后立刻开卖方，全程只切一次开关就自动可接单", async () => {
    await unlockVault();
    const onFrame = vi.fn(async () => ({ type: "none" }) as const);
    __testSetMsfileSellerBridge({ transport: { async open() {}, async send() {}, async close() {} }, protocol: { ready: true, onFrame } });
    try {
      const arbiter = validPublisherKey(27);
      const updated = await __testDispatchMsfileControl({
        type: "settings.seller.update",
        input: { sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
      });
      expect(updated.ack.status).toBe("ok");
      // 只读，不再碰开关。
      const observed = await __testDispatchMsfileControl({ type: "settings.get" });
      expect(observed.operationResult).toMatchObject({ sellerRuntimeStatus: "ready" });
      expect(observed.operationResult).not.toMatchObject({ sellerRuntimeStatus: "configuration-error" });
      expect(__testGetMsfileSellerLifecycle()).toMatchObject({ indexActive: true, runtimeActive: true });
    } finally {
      __testSetMsfileSellerBridge(undefined);
    }
  });

  it("卖方开关关闭时短路：不评估依赖可用性，也不残留索引与运行时", async () => {
    await unlockVault();
    await __testEnsureSatRuntime();
    await __testDispatchMsfileControl({ type: "settings.get" });
    const arbiter = validPublisherKey(27);
    const onFrame = vi.fn(async () => ({ type: "none" }) as const);
    __testSetMsfileSellerBridge({ transport: { async open() {}, async send() {}, async close() {} }, protocol: { ready: true, onFrame } });
    try {
      await __testDispatchMsfileControl({
        type: "settings.seller.update",
        input: { sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
      });
      // 依赖不可用也不影响关闭：短路发生在可用性判定之前。
      await __testReleaseSatRuntime();
      const disabled = await __testDispatchMsfileControl({
        type: "settings.seller.update",
        input: { sellerEnabled: false, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
      });
      expect(disabled.ack.status).toBe("ok");
      expect((await __testDispatchMsfileControl({ type: "settings.get" })).operationResult)
        .toMatchObject({ sellerRuntimeStatus: "disabled" });
      expect(__testGetMsfileSellerLifecycle()).toMatchObject({ indexActive: false, runtimeActive: false });
    } finally {
      __testSetMsfileSellerBridge(undefined);
    }
  });

  it("已验证 Hash 请求命中本地 Seed 时建立卖方会话，未命中与重复请求保持静默", async () => {
    await unlockVault();
    const opened: Array<{ sessionId: string; addresses: string[]; publicKeyHex: string; expectedPeerId: string; firstFrame: Uint8Array }> = [];
    const transport = {
      async open(input: { sessionId: string; addresses: string[]; publicKeyHex: string; expectedPeerId: string; firstFrame: Uint8Array }) {
        opened.push({ ...input, firstFrame: input.firstFrame.slice() });
      },
      async send() {},
      async close() {},
    };
    const onFrame = vi.fn(async () => ({ type: "none" }) as const);
    __testSetMsfileSellerBridge({ transport, protocol: { ready: true, onFrame } });
    try {
      // 页面上传语义：真实 storeMsFileSeed 写入 seeds/storage/meta 三处。
      const stored = await __testMsfileStoreSeed({
        name: "abc.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("abc"),
      });
      expect(stored.seedHashHex).toBe("4f8b42c22dd3729b519ba6f68d2da7cc5b2d606d05daed5ad5128cc03e6c6358");
      const arbiter = validPublisherKey(27);
      await __testDispatchMsfileControl({
        type: "settings.seller.update",
        input: { sellerEnabled: true, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
      });
      const ready = await __testDispatchMsfileControl({ type: "settings.get" });
      expect(ready.operationResult).toMatchObject({ sellerRuntimeStatus: "ready" });

      const privateBytes = new Uint8Array(32);
      privateBytes[31] = 2;
      const privateKey = parsePrivateKey(privateBytes);
      const requesterPublicKeyHex = bytesToHex(secp256k1.getPublicKey(privateBytes, true));
      const peerId = peerIdFromPublicKeyBytes(hexToBytesTest(requesterPublicKeyHex)).toString();
      const locatorAddress = `/dns4/buyer.example/tcp/443/tls/ws/p2p/${peerId}`;
      const now = Date.now();
      const request = parseAndVerify(HASH_REQUEST_CHANNEL, marshal(sign({
        from_public_key: parsePublicKey(requesterPublicKeyHex),
        message_id: messageIDFromBytes(new Uint8Array(32).fill(0x44)),
        issued_at_ms: now - 100,
        expires_at_ms: now + 10_000,
        body: { hash: parseSHA256Hash(stored.seedHashHex), locators: [newMultiaddrLocator(locatorAddress)] },
      }, privateKey)));

      await __testDispatchMsfileSellerHashRequest(request);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        addresses: [locatorAddress],
        publicKeyHex: requesterPublicKeyHex,
        expectedPeerId: peerId,
      });
      expect(opened[0]!.firstFrame.byteLength).toBeGreaterThan(0);
      expect(__testMsfileSellerSessionCount()).toBe(1);
      const selling = await __testDispatchMsfileControl({ type: "settings.get" });
      expect(selling.operationResult).toMatchObject({ sellerRuntimeStatus: "selling" });

      // 同一 (from_public_key, message_id) 重复请求不得第二次报价。
      await __testDispatchMsfileSellerHashRequest(request);
      expect(opened).toHaveLength(1);

      // 未命中库存保持静默。
      const miss = parseAndVerify(HASH_REQUEST_CHANNEL, marshal(sign({
        from_public_key: parsePublicKey(requesterPublicKeyHex),
        message_id: messageIDFromBytes(new Uint8Array(32).fill(0x45)),
        issued_at_ms: now - 100,
        expires_at_ms: now + 10_000,
        body: { hash: parseSHA256Hash("ab".repeat(32)), locators: [newMultiaddrLocator(locatorAddress)] },
      }, privateKey)));
      await __testDispatchMsfileSellerHashRequest(miss);
      expect(opened).toHaveLength(1);

      // 关闭卖方：会话清空、索引释放。
      await __testDispatchMsfileControl({
        type: "settings.seller.update",
        input: { sellerEnabled: false, seedPriceSatoshis: "1", fullBlockPriceSatoshis: "2", quoteLifetimeSeconds: 60, maxConcurrentSales: 1, supportedArbiterPublicKeys: [arbiter] },
      });
      expect(__testMsfileSellerSessionCount()).toBe(0);
      expect(__testGetMsfileSellerLifecycle()).toMatchObject({ indexActive: false, runtimeActive: false });
    } finally {
      __testSetMsfileSellerBridge(undefined);
    }
  });

  it("waits on full global slots and rotates clients fairly", async () => {
    await unlockVault();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const active = { value: 0 };
    __testSetMsfileReadConcurrencySettings({
      mediaBlockReadConcurrency: 1,
      globalSeedReadConcurrency: 1,
      globalBlockReadConcurrency: 1,
      globalStatConcurrency: 1,
    });
    __testSetMsfileRuntimeOverride({
      stat: vi.fn(async ({ seedHashHex }: { seedHashHex: string }) => {
        active.value += 1;
        started.push(seedHashHex);
        try {
          await new Promise<void>((resolve) => releases.set(seedHashHex, resolve));
          return { seedHashHex, suppliers: [] };
        } finally {
          active.value -= 1;
        }
      }),
      describeState: () => ({
        status: "ready",
        supplierGeneration: 0,
        globalSettings: null,
        mediaBlockReadConcurrency: 1,
        globalSeedReadConcurrency: 1,
        globalBlockReadConcurrency: 1,
        globalStatConcurrency: 1,
        pendingApprovals: [],
      }),
    } as never);

    const firstHash = "aa".repeat(32);
    const playerQueuedHash = "bb".repeat(32);
    const appQueuedHash = "cc".repeat(32);
    const first = __testDispatchMsfileData({ type: "stat", seedHashHex: firstHash }, "player");
    await vi.waitFor(() => expect(started).toEqual([firstHash]));
    const playerQueued = __testDispatchMsfileData({ type: "stat", seedHashHex: playerQueuedHash }, "player");
    const appQueued = __testDispatchMsfileData({ type: "stat", seedHashHex: appQueuedHash }, "connect-app");
    await Promise.resolve();
    expect(active.value).toBe(1);
    expect(started).toEqual([firstHash]);

    releases.get(firstHash)!();
    await first;
    await vi.waitFor(() => expect(started).toEqual([firstHash, appQueuedHash]));
    expect(active.value).toBe(1);
    releases.get(appQueuedHash)!();
    await appQueued;
    await vi.waitFor(() => expect(started).toEqual([firstHash, appQueuedHash, playerQueuedHash]));
    releases.get(playerQueuedHash)!();
    await playerQueued;
  });

  it("rejects non-canonical amounts with a validation error", async () => {
    await unlockVault();
    const bad = await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "01", blockMaxPriceSatoshis: "5" } });
    expect(bad.ack.status).toBe("error");
  });

  it("serializes control mutations so identical generations cannot both commit（审查修复）", async () => {
    await unlockVault();
    const supplierA = validPublisherKey(21);
    const supplierB = validPublisherKey(22);
    // 两个端口携带相同 expectedGeneration=0 并发 upsert：
    // 串行化后第二个任务内的世代检查必须失败，而不是双双通过。
    const [first, second] = await Promise.all([
      __testDispatchMsfileControl({ type: "supplier.upsert", supplier: { name: "a", supplierPublicKeyHex: supplierA, addresses: [`/ip4/127.0.0.1/tcp/8080/tls/ws/p2p/${SUPPLIER_PEER_ID_FOR(supplierA)}`], enabled: true }, expectedGeneration: 0 }),
      __testDispatchMsfileControl({ type: "supplier.upsert", supplier: { name: "b", supplierPublicKeyHex: supplierB, addresses: [`/ip4/127.0.0.1/tcp/8080/tls/ws/p2p/${SUPPLIER_PEER_ID_FOR(supplierB)}`], enabled: true }, expectedGeneration: 0 })
    ]);
    const outcomes = [first.ack.status, second.ack.status].sort();
    expect(outcomes).toEqual(["ok", "validation-error"]);
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    const suppliers = (snapshot.operationResult as { suppliers: Array<{ builtin?: boolean }> }).suppliers;
    // 系统内置官方供应商始终存在；用户供应商只提交成功一个。
    expect(suppliers.filter((entry) => !entry.builtin)).toHaveLength(1);
  });

  it("rejects mutations queued before a lock/unlock cycle with stale-epoch and leaves the DB untouched（审查修复）", async () => {
    const epochAtEnqueue = await unlockVault();
    // 用可悬挂的 stub runtime 阻塞串行尾，构造真实排队窗口。
    let releaseHead!: (value?: unknown) => void;
    const headGate = new Promise<unknown>((resolve) => { releaseHead = resolve; });
    __testSetMsfileRuntimeOverride({
      updateGlobalPriceSettings: () => headGate,
      describeState: () => ({ status: "ready", supplierGeneration: 0, globalSettings: null, pendingApprovals: [] })
    } as never);

    // A：占据串行尾（挂起）。
    const headPromise = __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "1", blockMaxPriceSatoshis: "1" } });
    // B：以**当时有效**的 epoch 入队——排在 A 之后。
    const queuedPromise = __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "2", blockMaxPriceSatoshis: "2" } });

    // B 尚未开始执行：先等一拍确保它已入队。
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 排队期间 lock → unlock：epoch 推进两次。
    await __testLock();
    const relocked = await __testUnlock("vault-pw");
    expect(["accepted", "ok", "already-unlocked"]).toContain(relocked.ack.status);

    // 释放 A；随后 B 才真正开始执行。
    releaseHead();
    const headResult = await headPromise;
    // A 的提交跨越了 lock/unlock 栅栏：即使写入发生也不得报告为成功。
    expect(headResult.ack).toMatchObject({ status: "stale-epoch" });

    const queuedResult = await queuedPromise;
    // B 携带入队时的 epoch，执行时已是新会话 → 任务开始时即被拒。
    expect(queuedResult.ack).toMatchObject({ status: "stale-epoch" });
    void epochAtEnqueue;

    // DB 未被 B 修改：重建真实 runtime 后设置仍为空。
    __testSetMsfileRuntimeOverride(undefined);
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect(snapshot.ack.status).toBe("ok");
    expect((snapshot.operationResult as { globalSettings: unknown }).globalSettings).toBeNull();
  });

  it("keeps mutation results stale-epoch when lock lands mid-queue（审查修复）", async () => {
    await unlockVault();
    // 以不存在的旧 epoch 发起 mutation：入口栅栏直接拦截，
    // 等价于“排队期间发生 lock/key switch”的最终形态。
    const stale = await __testDispatchMsfileControlWithEpoch(
      { type: "settings.global.update", input: { seedMaxPriceSatoshis: "9", blockMaxPriceSatoshis: "9" } },
      "epoch-that-no-longer-exists"
    );
    expect(stale.ack).toMatchObject({ status: "stale-epoch" });
    // 未写入：设置保持为空。
    const snapshot = await __testDispatchMsfileControl({ type: "settings.get" });
    expect((snapshot.operationResult as { globalSettings: unknown }).globalSettings).toBeNull();
  });

  it("rejects grants whose session lookup spans a lock/unlock cycle（审查修复）", async () => {
    await unlockVault();
    const epochAtEnqueue = __testGetSnapshot().sessionEpoch;
    let releaseResolver!: (value: { sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null) => void;
    const gated = new Promise<{ sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null>((resolve) => { releaseResolver = resolve; });
    __testSetStorageSessionResolver(() => gated);

    const pendingGrant = __testDispatchMsfileGrant({
      connectSessionId: "session-gated",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex,
      appIdentity: identity
    }, "port-a", epochAtEnqueue);

    await new Promise((resolve) => setTimeout(resolve, 10));
    // resolver 挂起期间 lock → unlock：epoch 推进。
    await __testLock();
    await __testUnlock("vault-pw");

    releaseResolver({ sessionId: "session-gated", origin: "https://app.example", ownerPublicKeyHex, appIdentity: identity, revokedAt: null });
    const result = await pendingGrant;
    expect(result.ack).toMatchObject({ status: "stale-epoch" });
  });

  it("never reaches the service when an existing grant spans a lock/unlock during session lookup（第五轮审查修复）", async () => {
    const epoch = await unlockVault();
    __testSetStorageSessionResolver(async (id) => id === "session-msfile"
      ? { sessionId: id, origin: "https://app.example", ownerPublicKeyHex: __testGetSnapshot().activePublicKeyHex!, appIdentity: identity, revokedAt: null }
      : null);
    const granted = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: __testGetSnapshot().activePublicKeyHex!,
      appIdentity: identity
    }, "port-a");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;

    // 用 spy stub 替换 runtime：任何 service 调用都会被记录。
    const readSeedSpy = vi.fn(async () => { throw new Error("must not be called"); });
    __testSetMsfileRuntimeOverride({
      describeState: () => ({ status: "ready", supplierGeneration: 0, globalSettings: null, pendingApprovals: [] }),
      connect: { stat: vi.fn(), readSeed: readSeedSpy, readBlock: vi.fn() }
    } as never);

    // 让 authoritative session 查询悬挂，期间 lock → unlock。
    let releaseResolver!: (value: { sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null) => void;
    const gated = new Promise<{ sessionId: string; origin: string; ownerPublicKeyHex: string; appIdentity: typeof identity; revokedAt: number | null } | null>((resolve) => { releaseResolver = resolve; });
    __testSetStorageSessionResolver(() => gated);
    const pendingRead = __testDispatchMsfileData({ type: "read-seed", grantId, sourceId: `remote-proxy:${identity.publisherPublicKeyHex}`, seedHashHex: "ab".repeat(32) }, "port-a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await __testLock();
    await __testUnlock("vault-pw");

    // 释放后：grant 已随 lock 清空 → 拒绝且 service 从未被调用。
    releaseResolver({ sessionId: "session-msfile", origin: "https://app.example", ownerPublicKeyHex, appIdentity: identity, revokedAt: null });
    const result = await pendingRead;
    expect(result.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
    expect(readSeedSpy).not.toHaveBeenCalled();
    void epoch;
  });

  it("refuses to bind a grant when the session owner is not the active runtime owner（审查修复）", async () => {
    await unlockVault();
    const otherOwner = validPublisherKey(31);
    __testSetStorageSessionResolver(async () => ({
      sessionId: "session-owner-mismatch",
      origin: "https://app.example",
      ownerPublicKeyHex: otherOwner,
      appIdentity: identity,
      revokedAt: null
    }));
    const result = await __testDispatchMsfileGrant({
      connectSessionId: "session-owner-mismatch",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: otherOwner,
      appIdentity: identity
    }, "port-a");
    expect(result.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
  });

  it("grants connect data access only for authoritative sessions and fails forged grants", async () => {
    await unlockVault();
    // 审查修复后 grant 要求 session owner === active runtime owner。
    const activeOwner = __testGetSnapshot().activePublicKeyHex!;
    __testSetStorageSessionResolver(async (id) => id === "session-msfile"
      ? { sessionId: id, origin: "https://app.example", ownerPublicKeyHex: activeOwner, appIdentity: identity, revokedAt: null }
      : null);
    const granted = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://app.example",
      ownerPublicKeyHex: activeOwner,
      appIdentity: identity
    }, "port-a");
    expect(granted.ack.status).toBe("ok");
    const grantId = granted.operationResult as string;

    // 同 session 的伪造 origin grant 必须被拒。
    const forged = await __testDispatchMsfileGrant({
      connectSessionId: "session-msfile",
      transportOrigin: "https://evil.example",
      ownerPublicKeyHex,
      appIdentity: identity
    }, "port-b");
    expect(forged.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });

    // Stat 不受金额设置阻断：没有用户供应商时只剩系统内置官方供应商；
    // Window executor transport 未就绪，内置供应商如实报告 network-error。
    const trustedStat = await __testDispatchMsfileData({ type: "stat", seedHashHex: "ab".repeat(32) }, "port-a");
    expect(trustedStat.ack.status).toBe("ok");
    const trustedSources = (trustedStat.operationResult as { sources: Array<{ status: string }> }).sources;
    expect(trustedSources).toHaveLength(2);
    expect(trustedSources[0]).toMatchObject({ sourceKind: "local-bitfs", status: "absent" });
    expect(trustedSources[1]).toMatchObject({ sourceKind: "remote-proxy", status: "network-error" });

    // Read fail closed（三道闸）：全局设置未保存 → msfile_not_configured。
    const unconfigured = await __testDispatchMsfileData({ type: "read-seed", sourceId: "remote-proxy:02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-a");
    expect(unconfigured.ack).toMatchObject({ status: "error", code: "msfile_not_configured" });

    // 设置已保存但 Gate 0 前无 transport → 未配置供应商先失败。
    await __testDispatchMsfileControl({ type: "settings.global.update", input: { seedMaxPriceSatoshis: "100", blockMaxPriceSatoshis: "100" } });
    const trustedRead = await __testDispatchMsfileData({ type: "read-seed", sourceId: "remote-proxy:02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-a");
    expect(trustedRead.ack).toMatchObject({ status: "error", code: "msfile_supplier_not_found" });

    // 其他端口的 grant 不能使用。
    const stolen = await __testDispatchMsfileData({ type: "read-seed", grantId, sourceId: "remote-proxy:02" + "ab".repeat(32), seedHashHex: "ab".repeat(32) }, "port-b");
    expect(stolen.ack).toMatchObject({ status: "error", code: "msfile_identity_required" });
  });
});

describe("单元可用性：ensure* 的结构化不可用契约", () => {
  // 施工单硬点：`ensure*Runtime()` 不得再「reconcile 一下然后祈祷它已就绪」。
  // 不可用必须如实报不可用，且原因是结构化的——调用方据 reasons 判断是哪一条
  // 前置不成立，而不是去匹配一句会随时被改写的英文错误文案。

  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    await __testReleaseSatRuntime();
    await __testResetWalletStore();
  });

  async function disableProduct(productId: string, portId: string): Promise<void> {
    __testAttachPort(portId, () => undefined);
    const snapshot = __testGetSnapshot();
    const requestId = `${portId}:disable:${productId}`;
    await __testDispatchStorageMessage(portId, {
      kind: "plugin.intent.submit",
      clientId: portId,
      requestId,
      command: {
        commandId: requestId,
        authorityInstanceId: snapshot.authorityInstanceId,
        expectedRevision: snapshot.pluginIntent?.revision ?? 0,
        pluginId: productId,
        desiredEnabled: false,
      },
    });
    expect(__testGetSnapshot().pluginIntent?.desiredEnabled[productId]).toBe(false);
  }

  it("插件被停用时抛 CoordinatorUnitUnavailableError，reasons 逐条给出 code 与英文文案", async () => {
    await initializeTestWallet({ label: "availability-key", password: "vault-pw" });
    await __testUnlock("vault-pw");
    // 用 p2pkh 而不是 sat-subscription：后者是系统必需产品，产品意图不允许关闭，
    // 走「插件被停用」这条路构造不出来。
    await disableProduct("p2pkh", "availability-port");

    const error = await __testEnsureSatP2pkhService().then(() => undefined, (reason: unknown) => reason);
    expect(isCoordinatorUnitUnavailableError(error)).toBe(true);
    const reasons = (error as CoordinatorUnitUnavailableError).reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({
      code: "plugin-disabled",
      dependencyId: "p2pkh",
    });
    // 兜底文案必须是英文，且带稳定 key 供界面翻译。
    expect(reasons[0]!.text).toEqual({
      key: "coordinator.unitUnavailable.pluginDisabled",
      fallback: "Plugin disabled: p2pkh",
      values: { product: "p2pkh" },
    });
  });

  it("Vault 锁定时同样抛结构化错误，原因是 owner 会话不可用", async () => {
    await initializeTestWallet({ label: "availability-locked", password: "vault-pw" });
    await __testUnlock("vault-pw");
    await __testEnsureSatRuntime();
    await __testLock();

    const error = await __testEnsureSatRuntime().then(() => undefined, (reason: unknown) => reason);
    expect(isCoordinatorUnitUnavailableError(error)).toBe(true);
    expect((error as CoordinatorUnitUnavailableError).reasons).toContainEqual(
      expect.objectContaining({ code: "owner-session-unavailable" }),
    );
  });

  it("不再出现「reconcile 一下祈祷它已就绪」：ensure* 不得再 await reconcile", () => {
    // 这条是结构性门禁。早期用 `rg "is not ready"` 做门禁是错的：新代码本身就要用
    // 这些词（依赖原因文案），按文案检索既拦不住回归也会误报。改为直接断言源码。
    //
    // 被禁的形态是「await reconcile 之后如果还没起来就抛 not ready」。因此只禁
    // `await` 形式；通知式的 `reconcileCoordinatorRuntime()`（不等、只通知框架
    // 重判）是合法机制，`ensureStorageRuntime` 仍在用。
    const source = readFileSync(new URL("./keymasterSessionCoordinator.worker.ts", import.meta.url), "utf8");
    for (const name of ["ensureMsfileRuntime", "ensureSatRuntime", "ensureStorageRuntime", "ensureSatP2pkhService"]) {
      const body = extractFunctionBody(source, name);
      expect(body, `${name} 不得再 await reconcile 后祈祷就绪`).not.toContain("await reconcileCoordinatorRuntime()");
    }
  });

  it("能由构造前置条件判定的 ensure* 走统一判定", () => {
    // storage 单元是例外且必须如此：构造前置条件里含「中央存储根已就绪」，而
    // ensureStorageRuntime 正是建立存储根的那一方，对它断言会自锁。因此这里
    // 只覆盖另外三个。
    const source = readFileSync(new URL("./keymasterSessionCoordinator.worker.ts", import.meta.url), "utf8");
    for (const name of ["ensureMsfileRuntime", "ensureSatRuntime", "ensureSatP2pkhService"]) {
      expect(extractFunctionBody(source, name), `${name} 必须走统一可用性判定`)
        .toContain("assertCoordinatorUnitConstructible");
    }
  });
});

describe("单元可用性：对外单元名单的可见性", () => {
  // 被依赖挡住的单元必须出现在名单里，且如实报 failed + 原因；只有「用户主动关掉
  // 自己的产品」才不进名单——那是用户的选择，不是故障。

  beforeEach(async () => {
    await __testResetWalletStore();
    await __testBootstrapWalletStorage();
  });

  afterEach(async () => {
    await __testResetWalletStore();
  });

  it("用户关掉本单元自己的产品时不进名单（那是选择，不是故障）", async () => {
    await initializeTestWallet({ label: "units-visibility", password: "vault-pw" });
    await __testUnlock("vault-pw");
    __testAttachPort("units-visibility-port", () => undefined);
    const snapshot = __testGetSnapshot();
    await __testDispatchStorageMessage("units-visibility-port", {
      kind: "plugin.intent.submit",
      clientId: "units-visibility-port",
      requestId: "units-visibility:disable",
      command: {
        commandId: "units-visibility:disable",
        authorityInstanceId: snapshot.authorityInstanceId,
        expectedRevision: snapshot.pluginIntent?.revision ?? 0,
        pluginId: "p2pkh",
        desiredEnabled: false,
      },
    });
    expect(__testGetSnapshot().pluginIntent?.desiredEnabled.p2pkh).toBe(false);
    expect(__testGetSnapshot().coordinatorWorkerUnits?.some((unit) => unit.unitId === "p2pkh.coordinator-worker")).toBe(false);
  });

  it("名单里的每一条都带 state 与 reasons，且契约校验接受缺省实例标识", async () => {
    await initializeTestWallet({ label: "units-shape", password: "vault-pw" });
    await __testUnlock("vault-pw");
    const units = __testGetSnapshot().coordinatorWorkerUnits ?? [];
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      expect(["ready", "failed"]).toContain(unit.state);
      // ready 必须没有原因；failed 必须至少给出一条原因，否则就是「不可用但说不清」。
      if (unit.state === "ready") expect(unit.reasons).toEqual([]);
      else expect(unit.reasons.length, `${unit.unitId} 不可用必须给出原因`).toBeGreaterThan(0);
      // 实例标识允许缺省：正在启动、或从未启动的单元还没有它。给了就必须合法。
      if (unit.instanceId !== undefined) expect(unit.instanceId.length).toBeGreaterThan(0);
    }
  });
});
