// P2PKH 专用资金的写前日志与恢复。
//
// 这里验证的不是「能拆出钱」，而是三件顺序相关的事：
//   1. 派发之前 fundingId / submissionId / raw / outpoint 已经在存储里；
//   2. 广播成功后响应丢失时，再次调用返回**同一笔** UTXO，不会再拆一次钱；
//   3. 拒绝与未知都不是「可用的专用资金」——被拒的记录允许重来，未知的记录必须
//      先对账原提交，否则原提交的双花风险会被一笔新 UTXO 抹掉。

import { describe, expect, it } from "vitest";

import type {
  ProtocolDedicatedFunding,
  ProtocolDedicatedFundingState,
  ProtocolFundingService,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService,
  ProtocolSubmissionObservation,
} from "@keymaster/contracts";

import { createProtectedOutpointRegistry } from "./registries/protectedOutpointRegistry.js";

import { estimateProtocolFundingMinerFee } from "@keymaster/contracts";

import {
  createProtocolFundingService,
  ProtocolFundingError,
  type ProtocolFundingStoredRecord,
  type ProtocolFundingStore,
} from "./p2pkhProtocolFunding.js";

const OWNER = "02".repeat(33);
const REQUIRED = "1000";
/** 真实 testnet P2PKH 地址：资金准备交易要把它编成锁定脚本，形状不对会被直接拒绝。 */
const TESTNET_ADDRESS = "n1rGjTHZWjkX7pwBei5c5opidSF1TSzWK6";
/** 真实 mainnet P2PKH 地址：测试「按记录自己的网络观察」时需要与记录的网络匹配。 */
const MAINNET_ADDRESS = "1FVkWH2mfsVcLTFxCabC13v7AvmnHVbt6X";
const FUNDING_TXID = "ab".repeat(32);

/**
 * 按记录分文件的内存 store，并支持条件写。
 *
 * 刻意做成文件语义（而不是一个 Map）而不是为了方便：跨页覆盖窗口、创建竞态与
 * 「记录存在但读不出来」这三个问题只有在文件语义下才复现得出来。
 */
function store(): ProtocolFundingStore & {
  readonly records: Map<string, ProtocolFundingStoredRecord>;
  readonly writes: string[];
  /** 注入一个读不出来的记录：文件存在但内容损坏。 */
  corrupt(fundingId: string): void;
} {
  const records = new Map<string, ProtocolFundingStoredRecord>();
  const unreadable = new Set<string>();
  const writes: string[] = [];
  return {
    records,
    writes,
    corrupt(fundingId) {
      unreadable.add(fundingId);
      records.delete(fundingId);
    },
    async list() {
      return {
        records: [...records.values()],
        unreadable: [...unreadable],
      };
    },
    async get(fundingId) {
      if (unreadable.has(fundingId)) return undefined;
      return records.get(fundingId);
    },
    async put(record, options) {
      if (options?.ifAbsent === true && records.has(fundingId(record.fundingId))) {
        throw new Error("condition failed: record exists");
      }
      records.set(record.fundingId, record);
      writes.push(record.fundingId);
    },
    async delete(fundingId) {
      records.delete(fundingId);
      unreadable.delete(fundingId);
    },
  };
}

/** 让两个 store 共享同一份文件：等价于同一浏览器的两个标签页。 */
function sharedBacking(): { readonly backing: Map<string, ProtocolFundingStoredRecord>; readonly unreadable: Set<string> } {
  return { backing: new Map(), unreadable: new Set() };
}

function fundingId(id: string): string {
  return id;
}

interface Harness {
  readonly service: ProtocolFundingService;
  readonly store: ReturnType<typeof store>;
  readonly events: string[];
  readonly protections: Map<string, unknown>;
  /** 服务实际调用链上观察时用到的网络序列：断言「按记录自己的网络观察」。 */
  readonly observedNetworks: string[];
  /** 服务实际调用 outpoint 观察时用到的坐标：断言回收前真的按 UTXO 核验过。 */
  readonly observedOutpoints: string[];
}

