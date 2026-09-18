// 真实 SatSubscription 服务器的本地 e2e 资源。
//
// 它从仓库外的 SatSubscription 源码构建正式 `cmd/satsubscription`，启动一个
// 一次性 PostgreSQL 集群，并用真实 SSP/SPI 服务完成 Keymaster 的 Channel
// 消息测试。这里不做任何协议替身：Noise、uvarint 分帧、SSP Wire、订阅关系、
// 收费判据和账本全部来自生产实现；白名单客户端在测试期间实际收费为 0。
//
// 资源边界与安全：
//   - 仓库目录必须由 SATS_SUBSCRIPTION_DIR 显式提供，不写死开发机路径；
//   - PostgreSQL 使用临时数据目录、trust 认证和随机端口，不接触用户库；
//   - 服务身份私钥每次运行随机生成，只通过环境变量传给子进程，不写日志；
//   - 任何一步失败都 fail closed，并尽力回收子进程和临时目录。

import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { bytesToHex, peerIdFromPublicKeyBytes, publicKeyFromPrivateKey } from "bitcoin-libp2p/identity";

const execFileAsync = promisify(execFile);

/** 临时 PostgreSQL 的超级用户和数据库名；只在本次运行内存在。 */
const DATABASE_USER = "keymaster_e2e";
const DATABASE_NAME = "keymaster_e2e";
/** 固定环境变量名；配置只引用名字，不写值。 */
const DSN_ENV = "SAT_SUBSCRIPTION_E2E_DSN";
const PASSWORD_ENV = "SAT_SUBSCRIPTION_E2E_DB_PASSWORD";
const SIGNER_ENV = "SAT_SUBSCRIPTION_E2E_SIGNER_KEY";
/** 子进程启动上限；包含 db migrate 和首次监听。 */
const SERVER_READY_TIMEOUT_MS = 90_000;

export interface StartSatSubscriptionLocalServerInput {
  /** 允许免费 Publish/Subscribe 的客户端压缩公钥 hex；必须非空。 */
  readonly whitelistPublicKeys: readonly string[];
  /** SatSubscription 仓库根目录；缺省读取 SATS_SUBSCRIPTION_DIR。 */
  readonly repositoryDir?: string;
  /** Go 命令；缺省读取 SAT_SUBSCRIPTION_GO，再退回 PATH 中的 go。 */
  readonly goCommand?: string;
  /** PostgreSQL bin 目录；缺省用 pg_config --bindir 解析。 */
  readonly postgresBinDir?: string;
}

/** 账本里的操作计数；只保留类型、次数和收费子单位。 */
export interface SatSubscriptionLedgerOperation {
  readonly operationType: string;
  readonly count: number;
  /** 精确 18 位子单位；字符串避免超出 JS 安全整数。 */
  readonly chargedSubunits: string;
}

export interface SatSubscriptionSubscription {
  /** 已认证订阅方压缩公钥 hex。 */
  readonly subjectPublicKeyHex: string;
  /** 订阅的精确频道。 */
  readonly channel: string;
}

export interface SatSubscriptionLedgerSummary {
  readonly operations: readonly SatSubscriptionLedgerOperation[];
  /** 当前有效的订阅频道（例如 bsv8.inbox.<owner>）。 */
  readonly subscriptionChannels: readonly string[];
  /** 当前有效订阅的订阅方与频道对；用于证明第三方没有越权订阅。 */
  readonly subscriptions: readonly SatSubscriptionSubscription[];
}

export interface SatSubscriptionLocalServer {
  /** 服务身份压缩公钥 hex；页面用它做供应商身份 pin。 */
  readonly supplierPublicKeyHex: string;
  /** 服务 libp2p Peer ID。 */
  readonly peerId: string;
  /** 带 `/p2p/<peerId>` 的完整 WebSocket multiaddr。 */
  readonly multiaddr: string;
  /** 运行期只读账本投影；用于证明真实订阅和 0 扣费。 */
  ledgerSummary(): Promise<SatSubscriptionLedgerSummary>;
  /** 服务端日志尾部；只用于失败诊断，不含私钥或 DSN 秘密。 */
  serverLogTail(lines?: number): readonly string[];
  /** 关闭服务、临时 PostgreSQL 和临时目录；幂等。 */
  stop(): Promise<void>;
}

