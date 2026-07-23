// packages/plugin-p2pkh/src/p2pkhTransferServiceSessionOwner.test.ts
// 硬切换 002 收尾 + 多 owner 支持：transfer 端关键集成测试。
//   - 走真实 IndexedDB（fake-indexeddb）+ 自建多 owner keyspace fake。
//   - 三类不变量：
//     (1) transfer 严格按 session owner 走 namespace DB；active 切
//         走不影响已开 owner handle；p2pkhDb 的 per-owner map 缓存
//         保证两个 owner 的 IDBDatabase 互不干扰。
//     (2) 硬门禁在 keyspace.openKeyStorage 层 fail-closed：active != input 时
//         首次 open 直接拒绝。
//     (3) 同一 preview 并发 submit 防重：tryClaimSubmissionWithInputs
//         走单 readwrite 事务，第二个 submit 撞到第一个的 claim 行
//         整事务 abort，不会重复广播。
//     (4) definitive rejection 释放 claim：广播被节点明确拒绝时
//         releaseLocalInputClaims 删除本次 claim。
//
// 故意不引入新 npm 依赖；fake keyspace + IndexedDB 都用现有 test
// 基础设施。

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { KeyIdentity, KeyScopedStorageHandle, KeyspaceService } from "@keymaster/contracts";
import {
  createP2pkhTransferService,
  type P2pkhTransferService
} from "./p2pkhTransferService.js";
import {
  makeResourceId,
  type P2pkhKeyResource,
  type P2pkhUtxo
} from "./p2pkhContracts.js";
import {
  createP2pkhDb,
  disposeP2pkhDb,
  openP2pkhDb,
  type P2pkhDbHandle
} from "./p2pkhDb.js";
import { calcTxidFromRawTxHex, deriveP2pkhAddress } from "./p2pkhSigner.js";

const OWNER_A_PRIV = "00000000000000000000000000000000000000000000000000000000000000a1";
const OWNER_B_PRIV = "00000000000000000000000000000000000000000000000000000000000000b1";

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function makeVault() {
  return {
    status: () => "unlocked",
    createActiveKeyCrypto: async (publicKeyHex: string) => {
      const privHex = publicKeyHex === OWNER_A_HEX ? OWNER_A_PRIV : OWNER_B_PRIV;
      const derived = deriveP2pkhAddress(privHex, "main");
      return {
        getIdentity: () => ({
          sessionId: "session-owner-test",
          publicKeyHex: derived.publicKeyHex,
          label: "test",
          capabilities: ["p2pkh"],
          createdAt: "2024-01-01T00:00:00.000Z"
        }),
        async signDigest(input: { publicKeyHex: string; digest: ArrayBuffer; format: "der" | "compact" }) {
          if (input.publicKeyHex !== derived.publicKeyHex) {
            throw new Error("session_key_mismatch");
          }
          const sig = secp256k1.sign(new Uint8Array(input.digest), hexToBytes(privHex), {
            lowS: true,
            prehash: false,
            format: input.format
          });
          return {
            publicKeyHex: derived.publicKeyHex,
            format: input.format,
            signature: sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength)
          };
        },
        async deriveP2pkhAddress(input: { publicKeyHex: string; network: "main" | "test" }) {
          if (input.publicKeyHex !== derived.publicKeyHex) {
            throw new Error("session_key_mismatch");
          }
          const address = deriveP2pkhAddress(privHex, input.network);
          return {
            publicKeyHex: address.publicKeyHex,
            address: address.address
          };
        }
      };
    },
    withPrivateKey: async (
      publicKeyHex: string,
      fn: (material: { hex: string }) => Promise<string> | string
    ) => {
      const privHex = publicKeyHex === OWNER_A_HEX ? OWNER_A_PRIV : OWNER_B_PRIV;
      return fn({ hex: privHex });
    }
  } as never;
}
const OWNER_A = deriveP2pkhAddress(OWNER_A_PRIV, "main");
const OWNER_B = deriveP2pkhAddress(OWNER_B_PRIV, "main");
const OWNER_A_HEX = OWNER_A.publicKeyHex;
const OWNER_B_HEX = OWNER_B.publicKeyHex;
const RECEIVER = deriveP2pkhAddress(
  "0000000000000000000000000000000000000000000000000000000000000099",
  "main"
);