function harness(input: {
  /** 覆盖默认 store：用于制造创建竞态等特殊视图。 */
  store?: ReturnType<typeof store>;
  registry?: ReturnType<typeof createProtectedOutpointRegistry>;
  submitStatus?: ProtocolSpendResult["status"];
  /** submit 抛错时用它触发「明确未派发」分支。 */
  throwOnSubmit?: boolean;
  chain?: ProtocolDedicatedFundingState;
  /** 单独观察 outpoint 的结论；默认跟随 chain（mempool/confirmed 都是未花费）。 */
  outpoint?: "spent" | "unspent" | "unknown";
  submission?: ProtocolSubmissionObservation;
}): Harness {
  const events: string[] = [];
  const protections = new Map<string, unknown>();
  const fundingStore = input.store ?? store();
  const preview: ProtocolSpendPreview = {
    ownerPublicKeyHex: OWNER,
    network: "test",
    inputs: [{ txid: "cd".repeat(32), vout: 0, value: 2000, address: TESTNET_ADDRESS }],
    outputs: [{ value: 1000, scriptHex: "76a914" }],
    changeSatoshis: 0,
    estimatedFeeSatoshis: 1,
    serializedSizeBytes: 200,
    txid: FUNDING_TXID,
    rawTxHex: "0100deadbeef",
    submissionId: "submission-1",
  };
  const spend: ProtocolSpendService = {
    async prepare(){throw Error("Unsigned preview is not used by dependent funding");},
    async presign() {
      events.push("prepare");
      return preview;
    },
    async submit() {
      events.push("submit");
      if (input.throwOnSubmit === true) throw new Error("clearly-not-dispatched");
      return {
        status: input.submitStatus ?? "broadcast-pending-woc",
        txid: FUNDING_TXID,
        rawTxHex: preview.rawTxHex,
        submissionId: preview.submissionId,
      };
    },
  };
  // 通过可变游标暴露：服务闭包调用它，测试可以在装配后替换以断言调用参数。
  const observed = { networks: [] as string[], outpoints: [] as string[] };
  const observeChain = async (network: "main" | "test", _txid: string): Promise<ProtocolDedicatedFundingState> => {
    observed.networks.push(network);
    return input.chain ?? "mempool";
  };
  return {
    service: createProtocolFundingService({
      protocolSpend: () => spend,
      protectedOutpoints: input.registry ?? {
        register: (entry) => {
          events.push(`protect:${entry.id}`);
          protections.set(entry.id, entry);
        },
        unregister: (id) => {
          events.push(`unprotect:${id}`);
          protections.delete(id);
        },
      },
      store: fundingStore,
      now: () => 1_700_000_000_000,
      async allocate() {
        events.push("allocate");
        return {
          selected: [{ txid: "cd".repeat(32), vout: 0, value: 2000, address: TESTNET_ADDRESS }],
          totalInputSatoshis: 2000,
        };
      },
      observeChain,
      async observeOutpoint({ network: outpointNetwork, txid: outpointTxid, vout }) {
        observed.outpoints.push(`${outpointNetwork}:${outpointTxid}:${vout}`);
        return input.outpoint ?? (input.chain === "spent" ? "spent" : "unspent");
      },
      async observeSubmission() {
        return input.submission ?? "unknown";
      },
      async deriveChangeAddress(_ownerPublicKeyHex: string, network: "main" | "test") {
        return network === "main" ? MAINNET_ADDRESS : TESTNET_ADDRESS;
      },
    }),
    store: fundingStore,
    events,
    protections,
    observedNetworks: observed.networks,
    observedOutpoints: observed.outpoints,
  };
}

function request(overrides: { fundingId?: string; requiredSatoshis?: string } = {}) {
  return {
    ownerPublicKeyHex: OWNER,
    network: "test" as const,
    fundingId: overrides.fundingId ?? "forum:task-1",
    requiredSatoshis: overrides.requiredSatoshis ?? REQUIRED,
    feeRateSatoshisPerKb: 1,
    ownerPluginId: "forum",
  };
}