function requireSatSubscriptionDir(input: StartSatSubscriptionLocalServerInput): string {
  const directory = input.repositoryDir?.trim() || process.env.SATS_SUBSCRIPTION_DIR?.trim();
  if (!directory) {
    throw new Error("真实 SatSubscription e2e 必须设置 SATS_SUBSCRIPTION_DIR（SatSubscription 仓库根目录），不能使用本机默认路径");
  }
  const root = resolve(directory);
  if (!existsSync(join(root, "cmd/satsubscription/main.go"))) {
    throw new Error(`SATS_SUBSCRIPTION_DIR 不是有效仓库：缺少 ${join(root, "cmd/satsubscription/main.go")}`);
  }
  return root;
}

function requireGoCommand(input: StartSatSubscriptionLocalServerInput): string {
  const command = input.goCommand?.trim() || process.env.SAT_SUBSCRIPTION_GO?.trim() || "go";
  return command;
}

function requirePostgresBinDir(input: StartSatSubscriptionLocalServerInput): string {
  const configured = input.postgresBinDir?.trim() || process.env.SAT_SUBSCRIPTION_PG_BIN?.trim();
  if (configured) return resolve(configured);
  const result = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
  const directory = result.status === 0 ? result.stdout.trim() : "";
  if (!directory || !existsSync(join(directory, "initdb"))) {
    throw new Error("需要 pg_config --bindir 或 SAT_SUBSCRIPTION_PG_BIN 指向包含 initdb 的 PostgreSQL bin 目录");
  }
  return directory;
}

/** 让操作系统分配一个当前空闲的回环 TCP 端口；PostgreSQL 18 拒绝 port=0。 */
async function findFreeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolvePort(port);
        else rejectPort(new Error("无法为临时 PostgreSQL 分配回环端口"));
      });
    });
  });
}

function assertWhitelist(publicKeys: readonly string[]): readonly string[] {
  if (!Array.isArray(publicKeys) || publicKeys.length === 0) {
    throw new Error("真实 SatSubscription e2e 必须提供至少一个白名单客户端公钥；空名单会意外进入收费路径");
  }
  const normalized = publicKeys.map((value) => value.trim().toLowerCase());
  for (const value of normalized) {
    if (!/^(02|03)[0-9a-f]{64}$/u.test(value)) throw new Error(`白名单公钥不是合法压缩公钥：${value.slice(0, 8)}…`);
  }
  if (new Set(normalized).size !== normalized.length) throw new Error("白名单公钥不允许重复");
  return normalized;
}

function buildServerConfig(whitelist: readonly string[]): Record<string, unknown> {
  return {
    listen_addrs: ["/ip4/127.0.0.1/tcp/0"],
    currency: "BSV",
    // 白名单免费不依赖网络资金；仍固定 testnet，避免任何误用主网地址的空间。
    network: "testnet",
    postgres: {
      dsn_env: DSN_ENV,
      password_env: PASSWORD_ENV,
      max_conns: 8,
      min_conns: 1,
      max_conn_lifetime: "1h",
      max_conn_idle_time: "10m",
      transaction_timeout: "15s"
    },
    pricing: {
      publish_price: "0.1",
      subscribe_price: "0.05",
      permanent_free_public_keys: [...whitelist],
      new_client_free_days: 0
    },
    ssp: {
      max_payload_bytes: 1048576,
      max_in_flight: 64,
      send_queue_messages: 128,
      send_queue_bytes: 8388608,
      write_timeout: "15s"
    },
    resources: {
      max_connections: 128,
      max_connections_per_ip: 16,
      max_streams_per_connection: 16
    },
    scanner: {
      enabled: false,
      endpoint: "https://api.whatsonchain.com/v1/bsv",
      api_key_env: "SAT_SUBSCRIPTION_E2E_WHATSONCHAIN_API_KEY",
      history_start_height: 0,
      history_from_genesis: false,
      interval: "3s",
      request_timeout: "15s",
      max_receipts_per_round: 10000,
      max_response_bytes: 33554432,
      raw_tx_cache_entries: 4096,
      max_requests_per_second: 3,
      raw_tx_cache_bytes: 67108864
    },
    logging: { level: "info" },
    signer: { private_key_env: SIGNER_ENV },
    connectivity: { public_ip: "" }
  };
}