function makeUtxo(value: number, txid: string, vout: number, ownerHex: string): P2pkhUtxo {
  const ownerAddress = ownerHex === OWNER_A_HEX ? OWNER_A.address : OWNER_B.address;
  return {
    id: `u-${txid}-${vout}`,
    publicKeyHex: ownerHex,
    resourceId: makeResourceId("main"),
    network: "main",
    address: ownerAddress,
    txid,
    vout,
    value,
    height: 1,
    status: "confirmed",
    isSpentInMempoolTx: false,
    syncedAt: "2024-01-01T00:00:00.000Z"
  };
}

/**
 * 简易多 owner keyspace fake：每个 owner 一个 IndexedDB 数据库。
 * `activePublicKeyHex` 可被 setActive 改写；`openKeyStorage` 走真
 * 实 fake-indexeddb（硬门禁：`active !== input.publicKeyHex` 抛
 * "Key storage is not ready"）。
 */
function makeMultiOwnerKeyspace(): KeyspaceService & {
  setActive(hex: string | undefined): void;
  listOpened(): string[];
} {
  const opened: string[] = [];
  let activeHex: string | undefined = undefined;
  const ks = {
    listKeys: async () => [],
    getKey: async (hex: string): Promise<KeyIdentity | undefined> => ({
      publicKeyHex: hex,
      label: hex === OWNER_A_HEX ? "a" : "b",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z"
    }),
    active: () => ({ activePublicKeyHex: activeHex }),
    setActive: async (hex: string) => {
      activeHex = hex;
    },
    requireActiveKey: () => {
      throw new Error("not used in this test");
    },
    withActiveKey: async () => {
      throw new Error("not used in this test");
    },
    onActiveKeyChanged: () => () => undefined,
    async openKeyStorage(input: {
      publicKeyHex: string;
      pluginId: string;
      storageId: string;
      version: number;
      upgrade: (db: IDBDatabase, oldVersion: number, newVersion: number | null) => void;
    }) {
      if (activeHex === undefined) {
        throw new Error("Key storage is not ready");
      }
      if (activeHex !== input.publicKeyHex) {
        throw new Error("Key storage is not ready");
      }
      const name = `keymaster.key.${input.publicKeyHex}.plugin.${input.pluginId}.${input.storageId}`;
      if (!opened.includes(name)) opened.push(name);
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const r = indexedDB.open(name, input.version);
        r.onupgradeneeded = (event) => {
          const ev = event as IDBVersionChangeEvent;
          input.upgrade(r.result, ev.oldVersion, ev.newVersion ?? null);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error("Key storage open blocked"));
      });
      const handle: KeyScopedStorageHandle = {
        db,
        name,
        close: () => {
          try {
            db.close();
          } catch {
            // 静默
          }
        }
      };
      return handle;
    },
    registerPluginStorage: () => undefined,
    listPluginStorages: () => [],
    prepareDeleteKey: async () => undefined,
    deleteKey: async () => undefined,
    isInitializing: () => false,
    onInitializationChange: () => () => undefined,
    attachBackgroundService: () => undefined
  };
  const wrapper = ks as unknown as KeyspaceService & {
    setActive(hex: string | undefined): Promise<void>;
    listOpened(): string[];
  };
  wrapper.setActive = async (hex: string | undefined) => {
    activeHex = hex;
  };
  wrapper.listOpened = () => [...opened];
  return wrapper;
}

async function setupOwnerDb(
  keyspace: KeyspaceService,
  ownerHex: string,
  utxos: P2pkhUtxo[]
): Promise<{ handle: P2pkhDbHandle }> {
  const bundle = await openP2pkhDb({ keyspace, publicKeyHex: ownerHex });
  const handle = createP2pkhDb(bundle);
  const resource: P2pkhKeyResource = {
    resourceId: makeResourceId("main"),
    publicKeyHex: ownerHex,
    label: ownerHex === OWNER_A_HEX ? "a" : "b",
    address: ownerHex === OWNER_A_HEX ? OWNER_A.address : OWNER_B.address,
    network: "main",
    createdAt: "2024-01-01T00:00:00.000Z",
    generation: 0
  };
  await handle.putAddress(resource);
  await handle.putUtxos(utxos);
  return { handle };
}