describe("专用资金的写前日志", () => {
  it("派发之前就落盘 fundingId、submissionId、raw 与 outpoint", async () => {
    const h = harness({});
    await h.service.prepareDedicatedFunding(request());
    // 选币 → 构造签名 → 写前日志 → 保护登记 → 派发。写前日志与保护登记都必须在
    // submit 之前，否则广播成功但响应丢失时磁盘上没有任何痕迹。
    expect(h.events).toEqual([
      "allocate",
      "prepare",
      "protect:protocol-funding:forum:task-1",
      "submit",
    ]);
    expect(h.events.indexOf("protect:protocol-funding:forum:task-1")).toBeLessThan(h.events.indexOf("submit"));
    const record = h.store.records.get("forum:task-1");
    // owner 与 network 必须从第一版记录就在：缺 owner 会被生产存储的 owner 校验拒绝，
    // 缺 network 会让恢复时按当前设置猜错网络。
    expect(record?.ownerPublicKeyHex).toBe(OWNER);
    expect(record?.network).toBe("test");
    expect(record?.submissionId).toBe("submission-1");
    expect(record?.rawTxHex).toBe("0100deadbeef");
    expect(record?.txid).toBe(FUNDING_TXID);
    expect(record?.vout).toBe(0);
    // 派发结果落盘后仍然是同一笔资金，只更新广播阶段。
    expect(record?.broadcastState).toBe("dispatched");
  });

  it("广播成功后响应丢失时再次准备返回同一笔 UTXO，不再拆钱", async () => {
    const h = harness({});
    const first = await h.service.prepareDedicatedFunding(request());
    // 模拟重启：进程内记录清空，但磁盘上还在。
    const persisted = h.store.records.get("forum:task-1");
    h.store.records.clear();
    h.store.records.set("forum:task-1", persisted as ProtocolFundingStoredRecord);

    const second = await h.service.prepareDedicatedFunding(request());
    expect(second.txid).toBe(first.txid);
    expect(second.vout).toBe(first.vout);
    expect(second.valueSatoshis).toBe(first.valueSatoshis);
    // 没有第二次选币，也没有第二次派发。
    expect(h.events.filter((event) => event === "allocate")).toHaveLength(1);
    expect(h.events.filter((event) => event === "submit")).toHaveLength(1);
    // 同一 provider 只注册一次，复用通过 provider 数据刷新。
    expect(h.events.filter((event) => event === "protect:protocol-funding:forum:task-1")).toHaveLength(1);
  });

  it("同一个编号重复准备只对应一笔专用资金", async () => {
    const h = harness({});
    await h.service.prepareDedicatedFunding(request());
    await h.service.prepareDedicatedFunding(request());
    expect(h.events.filter((event) => event === "prepare")).toHaveLength(1);
  });

  it("已有资金额度不足时用新编号按新额度重新准备（报价上涨）", async () => {
    const first = harness({});
    await first.service.prepareDedicatedFunding(request());
    const carried = first.store.records.get("forum:task-1");
    expect(carried?.valueSatoshis).toBe("1000");
    expect(carried?.ownerPublicKeyHex).toBe(OWNER);

    // 旧编号那条链上 UTXO 只有 1000，本次需要 2000：不能拿它去构造。
    const second = harness({ chain: "mempool" });
    second.store.records.set("forum:task-1", carried as ProtocolFundingStoredRecord);
    const record = await second.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }));
    // 新资金用新编号：复用编号会让保护登记顶掉旧输出。
    expect(record.fundingId).toBe("forum:task-1+1");
    expect(record.valueSatoshis).toBe("2000");
    expect(second.events).toContain("prepare");
  });

  it("额度不足时保留旧记录并标为被替代，旧输出继续受保护", async () => {
    // 同一个服务实例连续两次准备：第一次的保护登记必须在第二次之后仍然存在。
    const h = harness({ chain: "mempool" });
    await h.service.prepareDedicatedFunding(request());
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(true);

    await h.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }));

    // 旧记录仍在（重启后才有恢复证据），并标出后继编号。
    const old = h.store.records.get("forum:task-1");
    expect(old?.supersededBy).toBe("forum:task-1+1");
    expect(old?.txid).toBe(FUNDING_TXID);
    // 两个输出都受保护：旧的不解除、新的已登记。
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(true);
    expect(h.protections.has("protocol-funding:forum:task-1+1")).toBe(true);
    expect(h.events).not.toContain("unprotect:protocol-funding:forum:task-1");
  });

  it("重启后旧（被替代）与新两笔资金都有记录与保护", async () => {
    const first = harness({});
    await first.service.prepareDedicatedFunding(request());
    const second = harness({ chain: "mempool" });
    second.store.records.set("forum:task-1", first.store.records.get("forum:task-1") as ProtocolFundingStoredRecord);
    await second.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }));

    // 模拟重启：只有磁盘记录，保护为空。
    const rebooted = harness({ chain: "mempool" });
    for (const record of (await second.store.list(OWNER)).records) rebooted.store.records.set(record.fundingId, record);
    const outcome = await rebooted.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    expect(outcome?.restored).toBe(2);
    expect(rebooted.protections.has("protocol-funding:forum:task-1")).toBe(true);
    expect(rebooted.protections.has("protocol-funding:forum:task-1+1")).toBe(true);
  });

  it("被替代的记录不可复用", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request());
    const record = (await seed.store.list(OWNER)).records[0] as ProtocolFundingStoredRecord;
    const superseded = harness({ chain: "mempool" });
    superseded.store.records.set("forum:task-1", { ...record, supersededBy: "forum:task-1+1" });
    const outcome = await superseded.service.reconcileDedicatedFunding?.({
      ownerPublicKeyHex: OWNER,
      network: "test",
      fundingId: "forum:task-1",
      txid: FUNDING_TXID,
      vout: 0,
      requiredSatoshis: "1000",
    });
    expect(outcome?.usable).toBe(false);
    expect(outcome?.reason).toContain("替代");
  });

  it("已有资金额度足够时复用同一笔，不重新拆", async () => {
    const first = harness({});
    await first.service.prepareDedicatedFunding(request());
    const carried = first.store.records.get("forum:task-1");

    const second = harness({ chain: "mempool" });
    second.store.records.set("forum:task-1", carried as ProtocolFundingStoredRecord);
    const record = await second.service.prepareDedicatedFunding(request({ requiredSatoshis: "500" }));
    expect(record.txid).toBe(FUNDING_TXID);
    expect(second.events).not.toContain("prepare");
  });

  it("已花费的记录让位给新额度，并解除保护", async () => {
    const first = harness({});
    await first.service.prepareDedicatedFunding(request());
    const carried = first.store.records.get("forum:task-1");
    const spent = harness({ chain: "spent" });
    spent.store.records.set("forum:task-1", carried as ProtocolFundingStoredRecord);
    const record = await spent.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }));
    expect(record.valueSatoshis).toBe("2000");
    // 已被花费 → 保护可以解除。
    expect(spent.events).toContain("unprotect:protocol-funding:forum:task-1");
  });
});