interface ReadySummary {
  readonly addresses: readonly string[];
  readonly peer_id: string;
  readonly public_key: string;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

/** 启动真实 SatSubscription 服务并返回脱敏句柄。 */
export async function startSatSubscriptionLocalServer(
  input: StartSatSubscriptionLocalServerInput,
): Promise<SatSubscriptionLocalServer> {
  const repositoryDir = requireSatSubscriptionDir(input);
  const goCommand = requireGoCommand(input);
  const postgresBinDir = requirePostgresBinDir(input);
  const whitelist = assertWhitelist(input.whitelistPublicKeys);

  const runDir = await fs.mkdtemp(join(tmpdir(), "keymaster-satsubscription-e2e-"));
  const dataDir = join(runDir, "pgdata");
  const socketDir = join(runDir, "pgsock");
  await fs.mkdir(socketDir, { recursive: true });
  const binaryPath = join(runDir, "satsubscription");
  const configPath = join(runDir, "config.json");
  const pgLogPath = join(runDir, "postgres.log");
  const signerKeyHex = randomBytes(32).toString("hex");

  let serverChild: ChildProcess | undefined;
  let postgresStarted = false;
  let databasePort = 0;
  let stopped = false;
  /** 仅保留服务端日志尾部供失败诊断；不包含私钥或 DSN 秘密。 */
  const serverLogs: string[] = [];
  const rememberServerLog = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    serverLogs.push(trimmed);
    if (serverLogs.length > 200) serverLogs.splice(0, serverLogs.length - 200);
  };

  const dsn = () => `postgresql://${DATABASE_USER}@127.0.0.1:${databasePort}/${DATABASE_NAME}`;
  const childEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    [DSN_ENV]: dsn(),
    [PASSWORD_ENV]: "e2e-trust-only",
    [SIGNER_ENV]: signerKeyHex
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (serverChild) await stopChild(serverChild);
    serverChild = undefined;
    if (postgresStarted) {
      try {
        await execFileAsync(join(postgresBinDir, "pg_ctl"), ["-D", dataDir, "stop", "-m", "immediate"], { timeout: 30_000 });
      } catch {
        // 临时集群已经不可用时直接进入目录清理。
      }
      postgresStarted = false;
    }
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    await execFileAsync(goCommand, ["version"], { timeout: 30_000 });
    await execFileAsync(
      goCommand,
      ["build", "-buildvcs=false", "-o", binaryPath, "./cmd/satsubscription"],
      { cwd: repositoryDir, env: { ...process.env, GOWORK: "off" }, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
    );

    await execFileAsync(join(postgresBinDir, "initdb"), ["-D", dataDir, "-A", "trust", "-U", DATABASE_USER], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024
    });
    databasePort = await findFreeLoopbackPort();
    await execFileAsync(
      join(postgresBinDir, "pg_ctl"),
      ["-D", dataDir, "-l", pgLogPath, "-o", `-p ${databasePort} -k ${socketDir} -c listen_addresses=127.0.0.1`, "start"],
      { timeout: 60_000 },
    );
    postgresStarted = true;
    await execFileAsync(join(postgresBinDir, "createdb"), ["-h", "127.0.0.1", "-p", String(databasePort), "-U", DATABASE_USER, DATABASE_NAME], { timeout: 30_000 });

    await fs.writeFile(configPath, `${JSON.stringify(buildServerConfig(whitelist), null, 2)}\n`, "utf8");
    await execFileAsync(binaryPath, ["db", "migrate", "--config", configPath], {
      env: childEnv(),
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024
    });