function makeTransferFor(
  keyspace: KeyspaceService,
  ownerHex: string
): P2pkhTransferService {
  return createP2pkhTransferService({
    vault: makeVault(),
    woc: {
      broadcast: vi.fn(async (_n: "main" | "test", rawTxHex: string) => ({
        accepted: true,
        canonicalTxid: calcTxidFromRawTxHex(rawTxHex),
        providerReturnedTxidRaw: calcTxidFromRawTxHex(rawTxHex),
        providerReturnedTxidNormalized: calcTxidFromRawTxHex(rawTxHex),
        txidIntegrity: "exact" as const
      }))
    } as never,
    messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
    getDb: (publicKeyHex: string) =>
      openP2pkhDb({ keyspace, publicKeyHex }).then((b) => createP2pkhDb(b)) as never,
    getActiveKey: () => ({
      publicKeyHex: ownerHex,
      label: "x",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z"
    }),
    getKeyForOwner: async (publicKeyHex: string) => ({
      publicKeyHex,
      label: publicKeyHex === OWNER_A_HEX ? "a" : "b",
      capabilities: ["p2pkh"],
      createdAt: "2024-01-01T00:00:00.000Z"
    })
  });
}

beforeEach(async () => {
  disposeP2pkhDb();
  await new Promise<void>((resolve) => {
    const reqs = [OWNER_A_HEX, OWNER_B_HEX].map((hex) =>
      indexedDB.deleteDatabase(`keymaster.key.${hex}.plugin.p2pkh.state`)
    );
    let done = 0;
    const tick = () => {
      done += 1;
      if (done >= reqs.length) resolve();
    };
    for (const r of reqs) {
      r.onsuccess = tick;
      r.onerror = tick;
      r.onblocked = tick;
    }
  });
});

afterEach(() => {
  disposeP2pkhDb();
});