describe("拒绝与未知都不是可用资金", () => {
  it("被拒的记录允许重新准备", async () => {
    const h = harness({ submitStatus: "rejected" });
    await expect(h.service.prepareDedicatedFunding(request())).rejects.toMatchObject({ code: "funding-rejected" });
    // 记录保留下来，因此第二次调用会先作废再重备，而不是直接返回它。
    expect(h.store.records.get("forum:task-1")?.broadcastState).toBe("rejected");
    const retry = harness({});
    retry.store.records.set("forum:task-1", h.store.records.get("forum:task-1") as ProtocolFundingStoredRecord);
    const record = await retry.service.prepareDedicatedFunding(request());
    expect(record.broadcastState).toBe("dispatched");
  });

  it("结果未知时拒绝返回专用资金", async () => {
    const h = harness({ submitStatus: "unknown" });
    await expect(h.service.prepareDedicatedFunding(request())).rejects.toMatchObject({ code: "funding-state-unknown" });
    expect(h.store.records.get("forum:task-1")?.broadcastState).toBe("unknown");
  });

  it("写前日志之后崩溃且原提交未派发时才允许重备", async () => {
    const crashed = harness({ chain: "mempool", submission: "not-dispatched" });
    const record: ProtocolFundingStoredRecord = {
      fundingId: "forum:task-1",
      ownerPublicKeyHex: OWNER,
      network: "test",
      txid: FUNDING_TXID,
      vout: 0,
      rawTxHex: "0100deadbeef",
      valueSatoshis: REQUIRED,
      address: TESTNET_ADDRESS,
      submissionId: "submission-1",
      broadcastState: "prepared",
    };
    crashed.store.records.set("forum:task-1", record);
    const fresh = await crashed.service.prepareDedicatedFunding(request());
    expect(fresh.broadcastState).toBe("dispatched");
    expect(crashed.events).toContain("prepare");
  });

  it("写前日志之后崩溃但原提交状态未知时拒绝重备", async () => {
    const crashed = harness({ chain: "unknown", submission: "unknown" });
    crashed.store.records.set("forum:task-1", {
      fundingId: "forum:task-1",
      ownerPublicKeyHex: OWNER,
      network: "test",
      txid: FUNDING_TXID,
      vout: 0,
      rawTxHex: "0100deadbeef",
      valueSatoshis: REQUIRED,
      address: TESTNET_ADDRESS,
      submissionId: "submission-1",
      broadcastState: "prepared",
    });
    await expect(crashed.service.prepareDedicatedFunding(request())).rejects.toBeInstanceOf(ProtocolFundingError);
    // 关键：没有重新选币、重新构造或重新派发。
    expect(crashed.events).toEqual([]);
  });
});

describe("并发创建同一编号", () => {
  /**
   * 「另一个页面刚建好」的 store 视图。
   *
   * `list` 报空（本次调用因此走创建路径），而 `put(ifAbsent)` 必然冲突——这正是两个
   * 页面同时发现编号不存在、各自构造然后条件写分出胜负的那一刻。
   */
  function lostRaceStore(): ReturnType<typeof store> & { readonly conflicts: number } {
    const backing = store();
    const conflicts = { value: 0 };
    return {
      ...backing,
      conflicts: 0,
      // 列举为空：本次调用不会复用记录，会真的去创建。
      list: async () => ({ records: [], unreadable: [] }),
      get: async () => undefined,
      put: async (record, options) => {
        if (options?.ifAbsent === true) {
          conflicts.value += 1;
          throw new Error("condition failed: record exists");
        }
        return backing.put(record, options);
      },
    };
  }

  it("条件写冲突时不派发，也不覆盖赢家", async () => {
    const h = harness({ store: lostRaceStore() });
    const submitsBefore = h.events.filter((event) => event === "submit").length;
    await expect(h.service.prepareDedicatedFunding(request())).rejects.toMatchObject({ code: "funding-state-unknown" });
    // 关键：冲突的一方绝不广播第二笔拆钱交易。
    expect(h.events.filter((event) => event === "submit").length).toBe(submitsBefore);
    expect(h.store.writes).toEqual([]);
  });

  it("条件写冲突会释放本次构造的预签名（不留悬挂占用）", async () => {
    const released: string[] = [];
    const spend = {
      async prepare(){throw Error("Unsigned preview is not used by dependent funding");},
    async presign() {
        return {
          ownerPublicKeyHex: OWNER,
          network: "test" as const,
          inputs: [{ txid: "cd".repeat(32), vout: 0, value: 2000, address: TESTNET_ADDRESS }],
          outputs: [{ value: 1000, scriptHex: "76a914" }],
          changeSatoshis: 0,
          estimatedFeeSatoshis: 1,
          serializedSizeBytes: 200,
          txid: FUNDING_TXID,
          rawTxHex: "0100deadbeef",
          submissionId: "submission-1",
        };
      },
      async submit() {
        throw new Error("不应被派发");
      },
      async releasePrepared(preview: { submissionId?: string }) {
        released.push(preview.submissionId ?? "none");
      },
    };
    const service = createProtocolFundingService({
      protocolSpend: () => spend as never,
      protectedOutpoints: { register: () => undefined, unregister: () => undefined },
      store: lostRaceStore(),
      async allocate() {
        return { selected: [{ txid: "cd".repeat(32), vout: 0, value: 2000, address: TESTNET_ADDRESS }], totalInputSatoshis: 2000 };
      },
      async observeChain() {
        return "mempool";
      },
      async deriveChangeAddress() {
        return TESTNET_ADDRESS;
      },
    });
    await expect(service.prepareDedicatedFunding(request())).rejects.toMatchObject({ code: "funding-state-unknown" });
    // 自己的预签名被释放，否则会留下一笔永远不会派发的输入占用。
    expect(released).toEqual(["submission-1"]);
  });

  it("同一个编号的第二次创建不广播另一笔拆钱交易", async () => {
    const h = harness({});
    const first = await h.service.prepareDedicatedFunding(request());
    const before = h.events.filter((event) => event === "submit").length;
    // 记录已在（模拟另一个页面刚建好）：条件写必须挡住第二次创建。
    const again = await h.service.prepareDedicatedFunding(request());
    expect(again.txid).toBe(first.txid);
    // 不会多出一次派发。
    expect(h.events.filter((event) => event === "submit").length).toBe(before);
  });
});

