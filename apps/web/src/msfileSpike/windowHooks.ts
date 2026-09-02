// 施工单 2026-08-26/001：只在 ?msfileSpike 下加载的真实 Window executor。
// 这里运行 libp2p Host；身份与签名全部通过 TypedSigner bridge 回到 SharedWorker。

import { createHost, authenticateConnection, createIdentityAdapter } from "bitcoin-libp2p/libp2p";
import { peerIdFromPublicKeyBytes, type PeerRecordInput } from "bitcoin-libp2p/identity";
import { multiaddr } from "@multiformats/multiaddr";
import { webRTCDirect } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { getCoordinatorClient } from "../keymasterSessionCoordinatorClient.js";
import { KeymasterWindowP2pIdentitySigner } from "@keymaster/plugin-window-p2p/identity-signer";

const SPIKE_PASSWORD = "msfile-spike-test-password";

type Host = Awaited<ReturnType<typeof createHost>>;
type SpikeLease = { leaseId: string; sessionEpoch: string; activePublicKeyHex: string };
type LabStream = {
  send(data: Uint8Array): boolean;
  onDrain(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: "message" | "close", listener: (event: { data?: Uint8Array | { subarray: () => Uint8Array }; error?: Error }) => void): void;
};

export interface MsFileExecutorSpikeHooks {
  bootstrap(): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }>;
  ownerPublicKeyHex(): string | null;
  acquire(): Promise<SpikeLease | { error: string }>;
  release(leaseId: string): Promise<void>;
  signNoiseStaticKey(staticKey: Uint8Array): Promise<{ signatureByteLength: number }>;
  signPeerRecord(sequence?: string): Promise<{ signatureByteLength: number }>;
  rejectForgedPeerRecords(): Promise<{ wrongPeerId: string; nonEmptyAddresses: string; overflowSequence: string }>;
  abortNoiseSign(): Promise<{ error: string; pendingAfter: number }>;
  beginNoiseSign(): { pendingAfterStart: number };
  finishNoiseSign(): Promise<{ signResult: string; pendingAfter: number }>;
  lock(): Promise<{ status: string }>;
  generateReplacementKey(): Promise<{ publicKeyHex: string }>;
  setActive(publicKeyHex: string): Promise<{ status: string }>;
  connectAndInspect(address: string): Promise<{
    hostStarted: boolean;
    localPublicKeyHex: string;
    localPeerId: string;
    remotePeerId: string;
    remotePublicKeyHex: string;
    identity: Record<string, unknown>;
    echo: string;
    identifyPush: string;
    rawPrivateKeyError: string;
    rawAccessAttempts: number;
    noiseSignCount: number;
    peerRecordSignCount: number;
  }>;
  transferBurst(seedBytes: number, blockBytes: number, blocks: number): Promise<{
    peakPendingByteLength: number;
    heapBaselineBytes: number | null;
    peakHeapBytes: number | null;
    drained: number;
    detachedOriginals: boolean;
  }>;
}