describe("p2pkh.transfer session owner -> namespace db routing", () => {
  it("transfer routes to the owner-specific namespace DB; per-owner handles stay isolated", async () => {
    // 关键不变量：硬切换 002 收尾后，transfer 严格按
    // input.ownerPublicKeyHex 走 namespace DB；p2pkhDb 的 per-owner
    // map 保证两个 owner 的 IDBDatabase 互不干扰。
    const keyspace = makeMultiOwnerKeyspace();
    const utxoA = makeUtxo(3000, "a".repeat(64), 0, OWNER_A_HEX);
    const utxoB = makeUtxo(5000, "b".repeat(64), 0, OWNER_B_HEX);

    // 在 active=A 时打开 A 的 DB；切到 B 时打开 B 的 DB。
    keyspace.setActive(OWNER_A_HEX);
    const ownerA = await setupOwnerDb(keyspace, OWNER_A_HEX, [utxoA]);
    keyspace.setActive(OWNER_B_HEX);
    const ownerB = await setupOwnerDb(keyspace, OWNER_B_HEX, [utxoB]);

    // 切回 A，transfer 用 owner=A 调 prepare → 走 A 的 namespace DB。
    keyspace.setActive(OWNER_A_HEX);
    const transferA = makeTransferFor(keyspace, OWNER_A_HEX);
    const previewA = await transferA.prepare({
      ownerPublicKeyHex: OWNER_A_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });
    expect(previewA.ownerPublicKeyHex).toBe(OWNER_A_HEX);

    // 切到 B，transfer 用 owner=B 调 prepare → 走 B 的 namespace DB。
    keyspace.setActive(OWNER_B_HEX);
    const transferB = makeTransferFor(keyspace, OWNER_B_HEX);
    const previewB = await transferB.prepare({
      ownerPublicKeyHex: OWNER_B_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });
    expect(previewB.ownerPublicKeyHex).toBe(OWNER_B_HEX);

    // 两个 owner 的 DB 都被独立打开。
    expect(keyspace.listOpened()).toHaveLength(2);
    expect(keyspace.listOpened().some((n) => n.includes(OWNER_A_HEX))).toBe(true);
    expect(keyspace.listOpened().some((n) => n.includes(OWNER_B_HEX))).toBe(true);

    // 真句柄存活测试：拿到 ownerA 的 P2pkhDbHandle，再打开 ownerB 后，
    // 回头对 ownerA handle 再做一次读写，确认它**没**被静默关掉。
    // 这是「打开新 owner 不应关掉老 owner handle」的硬不变量。
    keyspace.setActive(OWNER_A_HEX);
    const ownerAHandle = await openP2pkhDb({ keyspace, publicKeyHex: OWNER_A_HEX }).then((b) =>
      createP2pkhDb(b)
    );
    keyspace.setActive(OWNER_B_HEX);
    // 触发 ownerB 的 open：仅访问 ownerA handle 不会触发 ownerB 缓存。
    // 这里「打开 ownerB」指再调用一次 transfer / listUtxos 让 p2pkhDb
    // 模块把 B 写入 map。
    const transferB2 = makeTransferFor(keyspace, OWNER_B_HEX);
    const previewB2 = await transferB2.prepare({
      ownerPublicKeyHex: OWNER_B_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });
    expect(previewB2.ownerPublicKeyHex).toBe(OWNER_B_HEX);

    // 关键断言：ownerA handle 在 ownerB 被打开后仍可读。
    keyspace.setActive(OWNER_A_HEX);
    const utxosA = await ownerAHandle.listUtxos();
    expect(utxosA).toHaveLength(1);
    expect(utxosA[0]!.publicKeyHex).toBe(OWNER_A_HEX);
    // 写一条新 UTXO，确认 IDB 连接没断。
    await ownerAHandle.putUtxos([makeUtxo(7777, "c".repeat(64), 0, OWNER_A_HEX)]);
    const utxosA2 = await ownerAHandle.listUtxos();
    expect(utxosA2).toHaveLength(2);

    // ownerB handle 仍可独立工作。
    keyspace.setActive(OWNER_B_HEX);
    const utxosB = await ownerB.handle.listUtxos();
    expect(utxosB).toHaveLength(1);
    expect(utxosB[0]!.publicKeyHex).toBe(OWNER_B_HEX);

    // 收尾：handle 各自关闭，p2pkhDb module 缓存清掉。
    ownerAHandle.close();
    ownerA.handle.close();
    ownerB.handle.close();
    disposeP2pkhDb();
  });

  it("listUtxos({ ownerPublicKeyHex }) reads from the owner's namespace DB, not the active key's", async () => {
    // 关键不变量：硬切换 002 收尾后，listUtxos 在 filter 传
    // ownerPublicKeyHex 时**严格**走该 owner 的 namespace DB。这
    // 是 protocol feepool 等跨 owner 调用的依赖——若实现回退到
    // active key namespace，会把「session owner 拿错 value」的
    // bug 重新带回来。
    const keyspace = makeMultiOwnerKeyspace();
    const utxoA = makeUtxo(3000, "a".repeat(64), 0, OWNER_A_HEX);
    const utxoB = makeUtxo(5000, "b".repeat(64), 0, OWNER_B_HEX);
    keyspace.setActive(OWNER_A_HEX);
    await setupOwnerDb(keyspace, OWNER_A_HEX, [utxoA]);
    keyspace.setActive(OWNER_B_HEX);
    await setupOwnerDb(keyspace, OWNER_B_HEX, [utxoB]);

    // active = B 时调 listUtxos({ ownerPublicKeyHex: A })：必须读
    // A 的 namespace DB，不能回退到 active=B。
    // （硬门禁会要求 active==owner 才能开库，所以这里在调
    // listUtxos 之前先模拟「protocol 已把 active 切到 A」。）
    keyspace.setActive(OWNER_A_HEX);
    const service = await import("./p2pkhService.js").then((m) =>
      m.createP2pkhService({
        vault: makeVault(),
        woc: {} as never,
        messageBus: { publish: () => undefined, subscribe: () => () => undefined } as never,
        backgroundRegistry: {
          register: () => undefined,
          list: () => [],
          get: () => undefined
        } as never,
        backgroundService: {
          trigger: () => undefined,
          cancel: async () => undefined
        } as never,
        keyspace,
        logger: undefined
      })
    );
    // 从 A 的 namespace 取：A 有 1 个 UTXO。
    const fromA = await service.listUtxos({ assetId: "bsv", ownerPublicKeyHex: OWNER_A_HEX });
    expect(fromA).toHaveLength(1);
    expect(fromA[0]!.publicKeyHex).toBe(OWNER_A_HEX);

    // 切到 active=B，再 listUtxos({ ownerPublicKeyHex: B })：必须
    // 读 B 的 namespace DB。
    keyspace.setActive(OWNER_B_HEX);
    const fromB = await service.listUtxos({ assetId: "bsv", ownerPublicKeyHex: OWNER_B_HEX });
    expect(fromB).toHaveLength(1);
    expect(fromB[0]!.publicKeyHex).toBe(OWNER_B_HEX);

    // 切回 active=A，dispose B 的 cached handle；再 listUtxos({ owner: B })
    // ——p2pkhDb map 找不到 B 的 handle，触发 `keyspace.openKeyStorage`，
    // 硬门禁（A !== B）挡掉，service.listUtxos 冒泡
    //「Key storage is not ready」。这是 protocol 层「session owner != active」
    // 漏过后的最后一道防线。
    keyspace.setActive(OWNER_A_HEX);
    disposeP2pkhDb(OWNER_B_HEX);
    await expect(
      service.listUtxos({ assetId: "bsv", ownerPublicKeyHex: OWNER_B_HEX })
    ).rejects.toThrow(/Key storage is not ready/);
  });

  it("hard gate blocks a *new* openKeyStorage when active != requested owner", async () => {
    // 反向不变量：active = A，但 keyspace.openKeyStorage 被以 B 调用
    // ——硬门禁（A !== B）必须 fail-closed。这模拟「protocol 层
    // 校验 active == session owner 之前就走 openKeyStorage」的反例。
    const keyspace = makeMultiOwnerKeyspace();
    keyspace.setActive(OWNER_A_HEX);
    await expect(
      keyspace.openKeyStorage({
        publicKeyHex: OWNER_B_HEX,
        pluginId: "p2pkh",
        storageId: "state",
        version: 1,
        upgrade: () => undefined
      })
    ).rejects.toThrow(/Key storage is not ready/);
  });
});