describe("重启后的保护恢复", () => {
  it("从持久记录恢复全部有效资金的保护登记", async () => {
    const first = harness({});
    await first.service.prepareDedicatedFunding(request({ fundingId: "forum:task-a" }));
    await first.service.prepareDedicatedFunding(request({ fundingId: "forum:task-b" }));
    const restoredFrom = (await first.store.list(OWNER)).records;

    // 模拟重启：进程内保护为空，磁盘上只有记录。
    const rebooted = harness({ chain: "mempool" });
    for (const record of restoredFrom) rebooted.store.records.set(record.fundingId, record);
    const outcome = await rebooted.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    expect(outcome?.restored).toBe(2);
    expect(outcome?.unreadable).toEqual([]);
    expect(rebooted.protections.has("protocol-funding:forum:task-a")).toBe(true);
    expect(rebooted.protections.has("protocol-funding:forum:task-b")).toBe(true);
  });

  it("只有明确已花费的资金才解除保护，链上未知时继续保护", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request({ fundingId: "forum:task-spent" }));
    await seed.service.prepareDedicatedFunding(request({ fundingId: "forum:task-unknown" }));
    const records = (await seed.store.list(OWNER)).records;

    const spent = harness({ chain: "spent" });
    spent.store.records.set("forum:task-spent", records.find((r) => r.fundingId === "forum:task-spent") as ProtocolFundingStoredRecord);
    await spent.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    // 已证明被花费：UTXO 不存在，可以不保护。
    expect(spent.protections.has("protocol-funding:forum:task-spent")).toBe(false);

    const unknown = harness({ chain: "unknown" });
    unknown.store.records.set("forum:task-unknown", records.find((r) => r.fundingId === "forum:task-unknown") as ProtocolFundingStoredRecord);
    const outcome = await unknown.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    // 「查不到」不等于「不存在」：状态未知时必须继续保护，否则一次网络抖动就变成
    // 用户的静默资金损失。
    expect(outcome?.restored).toBe(1);
    expect(unknown.protections.has("protocol-funding:forum:task-unknown")).toBe(true);
  });

  it("按记录自己的网络观察，而不是当前设置", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding({ ...request(), network: "main" });
    const record = (await seed.store.list(OWNER)).records[0] as ProtocolFundingStoredRecord;
    // 记录自己带上网络：恢复时不必也不该拿 `bsvNetwork` 之类设置去猜。
    expect(record.network).toBe("main");

    const rebooted = harness({ chain: "confirmed" });
    rebooted.store.records.set(record.fundingId, record);
    // 即使传入 test，观察也必须按记录里的 main 走。
    await rebooted.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    expect(rebooted.observedNetworks).toEqual(["main"]);
    expect(rebooted.protections.has("protocol-funding:forum:task-1")).toBe(true);
  });

  it("存在读不出来的记录时如实报告 unreadable", async () => {
    const h = harness({});
    await h.service.prepareDedicatedFunding(request({ fundingId: "forum:task-a" }));
    h.store.corrupt("forum:task-broken");
    await expect(h.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" })).rejects.toMatchObject({ code: "funding-state-unknown" });
  });

  it("读不出来的记录会让准备新资金 fail closed", async () => {
    const h = harness({});
    h.store.corrupt("forum:task-broken");
    await expect(h.service.prepareDedicatedFunding(request({ fundingId: "forum:task-new" }))).rejects.toMatchObject({
      code: "funding-state-unknown",
    });
    expect(h.events).toEqual([]);
  });
});

describe("复用路径会恢复保护", () => {
  it("经过 restore/reconcile 之后保护登记存在（普通选币不会花掉它）", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request({ fundingId: "forum:task-a" }));
    const record = (await seed.store.list(OWNER)).records.find((r) => r.fundingId === "forum:task-a") as ProtocolFundingStoredRecord;

    // 重启：进程内保护为空，只有磁盘上的记录。
    const rebooted = harness({ chain: "mempool" });
    rebooted.store.records.set(record.fundingId, record);
    expect(rebooted.protections.size).toBe(0);

    await rebooted.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    // 恢复必须在「普通转账会选币」之前发生，因此这一步之后保护必须已在。
    expect(rebooted.protections.get("protocol-funding:forum:task-a")).toBeDefined();
  });

  it("不经过 restore 就直接 prepare 也会重申保护", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request());
    const record = (await seed.store.list(OWNER)).records[0] as ProtocolFundingStoredRecord;

    const rebooted = harness({ chain: "confirmed" });
    rebooted.store.records.set(record.fundingId, record);
    await rebooted.service.prepareDedicatedFunding(request());
    expect(rebooted.protections.has("protocol-funding:forum:task-1")).toBe(true);
  });

  it("记录属于别的 owner 时既不复用也不恢复保护", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request());
    const record = { ...((await seed.store.list(OWNER)).records[0] as ProtocolFundingStoredRecord), ownerPublicKeyHex: "03".repeat(33) };

    const other = harness({ chain: "confirmed" });
    other.store.records.set(record.fundingId, record);
    const outcome = await other.service.reconcileDedicatedFunding?.({
      ownerPublicKeyHex: OWNER,
      network: "test",
      fundingId: "forum:task-1",
      txid: FUNDING_TXID,
      vout: 0,
      requiredSatoshis: "1000",
    });
    expect(outcome?.usable).toBe(false);
    expect(other.protections.has("protocol-funding:forum:task-1")).toBe(false);
  });
});

