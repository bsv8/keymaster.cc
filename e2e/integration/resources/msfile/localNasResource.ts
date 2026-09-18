// 真实 Go msfile-nas 的本地 e2e 资源。
//
// 它从仓库外 MSFile-Proxy-Protocol 源码构建正式 `cmd/msfile-nas`，用临时
// `nas_data`/`seed_data` 和确定性测试身份启动 WebRTC Direct + WSS listener，
// 并把夹具文件的 Seed Hash、MIME、长度和 SHA-256 交给浏览器 Journey。
// 这里不做任何协议替身：Noise、Stat/Read、Seed 计划、身份 pin 和访问策略
// 全部来自正式 NAS 与 Keymaster 生产实现。
//
// 资源边界与安全：
//   - 仓库目录必须由 MSFILE_PROXY_PROTOCOL_DIR 显式提供，不写死开发机路径；
//   - 全部数据位于一次性临时目录，结束或失败都尽力回收进程、TLS 证书和目录；
//   - 供应商身份私钥只写临时文件，不进入日志、附件或测试状态。

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { promises as fs } from "node:fs";
import { get as httpsGet } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { bytesToHex, peerIdFromPublicKeyBytes, publicKeyFromPrivateKey } from "bitcoin-libp2p/identity";
import { getMsFileGoDir } from "../../fixtures/msfileProxyProtocol.js";

const execFileAsync = promisify(execFile);

/** 受保护管理 API 的临时 token；只用于读取状态和 Read 计数。 */
const ADMIN_TOKEN = "msfile-e2e-admin-token";
/** NAS 首次扫描并完成 Seal/Seed 发布的上限。 */
const NAS_READY_TIMEOUT_MS = 90_000;
/** 确定性测试身份（私钥 1）；供应商公钥/PeerId 必须与 JS 派生一致。 */
const E2E_IDENTITY_PRIVATE_KEY_HEX = "0".repeat(63) + "1";

export interface MsFileNasFixtureFile {
  /** 写入 NAS `nas_data` 的文件名，也是推荐文件名真值。 */
  readonly filename: string;
  /** 夹具声明的 MIME；实际媒体类型仍以 NAS 索引结果为准。 */
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface MsFileNasIndexedFile {
  readonly filename: string;
  readonly seedHashHex: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  /** NAS 磁盘源文件的 SHA-256；浏览器下载结果必须与它一致。 */
  readonly sha256Hex: string;
}

export interface MsFileNasReadMetrics {
  readonly started: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly aborted: number;
}

export interface MsFileNasResource {
  readonly supplierPublicKeyHex: string;
  readonly peerId: string;
  /** 带 certhash 与 `/p2p/<peerId>` 的完整 WebRTC Direct 地址。 */
  readonly webRtcDirectAddress: string;
  /** 带 `/p2p/<peerId>` 的完整 WSS 地址；浏览器未信任测试证书时不用于拨号。 */
  readonly wssAddress: string;
  readonly files: readonly MsFileNasIndexedFile[];
  fileByFilename(filename: string): MsFileNasIndexedFile;
  /** 供应商 Read 计数；用于证明读取确实到达真实 NAS。 */
  readMetrics(): Promise<MsFileNasReadMetrics>;
  /** NAS 进程 stderr 尾部；只用于失败诊断。 */
  stderrTail(lines?: number): readonly string[];
  /** 关闭 NAS 进程并删除临时目录；幂等。 */
  stop(): Promise<void>;
}

interface JsonResponse<T> {
  readonly ok: boolean;
  readonly status: number;
  readonly value?: T;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 loopback TCP 端口"));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function freeUdpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") {
        socket.close();
        reject(new Error("无法分配 loopback UDP 端口"));
        return;
      }
      socket.close(() => resolvePort(address.port));
    });
  });
}