describe("p2pkh.transfer concurrent submit atomic claim", () => {
  it("rejects the second submit when both target overlapping UTXOs (atomic claim)", async () => {
    // 关键不变量：tryClaimSubmissionWithInputs 走单 readwrite 事务，
    // 两个并发 submit 撞到同一对 (txid, vout) 时，第二个的事务
    // abort 抛「input already claimed」——transfer 不会调
    // woc.broadcast 第二次。
    const keyspace = makeMultiOwnerKeyspace();
    const utxos = [
      makeUtxo(3000, "a".repeat(64), 0, OWNER_A_HEX),
      makeUtxo(5000, "b".repeat(64), 0, OWNER_A_HEX)
    ];
    keyspace.setActive(OWNER_A_HEX);
    const { handle } = await setupOwnerDb(keyspace, OWNER_A_HEX, utxos);

    const transfer = makeTransferFor(keyspace, OWNER_A_HEX);
    const previewA = await transfer.prepare({
      ownerPublicKeyHex: OWNER_A_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });
    const previewB = await transfer.prepare({
      ownerPublicKeyHex: OWNER_A_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });
    // 两个 preview 选同样的 UTXOs。
    expect(previewA.allocation.selected.map((u) => `${u.txid}:${u.vout}`)).toEqual(
      previewB.allocation.selected.map((u) => `${u.txid}:${u.vout}`)
    );

    // 把第一个 broadcast 延迟，让两个 submit 同时进入 tryClaim。
    let resolveBroadcast!: (value: unknown) => void;
    const broadcastGate = new Promise((r) => {
      resolveBroadcast = r;
    });
    let broadcastCallCount = 0;
    const transferGated = createP2pkhTransferService({
      vault: makeVault(),
      woc: {
        broadcast: vi.fn(async (_n: "main" | "test", rawTxHex: string) => {
          broadcastCallCount += 1;
          await broadcastGate;
          return {
            accepted: true,
            canonicalTxid: calcTxidFromRawTxHex(rawTxHex),
            providerReturnedTxidRaw: calcTxidFromRawTxHex(rawTxHex),
            providerReturnedTxidNormalized: calcTxidFromRawTxHex(rawTxHex),
            txidIntegrity: "exact" as const
          };
        })
      } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: (publicKeyHex: string) =>
        openP2pkhDb({ keyspace, publicKeyHex }).then((b) => createP2pkhDb(b)) as never,
      getActiveKey: () => ({
        publicKeyHex: OWNER_A_HEX,
        label: "a",
        capabilities: ["p2pkh"],
        createdAt: "2024-01-01T00:00:00.000Z"
      }),
      getKeyForOwner: async (publicKeyHex: string) => ({
        publicKeyHex,
        label: "a",
        capabilities: ["p2pkh"],
        createdAt: "2024-01-01T00:00:00.000Z"
      })
    });

    // 启动两个并发 submit：第一个进 tryClaim + 拿到 broadcast 锁；
    // 第二个进 tryClaim 应该撞到第一个的 claim 行并 abort。
    const submitP1 = transferGated.submit(previewA);
    // 等第一个拿到 broadcast 锁（= 已经走过 tryClaim）再启动第二个。
    await new Promise((r) => setTimeout(r, 0));
    const submitP2 = transferGated.submit(previewB);
    // 提前挂一个空 catch 防止 vitest 把「稍后才 await」的 reject
    // 报为 unhandled rejection。
    submitP2.catch(() => undefined);

    // 放行第一个 broadcast，让第一个走完。
    resolveBroadcast(undefined);
    const r1 = await submitP1;
    // 第二个的事务 abort 后 tryClaimSubmissionWithInputs 抛错，
    // 整 submit 抛上来。
    await expect(submitP2).rejects.toThrow(/input already claimed/);

    // 关键断言：broadcast 只调一次（第二个没有 broadcast）。
    expect(broadcastCallCount).toBe(1);
    expect(r1.status).toBe("broadcast-pending-woc");

    // DB 状态：第一个 submission 行 + 它的 claim 行；没有第二个
    // submission（事务 abort，submission 也不写）。
    const submissions = await handle.listLocalSubmissions();
    const claims = await handle.listLocalInputClaims();
    expect(submissions).toHaveLength(1);
    expect(claims.length).toBeGreaterThan(0);
    const winnerId = submissions[0]!.id;
    for (const c of claims) {
      expect(c.submissionId).toBe(winnerId);
    }
  });
});