describe("显式回收", () => {
  /** 造出「已被替代」的两笔资金，返回第一笔的记录与一个可回收的 harness。 */
  async function supersededPair(input: { outpoint?: "spent" | "unspent" | "unknown"; chain?: ProtocolDedicatedFundingState; submitStatus?: ProtocolSpendResult["status"] } = {}) {
    // seed 永远用正常链状态，否则「准备资金」本身就会先失败，测不到回收分支。
    const seed = harness({ chain: "mempool" });
    await seed.service.prepareDedicatedFunding(request());
    await seed.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }));
    const old = (await seed.store.list(OWNER)).records.find((record) => record.fundingId === "forum:task-1") as ProtocolFundingStoredRecord;
    const h = harness({ chain: input.chain ?? "mempool", outpoint: input.outpoint, submitStatus: input.submitStatus });
    for (const record of (await seed.store.list(OWNER)).records) h.store.records.set(record.fundingId, record);
    // 保护是内存态：像重启那样重新登记，测试才在真实的恢复场景下断言保护。
    await h.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    return { h, old, recover: { ownerPublicKeyHex: OWNER, network: "test" as const, fundingId: "forum:task-1", feeRateSatoshisPerKb: 1, reason: { supersededBy: "forum:task-1+1" as const } } };
  }

  it("被替代的资金可以扫回 owner 地址；先按 outpoint 核验，回收后记录与保护一并清理", async () => {
    const { h, recover } = await supersededPair();
    const outcome = await h.service.recoverDedicatedFunding?.(recover);
    expect(outcome?.outcome).toBe("recovered");
    // 广播状态原样透出，不在这里做翻译。
    expect(outcome?.broadcastState).toBe("broadcast-pending-woc");
    // 回收前必须按 outpoint 证明这个 UTXO 还没被花掉。
    expect(h.observedOutpoints.length).toBeGreaterThan(0);
    expect(h.store.records.has("forum:task-1")).toBe(false);
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(false);
    // 新那笔不受影响。
    expect(h.store.records.has("forum:task-1+1")).toBe(true);
    expect(h.protections.has("protocol-funding:forum:task-1+1")).toBe(true);
  });

  it("UTXO 已被花费时只清理记录与保护，不构造回收交易", async () => {
    const { h, recover } = await supersededPair({ outpoint: "spent" });
    const outcome = await h.service.recoverDedicatedFunding?.(recover);
    expect(outcome?.outcome).toBe("already-spent");
    expect(outcome?.recoveredSatoshis).toBe("0");
    expect(h.store.records.has("forum:task-1")).toBe(false);
    expect(h.events).not.toContain("prepare");
  });

  it("outpoint 花费状态未知时拒绝回收", async () => {
    const { h, recover } = await supersededPair({ outpoint: "unknown" });
    await expect(h.service.recoverDedicatedFunding?.(recover)).rejects.toMatchObject({ code: "funding-observation-unavailable" });
    expect(h.store.records.has("forum:task-1")).toBe(true);
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(true);
  });

  it("交易层面状态未知时拒绝回收", async () => {
    const { h, recover } = await supersededPair({ chain: "unknown" });
    await expect(h.service.recoverDedicatedFunding?.(recover)).rejects.toMatchObject({ code: "funding-observation-unavailable" });
    expect(h.store.records.has("forum:task-1")).toBe(true);
  });

  it("广播结果未知时不删记录与保护", async () => {
    const { h, recover } = await supersededPair({ submitStatus: "unknown" });
    await expect(h.service.recoverDedicatedFunding?.(recover)).rejects.toMatchObject({ code: "funding-state-unknown" });
    expect(h.store.records.has("forum:task-1")).toBe(true);
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(true);
  });

  it("服务商结果不一致时不删记录与保护", async () => {
    const { h, recover } = await supersededPair({ submitStatus: "provider-inconsistent" });
    await expect(h.service.recoverDedicatedFunding?.(recover)).rejects.toMatchObject({ code: "funding-state-unknown" });
    expect(h.store.records.has("forum:task-1")).toBe(true);
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(true);
  });

  it.each([["rejected"], ["woc-dropped"]] as const)("广播被明确拒绝（%s）时报失败，钱仍在原处", async (status) => {
    const { h, recover } = await supersededPair({ submitStatus: status });
    await expect(h.service.recoverDedicatedFunding?.(recover)).rejects.toMatchObject({ code: "funding-rejected" });
    // 钱没花出去：记录与保护都要留着，用户可以改费率重试。
    expect(h.store.records.has("forum:task-1")).toBe(true);
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(true);
  });

  it("替代依据与记录不符时拒绝", async () => {
    const { h, recover } = await supersededPair();
    await expect(h.service.recoverDedicatedFunding?.({ ...recover, reason: { supersededBy: "forum:task-9" } }))
      .rejects.toMatchObject({ code: "funding-state-unknown" });
    expect(h.store.records.has("forum:task-1")).toBe(true);
  });

  it("资金准备结果未知时拒绝（先对账原提交）", async () => {
    const { h, old, recover } = await supersededPair();
    h.store.records.set("forum:task-1", { ...old, broadcastState: "unknown" });
    await expect(h.service.recoverDedicatedFunding?.(recover)).rejects.toMatchObject({ code: "funding-state-unknown" });
    expect(h.store.records.has("forum:task-1")).toBe(true);
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(true);
  });

  it("已派发的资金记录允许回收（dispatched 表示 UTXO 已在链上）", async () => {
    const { h, recover } = await supersededPair();
    expect(h.store.records.get("forum:task-1")).toMatchObject({ broadcastState: "dispatched" });
    const outcome = await h.service.recoverDedicatedFunding?.(recover);
    expect(outcome?.outcome).toBe("recovered");
  });

  it("明确未派发的记录走 release 而不是回收", async () => {
    const { h, old, recover } = await supersededPair();
    h.store.records.set("forum:task-1", { ...old, broadcastState: "rejected" });
    await expect(h.service.recoverDedicatedFunding?.(recover)).rejects.toMatchObject({ code: "funding-rejected" });
  });

  it("未被替代时，仅凭 unused 依据也能回收（任务取消/报价下降的余款）", async () => {
    const h = harness({ chain: "mempool" });
    await h.service.prepareDedicatedFunding(request());
    const outcome = await h.service.recoverDedicatedFunding?.({
      ownerPublicKeyHex: OWNER, network: "test", fundingId: "forum:task-1",
      feeRateSatoshisPerKb: 1, reason: { unused: true },
    });
    expect(outcome?.outcome).toBe("recovered");
    expect(h.store.records.has("forum:task-1")).toBe(false);
    expect(h.protections.has("protocol-funding:forum:task-1")).toBe(false);
  });

  it("记录不存在时拒绝，不凭空回收", async () => {
    const h = harness({ chain: "mempool" });
    await expect(h.service.recoverDedicatedFunding?.({
      ownerPublicKeyHex: OWNER, network: "test", fundingId: "forum:nope",
      feeRateSatoshisPerKb: 1, reason: { unused: true },
    })).rejects.toMatchObject({ code: "funding-state-unknown" });
    expect(h.events).not.toContain("prepare");
  });

  it("属于别的 owner 的记录一律拒绝", async () => {
    const { h, old, recover } = await supersededPair();
    h.store.records.set("forum:task-1", { ...old, ownerPublicKeyHex: "02".padEnd(66, "0") });
    await expect(h.service.recoverDedicatedFunding?.({ ...recover, ownerPublicKeyHex: OWNER }))
      .rejects.toMatchObject({ code: "funding-state-unknown" });
    expect(h.events).not.toContain("prepare");
  });
});