    const ready = await new Promise<ReadySummary>((resolveReady, rejectReady) => {
      const child = spawn(binaryPath, ["server", "run", "--config", configPath], {
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      serverChild = child;
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectReady(new Error(`SatSubscription server 未在 ${SERVER_READY_TIMEOUT_MS}ms 内 ready；stderr=${stderrLines.slice(-5).join(" ")}`));
      }, SERVER_READY_TIMEOUT_MS);
      const considerLine = (line: string): void => {
        if (settled) return;
        const trimmed = line.trim();
        if (!trimmed.includes('"event":"ready"')) return;
        try {
          const parsed = JSON.parse(trimmed) as { addresses?: unknown; peer_id?: unknown; public_key?: unknown };
          if (Array.isArray(parsed.addresses) && typeof parsed.peer_id === "string" && typeof parsed.public_key === "string") {
            settled = true;
            clearTimeout(timer);
            resolveReady({ addresses: parsed.addresses as string[], peer_id: parsed.peer_id, public_key: parsed.public_key });
          }
        } catch {
          // ready 行之外的普通日志不参与解析。
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split(/\r?\n/u)) {
          stdoutLines.push(line);
          rememberServerLog(line);
          considerLine(line);
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const value = chunk.toString();
        stderrLines.push(value);
        for (const line of value.split(/\r?\n/u)) {
          rememberServerLog(line);
          considerLine(line);
        }
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectReady(error);
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectReady(new Error(`SatSubscription server 提前退出：code=${code} signal=${signal}；stderr=${stderrLines.slice(-5).join(" ")}`));
      });
    });

    const wsAddress = ready.addresses.find((value) => value.endsWith("/ws"));
    if (!wsAddress) throw new Error(`SatSubscription server 没有发布 WebSocket 地址：${ready.addresses.join(", ")}`);
    // JS 派生身份必须与 Go 服务端一致；不一致说明身份派生分歧，直接失败。
    const expectedPeerId = peerIdFromPublicKeyBytes(publicKeyFromPrivateKey(Uint8Array.from(Buffer.from(signerKeyHex, "hex")))).toString();
    if (expectedPeerId !== ready.peer_id) {
      throw new Error("SatSubscription 服务端 Peer ID 与同一私钥的 JS 派生结果不一致");
    }
    const multiaddr = wsAddress.includes("/p2p/") ? wsAddress : `${wsAddress}/p2p/${ready.peer_id}`;

    const queryLedger = async (sql: string): Promise<string[][]> => {
      const { stdout } = await execFileAsync(
        join(postgresBinDir, "psql"),
        ["-h", "127.0.0.1", "-p", String(databasePort), "-U", DATABASE_USER, "-d", DATABASE_NAME, "-At", "-F", "|", "-c", sql],
        { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.split("|"));
    };

    return {
      supplierPublicKeyHex: ready.public_key.toLowerCase(),
      peerId: ready.peer_id,
      multiaddr,
      async ledgerSummary(): Promise<SatSubscriptionLedgerSummary> {
        const operationRows = await queryLedger(
          "SELECT operation_type, COUNT(*), COALESCE(SUM(charged_subunits), 0)::text FROM operations GROUP BY operation_type ORDER BY operation_type",
        );
        const relationRows = await queryLedger(
          "SELECT DISTINCT convert_from(object_key, 'UTF8') FROM relations WHERE valid_to IS NULL ORDER BY 1",
        );
        const subscriptionRows = await queryLedger(
          "SELECT DISTINCT encode(subject_key, 'hex'), convert_from(object_key, 'UTF8') FROM relations WHERE valid_to IS NULL ORDER BY 1, 2",
        );
        return {
          operations: operationRows.map((row) => ({
            operationType: row[0] ?? "",
            count: Number(row[1] ?? "0"),
            chargedSubunits: row[2] ?? "0"
          })),
          subscriptionChannels: relationRows.map((row) => row[0] ?? "").filter(Boolean),
          subscriptions: subscriptionRows.map((row) => ({
            subjectPublicKeyHex: (row[0] ?? "").toLowerCase(),
            channel: row[1] ?? ""
          }))
        };
      },
      serverLogTail: (lines = 40) => serverLogs.slice(-lines),
      stop
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