describe("p2pkh.transfer definitive rejection releases claim", () => {
  it("deletes the just-made claim when broadcast is definitively rejected", async () => {
    // 关键不变量：definitive rejection 路径上 releaseLocalInputClaims
    // 删除本次 claim，让这些 outpoint 重新可被后续分配选到。审
    // 计信息保留在 failed submission 行里。
    const keyspace = makeMultiOwnerKeyspace();
    const utxos = [makeUtxo(3000, "a".repeat(64), 0, OWNER_A_HEX)];
    keyspace.setActive(OWNER_A_HEX);
    const { handle } = await setupOwnerDb(keyspace, OWNER_A_HEX, utxos);

    // 模拟 broadcast 抛「节点明确拒绝」语义错误：
    //   - 错误信息里包含 "rejected" 字样。
    //   - WocService 抛错而不是返回 accepted=false。
    const transfer = createP2pkhTransferService({
      vault: makeVault(),
      woc: {
        broadcast: vi.fn(async () => {
          throw new Error("transaction rejected by peer: bad-txns-inputs-missingorspent");
        })
      } as never,
      messageBus: { publish: vi.fn(), subscribe: vi.fn() } as never,
      getDb: (publicKeyHex: string) =>
        openP2pkhDb({ keyspace, publicKeyHex }).then((b) => createP2pkhDb(b)) as never,
      getActiveKey: () => ({
        publicKeyHex: OWNER_A_HEX,
        label: "a",
        capabilities: ["p2pkh"],
        createdAt: "2024-01-01T00:00:00.000Z"
      }),
      getKeyForOwner: async (publicKeyHex: string) => ({
        publicKeyHex,
        label: "a",
        capabilities: ["p2pkh"],
        createdAt: "2024-01-01T00:00:00.000Z"
      })
    });

    const preview = await transfer.prepare({
      ownerPublicKeyHex: OWNER_A_HEX,
      assetId: "bsv",
      recipientAddress: RECEIVER.address,
      amountSatoshis: 1000,
      feeRateSatoshisPerKb: 1
    });

    const result = await transfer.submit(preview);
    expect(result.status).toBe("rejected");
    expect(result.localInputClaimIds).toEqual([]);

    // 关键断言：claim 已被释放（DB 里 0 行），submission 保留为 rejected。
    const submissions = await handle.listLocalSubmissions();
    const claims = await handle.listLocalInputClaims();
    expect(claims).toHaveLength(0);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]!.status).toBe("rejected");
  });
});