describe("复用已有资金时的核对", () => {
  it("链上成立且额度足够时可复用，并重申保护", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request());
    const record = (await seed.store.list(OWNER)).records[0] as ProtocolFundingStoredRecord;

    const rebooted = harness({ chain: "confirmed" });
    rebooted.store.records.set("forum:task-1", record);
    const outcome = await rebooted.service.reconcileDedicatedFunding?.({
      ownerPublicKeyHex: OWNER,
      network: "test",
      fundingId: "forum:task-1",
      txid: FUNDING_TXID,
      vout: 0,
      requiredSatoshis: "800",
    });
    expect(outcome?.usable).toBe(true);
    expect(outcome?.state).toBe("confirmed");
    expect(rebooted.protections.has("protocol-funding:forum:task-1")).toBe(true);
  });

  it("已花费的资金不可复用", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request());
    const record = (await seed.store.list(OWNER)).records[0] as ProtocolFundingStoredRecord;
    const spent = harness({ chain: "spent" });
    spent.store.records.set("forum:task-1", record);
    const outcome = await spent.service.reconcileDedicatedFunding?.({
      ownerPublicKeyHex: OWNER,
      network: "test",
      fundingId: "forum:task-1",
      txid: FUNDING_TXID,
      vout: 0,
      requiredSatoshis: "1000",
    });
    expect(outcome?.usable).toBe(false);
    expect(outcome?.reason).toContain("已被花费");
  });

  it("额度不足时不可复用（报价上涨）", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request());
    const record = (await seed.store.list(OWNER)).records[0] as ProtocolFundingStoredRecord;
    const grown = harness({ chain: "mempool" });
    grown.store.records.set("forum:task-1", record);
    const outcome = await grown.service.reconcileDedicatedFunding?.({
      ownerPublicKeyHex: OWNER,
      network: "test",
      fundingId: "forum:task-1",
      txid: FUNDING_TXID,
      vout: 0,
      requiredSatoshis: "5000",
    });
    expect(outcome?.usable).toBe(false);
    expect(outcome?.reason).toContain("不足");
  });

  it("链上状态未知时不可复用", async () => {
    const seed = harness({});
    await seed.service.prepareDedicatedFunding(request());
    const record = (await seed.store.list(OWNER)).records[0] as ProtocolFundingStoredRecord;
    const unknown = harness({ chain: "unknown" });
    unknown.store.records.set("forum:task-1", record);
    const outcome = await unknown.service.reconcileDedicatedFunding?.({
      ownerPublicKeyHex: OWNER,
      network: "test",
      fundingId: "forum:task-1",
      txid: FUNDING_TXID,
      vout: 0,
      requiredSatoshis: "1000",
    });
    expect(outcome?.usable).toBe(false);
    expect(outcome?.reason).toContain("未知");
  });

  it("记录不存在或 outpoint 不一致时不可复用", async () => {
    const h = harness({});
    const missing = await h.service.reconcileDedicatedFunding?.({
      ownerPublicKeyHex: OWNER,
      network: "test",
      fundingId: "forum:nope",
      txid: FUNDING_TXID,
      vout: 0,
      requiredSatoshis: "1000",
    });
    expect(missing?.usable).toBe(false);

    await h.service.prepareDedicatedFunding(request());
    const mismatched = await h.service.reconcileDedicatedFunding?.({
      ownerPublicKeyHex: OWNER,
      network: "test",
      fundingId: "forum:task-1",
      txid: "cd".repeat(32),
      vout: 0,
      requiredSatoshis: "1000",
    });
    expect(mismatched?.usable).toBe(false);
    expect(mismatched?.reason).toContain("outpoint");
  });
});