function requestJson<T>(url: string): Promise<JsonResponse<T>> {
  return new Promise<JsonResponse<T>>((resolveResponse, reject) => {
    const request = httpsGet(url, {
      rejectUnauthorized: false,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          resolveResponse({ ok: false, status });
          return;
        }
        try {
          resolveResponse({
            ok: true,
            status,
            value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
  });
}

async function waitForJson<T>(url: string, accept: (value: T) => boolean, timeoutMs = NAS_READY_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson<T>(url);
      if (response.ok && response.value !== undefined && accept(response.value)) return response.value;
      if (!response.ok) lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`等待 msfile-nas 超时：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface NasStatus {
  readonly peer_id: string;
  readonly supplier_public_key: string;
  readonly listen_addresses: readonly string[];
}

interface NasFileList {
  readonly items: readonly {
    readonly recommended_filename: string;
    readonly seed_hash: string;
    readonly size_bytes: number;
    readonly media_type: string;
    readonly state: string;
  }[];
}

/**
 * 构建并启动真实 msfile-nas。
 *
 * 供应商身份固定为私钥 1，并在此处用 JS 派生结果交叉校验公钥和 PeerId；
 * 不一致说明两个实现的身份推导已经分歧，直接失败而不是继续拨号。
 */
export async function startMsFileNasResource(
  input: { readonly files: readonly MsFileNasFixtureFile[] },
): Promise<MsFileNasResource> {
  if (input.files.length === 0) throw new Error("真实 msfile-nas Journey 至少需要一个夹具文件");
  const goNasDir = getMsFileGoDir();
  const directory = await fs.mkdtemp(join(tmpdir(), "keymaster-msfile-nas-journey-"));
  const nasData = join(directory, "nas-data");
  const seedData = join(directory, "seed-data");
  const identityKey = join(directory, "supplier.key");
  const tlsCert = join(directory, "supplier.crt");
  const tlsKey = join(directory, "supplier-tls.key");
  const config = join(directory, "msfile-nas.yaml");
  const binary = join(directory, "msfile-nas");
  const stderr: string[] = [];
  let child: ChildProcess | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child) await stopChild(child);
    child = undefined;
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await fs.mkdir(nasData, { recursive: true });
    await fs.mkdir(seedData, { recursive: true });
    await fs.writeFile(identityKey, `${E2E_IDENTITY_PRIVATE_KEY_HEX}\n`, { mode: 0o600 });
    for (const file of input.files) await fs.writeFile(join(nasData, file.filename), file.bytes);
    await execFileAsync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", tlsKey, "-out", tlsCert, "-days", "1",
      "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { maxBuffer: 4 * 1024 * 1024 });
    await execFileAsync("go", ["build", "-buildvcs=false", "-o", binary, "./cmd/msfile-nas"], {
      cwd: goNasDir,
      maxBuffer: 8 * 1024 * 1024,
    });

    const webRtcPort = await freeUdpPort();
    const webPort = await freePort();
    await fs.writeFile(config, [
      `identity_key_file: ${JSON.stringify(identityKey)}`,
      `nas_data: ${JSON.stringify(nasData)}`,
      `seed_data: ${JSON.stringify(seedData)}`,
      "access_mode: public",
      "public_key_whitelist: []",
      "full_scan_interval: 1h",
      "file_stable_interval: 50ms",
      "invalid_retention: 1h",
      "hash_workers: 2",
      "enable_file_watcher: false",
      // 公网公布地址只填基础段，运行时补齐 certhash/PeerId；真正拨号的
      // ip4 地址仍从 /api/status 的 listen_addresses 取得。
      `webrtc_direct_public_addresses: [${JSON.stringify(`/dns4/localhost/udp/${webRtcPort}/webrtc-direct`)}]`,
      "listen:",
      `  - /ip4/127.0.0.1/udp/${webRtcPort}/webrtc-direct`,
      `  - /ip4/127.0.0.1/tcp/${webPort}/tls/ws`,
      `tls_cert_file: ${JSON.stringify(tlsCert)}`,
      `tls_key_file: ${JSON.stringify(tlsKey)}`,
      `admin_token: ${ADMIN_TOKEN}`,
      "",
    ].join("\n"));

    child = spawn(binary, ["--config", config], { cwd: goNasDir, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    const adminOrigin = `https://127.0.0.1:${webPort}`;

    const status = await waitForJson<NasStatus>(
      `${adminOrigin}/api/status`,
      (value) => Array.isArray(value.listen_addresses) && value.listen_addresses.length >= 2,
    );
    const rawWebRtcAddress = status.listen_addresses.find((value) => value.includes("/webrtc-direct"));
    const rawWssAddress = status.listen_addresses.find((value) => value.includes("/tls/ws"));
    if (!rawWebRtcAddress || !rawWssAddress) {
      throw new Error(`msfile-nas 没有同时发布 WebRTC Direct 与 WSS listener：${status.listen_addresses.join(", ")}`);
    }
    const withPeerId = (address: string): string => address.includes("/p2p/") ? address : `${address}/p2p/${status.peer_id}`;
    const webRtcDirectAddress = withPeerId(rawWebRtcAddress);
    const wssAddress = withPeerId(rawWssAddress);

    const expectedPublicKeyHex = bytesToHex(publicKeyFromPrivateKey(Uint8Array.from(Buffer.from(E2E_IDENTITY_PRIVATE_KEY_HEX, "hex"))));
    const expectedPeerId = peerIdFromPublicKeyBytes(publicKeyFromPrivateKey(Uint8Array.from(Buffer.from(E2E_IDENTITY_PRIVATE_KEY_HEX, "hex")))).toString();
    const supplierPublicKeyHex = status.supplier_public_key.toLowerCase();
    if (supplierPublicKeyHex !== expectedPublicKeyHex) {
      throw new Error("msfile-nas 供应商公钥与同一私钥的 JS 派生结果不一致");
    }
    if (status.peer_id !== expectedPeerId) {
      throw new Error("msfile-nas PeerId 与同一私钥的 JS 派生结果不一致");
    }

    const listed = await waitForJson<NasFileList>(
      `${adminOrigin}/api/files?state=ready&limit=50`,
      (value) => input.files.every((file) =>
        value.items.some((item) => item.recommended_filename === file.filename && item.state === "ready")),
    );
    const indexed: MsFileNasIndexedFile[] = input.files.map((file) => {
      const item = listed.items.find((candidate) => candidate.recommended_filename === file.filename && candidate.state === "ready");
      if (!item) throw new Error(`msfile-nas 没有索引夹具文件：${file.filename}`);
      return {
        filename: file.filename,
        seedHashHex: item.seed_hash,
        sizeBytes: item.size_bytes,
        mediaType: item.media_type || file.mediaType,
        sha256Hex: sha256Hex(file.bytes),
      };
    });

    return {
      supplierPublicKeyHex,
      peerId: status.peer_id,
      webRtcDirectAddress,
      wssAddress,
      files: indexed,
      fileByFilename(filename: string): MsFileNasIndexedFile {
        const file = indexed.find((entry) => entry.filename === filename);
        if (!file) throw new Error(`夹具文件未登记：${filename}`);
        return file;
      },
      async readMetrics(): Promise<MsFileNasReadMetrics> {
        const response = await requestJson<{ msfile_read_metrics?: MsFileNasReadMetrics }>(`${adminOrigin}/api/status`);
        const metrics = response.value?.msfile_read_metrics;
        if (!response.ok || !metrics) throw new Error(`msfile-nas /api/status 缺少 Read 计数：HTTP ${response.status}`);
        return metrics;
      },
      stderrTail: (lines = 40) => stderr.join("").split(/\r?\n/u).filter(Boolean).slice(-lines),
      stop,
    };
  } catch (error) {
    const tail = stderr.join("").trim();
    await stop();
    throw new Error(
      (error instanceof Error ? error.message : String(error)) + (tail ? `；msfile-nas stderr=${tail}` : ""),
    );
  }
}