declare global {
  interface Window {
    __windowP2pExecutorSpike?: MsFileExecutorSpikeHooks;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readStream(stream: AsyncIterable<unknown>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    let bytes: Uint8Array;
    if (chunk instanceof Uint8Array) {
      bytes = chunk;
    } else if (typeof chunk === "object" && chunk !== null && "subarray" in chunk && typeof (chunk as { subarray?: unknown }).subarray === "function") {
      bytes = (chunk as { subarray: () => Uint8Array }).subarray();
    } else {
      throw new Error("libp2p stream returned an unsupported chunk");
    }
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function sendAndRead(stream: { send(data: Uint8Array): boolean; onDrain(): Promise<void>; close(): Promise<void> } & AsyncIterable<unknown>, payload: Uint8Array): Promise<Uint8Array> {
  if (!stream.send(payload)) await stream.onDrain();
  await stream.close();
  return readStream(stream);
}

async function sendAndReadLine(stream: LabStream, payload: Uint8Array): Promise<Uint8Array> {
  const received = new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const onMessage = (event: { data?: Uint8Array | { subarray: () => Uint8Array } }): void => {
      if (event.data == null) return;
      const bytes = event.data instanceof Uint8Array ? event.data : event.data.subarray();
      chunks.push(bytes);
      total += bytes.byteLength;
      const output = new Uint8Array(total);
      let offset = 0;
      for (const part of chunks) {
        output.set(part, offset);
        offset += part.byteLength;
      }
      const newline = output.indexOf(10);
      if (newline >= 0) resolve(output.subarray(0, newline));
    };
    const onClose = (event: { error?: Error }): void => reject(new Error(`${event.error ? errorDetails(event.error) : "stream closed"}; received=${total} bytes`));
    stream.addEventListener("message", onMessage);
    stream.addEventListener("close", onClose);
  });
  if (!stream.send(payload)) await stream.onDrain();
  // Go 的 identity handler 不读取请求体，只在自己的写端发送一行并
  // CloseWrite；此处不能先关闭浏览器端整个写流程，否则 Yamux 会把
  // half-close 的完成等待误报为超时，丢掉仍在途中的响应。
  return received;
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function errorDetails(error: unknown): string {
  if (error instanceof AggregateError) {
    return Array.from(error.errors, errorDetails).join(" | ");
  }
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
    return `${error.name}${code}: ${error.message}`;
  }
  return String(error);
}

async function withStage<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${stage} failed: ${errorDetails(error)}`);
  }
}

function echoFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(8 + payload.byteLength);
  new DataView(frame.buffer).setBigUint64(0, BigInt(payload.byteLength), false);
  frame.set(payload, 8);
  return frame;
}

function parseEchoFrame(frame: Uint8Array): string {
  if (frame.byteLength < 8) throw new Error("Go echo response is shorter than its length prefix");
  const length = Number(new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getBigUint64(0, false));
  if (length !== frame.byteLength - 8) throw new Error("Go echo response length mismatch");
  return text(frame.subarray(8));
}

async function ensureUnlocked(coordinator: ReturnType<typeof getCoordinatorClient>): Promise<{ ownerPublicKeyHex: string; sessionEpoch: string }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = coordinator.getBootstrapSnapshot();
    if (snapshot.vaultStatus !== "booting") {
      if (snapshot.vaultStatus === "unlocked" && snapshot.activePublicKeyHex) {
        return { ownerPublicKeyHex: snapshot.activePublicKeyHex, sessionEpoch: snapshot.sessionEpoch };
      }
      if (snapshot.vaultStatus === "uninitialized") {
        const created = await coordinator.vaultOperation({ type: "createVaultWithInitialKey", password: SPIKE_PASSWORD, label: "MSFile executor spike" });
        if (created.status === "ok") {
          const value = created.value as { publicKeyHex?: string };
          if (value.publicKeyHex) return { ownerPublicKeyHex: value.publicKeyHex, sessionEpoch: created.sessionEpoch };
        } else {
          // 两个真实页面可以同时完成 bootstrap；第二个页面重读状态即可。
          await delay(10);
          continue;
        }
      } else if (snapshot.vaultStatus === "locked") {
        const unlocked = await coordinator.unlock(SPIKE_PASSWORD);
        if (unlocked.status !== "accepted" && unlocked.status !== "already-unlocked" && unlocked.status !== "ok") {
          throw new Error(`spike Vault unlock failed: ${unlocked.status}`);
        }
      }
    }
    await delay(10);
  }
  throw new Error("spike Vault did not become unlocked");
}

export function installMsFileSpikeHooks(): void {
  const coordinator = getCoordinatorClient();
  let signer: KeymasterWindowP2pIdentitySigner | undefined;
  let host: Host | undefined;
  let lease: SpikeLease | undefined;
  let pendingLifecycleNoiseSign: Promise<string> | undefined;

  const stopHost = async (): Promise<void> => {
    signer?.close();
    signer = undefined;
    if (host) {
      const current = host;
      host = undefined;
      await Promise.resolve(current.stop()).catch(() => undefined);
    }
  };

  const hooks: MsFileExecutorSpikeHooks = {
    async bootstrap() {
      return ensureUnlocked(coordinator);
    },
    ownerPublicKeyHex() {
      return coordinator.getBootstrapSnapshot().activePublicKeyHex ?? null;
    },
    async acquire() {
      try {
        const ready = await ensureUnlocked(coordinator);
        const owner = ready.ownerPublicKeyHex;
        const result = await coordinator.windowP2pExecutorAcquire(owner);
        if (result.status !== "ok") return { error: `${result.status}${"message" in result ? `: ${result.message}` : ""}` };
        lease = result.value;
        signer = new KeymasterWindowP2pIdentitySigner({ ...result.value, rpc: coordinator });
        return result.value;
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    async release(leaseId) {
      if (lease?.leaseId === leaseId) {
        await stopHost();
        lease = undefined;
      }
      await coordinator.windowP2pExecutorRelease(leaseId);
    },
    async signNoiseStaticKey(staticKey) {
      if (!signer) throw new Error("executor lease is not acquired");
      const signature = await signer.signNoiseStaticKey(staticKey);
      return { signatureByteLength: signature.byteLength };
    },
    async signPeerRecord(sequence = "0") {
      if (!signer) throw new Error("executor lease is not acquired");
      const record: PeerRecordInput = { peerId: signer.peerId, addresses: [], sequence: BigInt(sequence) };
      const signature = await signer.signPeerRecord(record);
      return { signatureByteLength: signature.byteLength };
    },
    async rejectForgedPeerRecords() {
      if (!signer) throw new Error("executor lease is not acquired");
      const capture = async (operation: () => Promise<Uint8Array>): Promise<string> => {
        try { await operation(); return "accepted"; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      };
      const generatorHex = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
      const generatorBytes = Uint8Array.from(generatorHex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
      const wrongPeerId = peerIdFromPublicKeyBytes(generatorBytes);
      return {
        wrongPeerId: await capture(() => signer!.signPeerRecord({ peerId: wrongPeerId, addresses: [], sequence: 0n })),
        nonEmptyAddresses: await capture(() => signer!.signPeerRecord({ peerId: signer!.peerId, addresses: [multiaddr("/ip4/127.0.0.1/tcp/1")], sequence: 0n })),
        overflowSequence: await capture(() => signer!.signPeerRecord({ peerId: signer!.peerId, addresses: [], sequence: 1n << 64n }))
      };
    },
    async abortNoiseSign() {
      if (!signer) throw new Error("executor lease is not acquired");
      const controller = new AbortController();
      const pending = signer.signNoiseStaticKey(new Uint8Array(32).fill(7), controller.signal);
      controller.abort(new DOMException("spike abort", "AbortError"));
      try {
        await pending;
        throw new Error("Noise sign unexpectedly completed after abort");
      } catch (error) {
        await delay(20);
        return { error: error instanceof Error ? error.message : String(error), pendingAfter: signer.pendingRequestCount };
      }
    },
    beginNoiseSign() {
      if (!signer) throw new Error("executor lease is not acquired");
      const currentSigner = signer;
      if (pendingLifecycleNoiseSign) throw new Error("lifecycle Noise sign is already pending");
      pendingLifecycleNoiseSign = currentSigner.signNoiseStaticKey(new Uint8Array(32).fill(8))
        .then(() => "ok", (error: unknown) => error instanceof Error ? error.message : String(error));
      return { pendingAfterStart: currentSigner.pendingRequestCount };
    },
    async finishNoiseSign() {
      if (!signer || !pendingLifecycleNoiseSign) throw new Error("lifecycle Noise sign is not pending");
      const currentSigner = signer;
      const pending = pendingLifecycleNoiseSign;
      pendingLifecycleNoiseSign = undefined;
      return { signResult: await pending, pendingAfter: currentSigner.pendingRequestCount };
    },
    async lock() {
      const result = await coordinator.lock();
      return { status: result.status };
    },
    async generateReplacementKey() {
      const result = await coordinator.vaultOperation({ type: "generateKey", password: SPIKE_PASSWORD, label: "MSFile executor replacement", capabilities: ["p2pkh"] });
      if (result.status !== "ok") throw new Error(`replacement key generation failed: ${result.status}`);
      const value = result.value as { publicKeyHex?: string };
      if (!value.publicKeyHex) throw new Error("replacement key generation returned no public key");
      return { publicKeyHex: value.publicKeyHex };
    },
    async setActive(publicKeyHex) {
      const result = await coordinator.vaultOperation({ type: "setActive", publicKeyHex });
      return { status: result.status };
    },
    async connectAndInspect(address) {
      if (!signer || !lease) throw new Error("executor lease is not acquired");
      if (!host) {
        try {
          host = await createHost({
            signer,
            transports: [webRTCDirect(), webSockets()],
            listenAddrs: [],
            // Chromium/Go supplier 在同机 loopback 上验证 WebRTC Direct；生产
            // executor 不把这个实验性本地例外带入正式拨号策略。
            connectionGater: { denyDialMultiaddr: async () => false },
            start: true
          });
        } catch (error) {
          throw new Error(`Window libp2p Host start failed: ${errorDetails(error)}`);
        }
      }
      const rawAdapter = createIdentityAdapter(signer);
      let rawPrivateKeyError = "";
      let rawAccessAttempts = 0;
      try {
        rawAccessAttempts += 1;
        void rawAdapter.raw;
      } catch (error) {
        rawPrivateKeyError = error instanceof Error ? error.message : String(error);
      } finally {
        rawAdapter.close();
      }

      let connection: Awaited<ReturnType<Host["dial"]>>;
      try {
        connection = await host.dial(multiaddr(address));
      } catch (error) {
        throw new Error(`Go supplier dial failed: ${errorDetails(error)}`);
      }
      const authenticated = authenticateConnection(connection);
      const identityStream = await withStage("Go identity stream open", () => connection.newStream("/msfile-lab/identity/1.0.0"));
      const identity = await withStage("Go identity exchange", async () => JSON.parse(text(await sendAndReadLine(identityStream, new Uint8Array(0)))) as Record<string, unknown>);
      const echoPayload = new TextEncoder().encode("msfile-window-executor-spike");
      const echo = await withStage("Go echo stream", async () => {
        const echoStream = await connection.newStream("/msfile-lab/echo/1.0.0");
        return parseEchoFrame(await sendAndRead(echoStream, echoFrame(echoPayload)));
      });

      let identifyPush = "unavailable";
      const services = (host as unknown as { services?: { identifyPush?: { push(): Promise<void> } } }).services;
      if (services?.identifyPush?.push) {
        await withStage("Identify Push", services.identifyPush.push.bind(services.identifyPush));
        identifyPush = "ok";
      }

      // 直接调用两个 typed signer 方法验证 Worker RPC 与标准 DER 输出；Host
      // 的 Noise/Identify 路径已经通过上面的真实连接使用同一 signer。
      await withStage("Peer Record sign sequence 0", () => signer!.signPeerRecord({ peerId: signer!.peerId, addresses: [], sequence: 0n }));
      await withStage("Peer Record sign sequence 1", () => signer!.signPeerRecord({ peerId: signer!.peerId, addresses: [], sequence: 1n }));
      return {
        hostStarted: true,
        localPublicKeyHex: hex(signer.publicKey()),
        localPeerId: signer.peerId.toString(),
        remotePeerId: authenticated.peerId.toString(),
        remotePublicKeyHex: hex(authenticated.publicKey),
        identity,
        echo,
        identifyPush,
        rawPrivateKeyError,
        rawAccessAttempts,
        noiseSignCount: signer.noiseSignCount,
        peerRecordSignCount: signer.peerRecordSignCount
      };
    },
    async transferBurst(seedBytes, blockBytes, blocks) {
      if (!lease) throw new Error("executor lease is not acquired");
      const originals: ArrayBuffer[] = [];
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      const heapBaselineBytes = memory?.usedJSHeapSize ?? null;
      let peakHeapBytes = heapBaselineBytes;
      const sampleHeap = (): void => {
        if (!memory) return;
        peakHeapBytes = Math.max(peakHeapBytes ?? 0, memory.usedJSHeapSize);
      };
      const seed = new ArrayBuffer(seedBytes);
      originals.push(seed);
      const pending = [coordinator.windowP2pExecutorSpikeTransfer(lease.leaseId, lease.sessionEpoch, seed)];
      sampleHeap();
      for (let index = 0; index < blocks; index += 1) {
        const block = new ArrayBuffer(blockBytes);
        originals.push(block);
        pending.push(coordinator.windowP2pExecutorSpikeTransfer(lease.leaseId, lease.sessionEpoch, block));
        sampleHeap();
      }
      const detachedOriginals = originals.every((buffer) => buffer.byteLength === 0);
      const results = await Promise.all(pending);
      const failures = results.filter((result) => result.status !== "ok");
      if (failures.length > 0) throw new Error(`executor transfer failed: ${failures.map((result) => result.status).join(", ")}`);
      const values = results.map((result) => {
        if (result.status !== "ok") throw new Error("executor transfer result is unavailable");
        return result.value;
      });
      sampleHeap();
      return {
        peakPendingByteLength: Math.max(...values.map((value) => value.peakPendingBytes)),
        heapBaselineBytes,
        peakHeapBytes,
        drained: values.length,
        detachedOriginals
      };
    }
  };
  window.__windowP2pExecutorSpike = hooks;
  window.addEventListener("pagehide", () => {
    void stopHost();
    coordinator.disconnect();
  }, { once: true });
}