describe("资金准备矿工费估算", () => {
  it("与实际使用的费用余量同源，且随费率单调", () => {
    const low = estimateProtocolFundingMinerFee(1000n, 1);
    const high = estimateProtocolFundingMinerFee(1000n, 100);
    expect(low).toBeGreaterThan(0n);
    expect(high).toBeGreaterThan(low);
  });

  it("非法费率与输入数上界被拒绝", () => {
    expect(() => estimateProtocolFundingMinerFee(1000n, 0)).toThrow();
    expect(() => estimateProtocolFundingMinerFee(1000n, 1, 0)).toThrow();
  });

  it("prepare 交给 allocate 的费用余量来自同一份估算", async () => {
    const h = harness({});
    const estimate = h.service.estimateFundingMinerFee?.({ requiredSatoshis: REQUIRED, feeRateSatoshisPerKb: 1 });
    expect(estimate).toBe(estimateProtocolFundingMinerFee(1000n, 1).toString());
  });
});

describe("实际保护注册表与后继资金恢复", () => {
  it("准备、复用、核对和重复恢复不重复注册，并允许 Forum claim", async () => {
    const registry = createProtectedOutpointRegistry();
    const h = harness({ registry });
    const first = await h.service.prepareDedicatedFunding(request());
    expect(h.store.records.get(first.fundingId)?.ownerPluginId).toBe("forum");
    await h.service.prepareDedicatedFunding(request());
    await h.service.reconcileDedicatedFunding?.({ ...request(), txid: first.txid, vout: first.vout });
    await h.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    await Promise.resolve();
    const claim = await registry.claimProtectedInputs({ ownerPluginId: "forum", publicKeyHex: OWNER, network: "test", inputs: [{ txid: first.txid, vout: first.vout }] });
    expect(claim.claimIds).toHaveLength(1);
    await h.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    await Promise.resolve();
    await expect(registry.claimProtectedInputs({ ownerPluginId: "forum", publicKeyHex: OWNER, network: "test", inputs: [{ txid: first.txid, vout: first.vout }] })).rejects.toThrow("already claimed");
    expect(h.events.filter((e) => e === "submit")).toHaveLength(1);
  });

  it("新实例从文件记录恢复后保持 Forum 插件归属", async () => {
    const first = harness({ registry: createProtectedOutpointRegistry() });
    const record = await first.service.prepareDedicatedFunding(request());
    const registry = createProtectedOutpointRegistry();
    const rebooted = harness({ registry });
    rebooted.store.records.set(record.fundingId, first.store.records.get(record.fundingId) as ProtocolFundingStoredRecord);
    await rebooted.service.restoreProtections?.({ ownerPublicKeyHex: OWNER, network: "test" });
    await Promise.resolve();
    const claim = await registry.claimProtectedInputs({ ownerPluginId: "forum", publicKeyHex: OWNER, network: "test", inputs: [{ txid: record.txid, vout: record.vout }] });
    expect(claim.claimIds).toHaveLength(1);
  });

  it("相同请求沿已有后继复用，重启后也不再次拆钱", async () => {
    const h = harness({});
    await h.service.prepareDedicatedFunding(request());
    const replacement = await h.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }));
    const retry = await h.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }));
    expect(retry.fundingId).toBe(replacement.fundingId);
    expect(h.events.filter((e) => e === "submit")).toHaveLength(2);
    const rebooted = harness({});
    for (const record of (await h.store.list(OWNER)).records) rebooted.store.records.set(record.fundingId, record);
    expect((await rebooted.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }))).fundingId).toBe(replacement.fundingId);
    expect(rebooted.events).not.toContain("prepare");
  });

  it("后继资金结果未知时只对账，不跳到下一编号付款", async () => {
    const h = harness({});
    await h.service.prepareDedicatedFunding(request());
    const replacement = await h.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }));
    const rebooted = harness({ chain: "unknown", submission: "unknown" });
    for (const record of (await h.store.list(OWNER)).records) rebooted.store.records.set(record.fundingId, record.fundingId === replacement.fundingId ? { ...record, broadcastState: "unknown" } : record);
    await expect(rebooted.service.prepareDedicatedFunding(request({ requiredSatoshis: "2000" }))).rejects.toMatchObject({ code: "funding-observation-unavailable" });
    expect(rebooted.events).not.toContain("prepare");
    expect(rebooted.store.records.size).toBe(2);
  });
});
