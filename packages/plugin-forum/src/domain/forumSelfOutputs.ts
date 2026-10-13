// FT05：自有 Forum data / tip 输出的识别、保护与归集。
//
// 论坛交易里有两类输出属于作者本人，而不是论坛服务：
//
//   - vout 1 的 1 sat 数据输出：锁定脚本是 `<clientpublickey> OP_CHECKSIG`；
//   - vout 2 的父价打赏输出：锁定脚本是 `<父作者公钥> OP_CHECKSIG`，当自己回复自己
//     的帖子时父作者就是自己。
//
// 它们是**裸公钥单签**形状：公钥在锁定脚本里，解锁脚本只需要一个签名。因此归集
// 不能走 P2PKH 的「由地址重建 scriptCode」——那会算出完全不同的 sighash，产出一笔
// 本地看起来正常、网络必然拒绝的交易。
//
// 三件事分开：
//   1. **识别**：从链上 raw 里按脚本形状与归属判断，不靠「看起来像」；
//   2. **保护**：登记为受保护输出，普通转账不能把它们当可用余额；
//   3. **归集**：显式的用户动作，把它们扫回自己的 P2PKH 地址。

import {
  classifyProtocolSpendResult,
  type ForumSelfOutputOutpoint,
  type ProtectedOutpointRegistry,
  type ProtocolSpendInput,
  type ProtocolSpendService,
} from "@keymaster/contracts";

import { bytesToHex, hexToBytes } from "../protocol/bytes.js";
import { parseDataOutput, parseTipOutput, DATA_OUTPUT_SATOSHIS, KIND_TIP } from "../protocol/script.js";
import { sniffDataOutput } from "../protocol/layout.js";
import { parseTransaction } from "../protocol/transaction.js";
import { sha256Digest } from "../protocol/crypto.js";

/** 受保护输出的 kind，便于诊断「谁把这笔输出锁住了」。 */
export const FORUM_SELF_OUTPUT_PROTECTION_KIND = "forum-self-outputs";

/** 自有输出的类别。 */
export type ForumSelfOutputKind = "data" | "tip";

export interface ForumSelfOutput {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly kind: ForumSelfOutputKind;
  /** 协议 kind（bsv8.reply.1 / bsv8.changetip.1 / bsv8.tip.1）。 */
  readonly scriptKind: string;
  /** 锁定脚本 hex；归集时逐字节当作 scriptCode。 */
  readonly lockingScriptHex: string;
  /** 归属公钥（小写 hex）。 */
  readonly ownerPublicKeyHex: string;
}

/** 单次归集的输出个数上限；按 200 bytes/input 估费用，超过就分批。 */
export const FORUM_SELF_OUTPUT_MAX_SWEEP_INPUTS = 50;

/** 保护 provider 的登记 id。稳定不变，便于诊断与撤销。 */
export const FORUM_SELF_OUTPUT_PROTECTION_ID = "forum-self-outputs";

export interface ForumSelfOutputDeps {
  /** 受控协议 spend：归集要签名并广播。 */
  protocolSpend(): ProtocolSpendService | undefined;
  /** 按 (network, txid) 取原始交易字节；缺席时无法识别，因此保护与归集都不可用。 */
  getRawTransaction(network: "main" | "test", txid: string, signal?: AbortSignal): Promise<Uint8Array>;
  /** 受保护输出登记。 */
  protectedOutpoints: Pick<ProtectedOutpointRegistry, "register" | "unregister">;
  /** 当前 owner 的 P2PKH 找零地址：归集的钱回到这里。 */
  deriveOwnerAddress(ownerPublicKeyHex: string, network: "main" | "test"): Promise<string>;
}

/**
 * 从一笔交易的 raw 里挑出自有 Forum 输出。
 *
 * 判据是**逐字节**的：锁定脚本必须以当前 owner 的压缩公钥开头、以 `OP_CHECKSIG`
 * 结尾，且能被 data/tip 解析器接受。「长度像」「前缀像」都不算——认错一笔就会
 * 用错的 scriptCode 去签名。
 */
export function findSelfOwnedOutputs(input: {
  rawTxHex: string;
  network: "main" | "test";
  ownerPublicKeyHex: string;
}): readonly ForumSelfOutput[] {
  const raw = hexToBytes(input.rawTxHex.replace(/^0x/u, ""));
  const tx = parseTransaction(raw, sha256Digest);
  const owner = input.ownerPublicKeyHex.toLowerCase();
  const found: ForumSelfOutput[] = [];
  tx.outputs.forEach((output, vout) => {
    const lockingScriptHex = bytesToHex(output.lockingScript);
    const candidate = classify(output.value, output.lockingScript, owner);
    if (candidate === undefined) return;
    found.push({
      txid: bytesToHex(tx.txid),
      vout,
      value: Number(output.value),
      kind: candidate.kind,
      scriptKind: candidate.scriptKind,
      lockingScriptHex,
      ownerPublicKeyHex: owner,
    });
    void input.network;
  });
  return found;
}

function classify(
  value: bigint,
  lockingScript: Uint8Array,
  ownerPublicKeyHex: string,
): { readonly kind: ForumSelfOutputKind; readonly scriptKind: string } | undefined {
  const kind = sniffDataOutput({ value, lockingScript });
  if (kind === "reply" || kind === "changetip") {
    // 数据输出的公钥必须就是当前 owner。
    const parsed = parseDataOutput(lockingScript);
    return bytesToHex(parsed.publicKey) === ownerPublicKeyHex
      ? { kind: "data", scriptKind: parsed.kind }
      : undefined;
  }
  if (value <= 0n) return undefined;
  try {
    const tip = parseTipOutput(lockingScript, value);
    return bytesToHex(tip.parentPublicKey) === ownerPublicKeyHex
      ? { kind: "tip", scriptKind: KIND_TIP }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 归集前的强制核验。
 *
 * 这是归集唯一的数据来源：重新按 (network, txid) 取原交易，核验 raw 的 txid 与调用
 * 点名的 txid 一致，再核验 vout 存在、锁定脚本确实是当前 owner 的 data/tip 输出，
 * 最后才把**链上的金额与完整锁定脚本**交出去构造签名输入。
 *
 * 任何一项不符都整笔拒绝，不做「跳过这一个」——半笔归集会把剩下的输出留在链上，
 * 而调用方以为已经收完了。
 */
async function verifySelfOutpoints(input: {
  outpoints: readonly ForumSelfOutputOutpoint[];
  network: "main" | "test";
  ownerPublicKeyHex: string;
  getRawTransaction(network: "main" | "test", txid: string, signal?: AbortSignal): Promise<Uint8Array>;
  signal?: AbortSignal;
}): Promise<readonly ForumSelfOutput[]> {
  const owner = input.ownerPublicKeyHex.toLowerCase();
  // 同一笔交易只取一次 raw：按坐标逐个请求既是浪费，也会让链上状态在中途变化。
  const rawByTxid = new Map<string, Uint8Array>();
  const verified: ForumSelfOutput[] = [];
  for (const outpoint of input.outpoints) {
    if (!/^[0-9a-f]{64}$/u.test(outpoint.txid)) {
      throw new Error(`归集坐标的 txid 不是规范小写 hex：${outpoint.txid}`);
    }
    if (!Number.isInteger(outpoint.vout) || outpoint.vout < 0 || outpoint.vout >= 0x1_0000_0000) {
      throw new Error(`归集坐标的 vout 越界：${outpoint.vout}`);
    }
    let raw = rawByTxid.get(outpoint.txid);
    if (raw === undefined) {
      raw = await input.getRawTransaction(input.network, outpoint.txid, input.signal);
      rawByTxid.set(outpoint.txid, raw);
    }
    const tx = parseTransaction(raw, sha256Digest);
    // raw 必须真的就是点名的那笔交易：链数据源给错或按别处匹配都会让整笔归集花错 UTXO。
    const actualTxid = bytesToHex(tx.txid);
    if (actualTxid !== outpoint.txid) {
      throw new Error(`链数据源返回的交易不是 ${outpoint.txid}（实际 ${actualTxid}）`);
    }
    const output = tx.outputs[outpoint.vout];
    if (output === undefined) {
      throw new Error(`${outpoint.txid} 没有 vout ${outpoint.vout}`);
    }
    const value = output.value;
    // 金额必须能安全放进 number：超出安全整数范围时按链上字节算出的费用会失真。
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${outpoint.txid}:${outpoint.vout} 的金额超出安全整数范围`);
    }
    const candidate = classify(value, output.lockingScript, owner);
    if (candidate === undefined) {
      throw new Error(`${outpoint.txid}:${outpoint.vout} 不是当前 owner 的 Forum data/tip 输出，拒绝归集`);
    }
    verified.push({
      txid: actualTxid,
      vout: outpoint.vout,
      value: Number(value),
      kind: candidate.kind,
      scriptKind: candidate.scriptKind,
      lockingScriptHex: bytesToHex(output.lockingScript),
      ownerPublicKeyHex: owner,
    });
  }
  const total = verified.reduce((sum, output) => sum + output.value, 0);
  if (!Number.isSafeInteger(total)) {
    throw new Error("归集总金额超出安全整数范围");
  }
  return verified;
}

export interface ForumSelfOutputService {
  /** 列出候选交易里属于当前 owner 的 Forum 输出。 */
  list(network: "main" | "test", txids: readonly string[], signal?: AbortSignal): Promise<readonly ForumSelfOutput[]>;
  /** 登记保护；识别与登记都必须成功，否则普通转账可能把它们花掉。 */
  protect(outputs: readonly ForumSelfOutput[], network: "main" | "test"): number;
  /** 解除保护（显式动作之后）。 */
  unprotect(outputs: readonly ForumSelfOutput[]): void;
  /**
   * 结束当前会话：清空保护集合并撤掉登记。
   *
   * 锁定、切 Key 与 Scope 撤销都必须调用，否则保护会跨 owner 残留。
   */
  dispose(reason: string): void;
  /**
   * 归集：把自有输出扫回 owner 的 P2PKH 地址。
   *
   * 显式动作，不做任何自动触发。
   *
   * 花费 data 输出**不会**让帖子消失：Forum 索引跟随交易有效性，而不是「输出是否
   * 已被花费」（原需求第 9 节）。所以归集是纯粹的资产回收，不会连带删帖。
   *
   * 正因为它不删帖、只是把属于用户自己的资产扫回钱包，就更不能被自动或顺带触发：
   * 钱会真的离开链上不可见的 Forum 输出，必须由用户明确发起。
   *
   * 归集不信任调用方给的任何字段：只接受 (txid, vout)，然后重新取原交易、核验
   * txid、归属、金额与完整锁定脚本，用核验结果构造签名输入。同一坐标重复出现会
   * 让一笔交易里出现两个花同一 UTXO 的输入，那笔交易必然被拒。
   */
  sweep(input: {
    network: "main" | "test";
    /** 只给坐标；金额与锁定脚本在归集当时从链上重新取。 */
    outpoints: readonly ForumSelfOutputOutpoint[];
    feeRateSatoshisPerKb: number;
    signal?: AbortSignal;
  }): Promise<{ txid: string; rawTxHex: string; sweptSatoshis: string }>;
}

/**
 * 构造自有输出服务。
 *
 * owner 由 Vault 提供而不是调用方传入：识别与签名都绑定当前 Key，接受外部传入的
 * owner 会让旧身份的输出被当成新身份的资产。
 */
export function createForumSelfOutputService(deps: ForumSelfOutputDeps & {
  ownerPublicKeyHex(): string;
}): ForumSelfOutputService {
  const protectionId = (outpoint: string): string => `forum-self:${outpoint}`;

  const scan = async (
    network: "main" | "test",
    txids: readonly string[],
    signal?: AbortSignal,
  ): Promise<readonly ForumSelfOutput[]> => {
    const owner = deps.ownerPublicKeyHex().toLowerCase();
    const found: ForumSelfOutput[] = [];
    for (const txid of txids) {
      const raw = await deps.getRawTransaction(network, txid, signal);
      found.push(...findSelfOwnedOutputs({ rawTxHex: bytesToHex(raw), network, ownerPublicKeyHex: owner }));
    }
    return found;
  };

  /** 当前已登记的自有输出；provider 每次被询问都从这里读，不缓存快照。 */
  const protections = new Map<string, {
    txid: string;
    vout: number;
    network: "main" | "test";
    publicKeyHex: string;
    kind: ForumSelfOutput["kind"];
    scriptKind: string;
  }>();
  let providerRegistered = false;
  const listeners = new Set<() => void>();

  const notifyChanged = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const ensureProviderRegistered = (): void => {
    if (providerRegistered) return;
    deps.protectedOutpoints.register({
      id: FORUM_SELF_OUTPUT_PROTECTION_ID,
      ownerPluginId: "forum",
      listProtectedOutpoints: () => [...protections.values()].map((entry) => ({
        txid: entry.txid,
        vout: entry.vout,
        network: entry.network,
        ownerPluginId: "forum",
        publicKeyHex: entry.publicKeyHex,
        kind: FORUM_SELF_OUTPUT_PROTECTION_KIND,
        reason: `自有 Forum ${entry.kind} 输出（${entry.scriptKind}）`,
      })),
      // 注册表用这个回调刷新它的缓存；没有它，上一次登记的输出会一直留在缓存里。
      onChange: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    });
    providerRegistered = true;
  };

  return {
    list: scan,

    protect(outputs, network) {
      const owner = deps.ownerPublicKeyHex().toLowerCase();
      let count = 0;
      for (const output of outputs) {
        const outpoint = `${output.txid}:${output.vout}`;
        if (protections.has(outpoint)) continue;
        // 一条记录一次登记：registry 收的是「持续提供当前集合」的 provider，
        // 逐输出注册 provider 会在重复登记时产生多个来源同一个 outpoint 的影子记录。
        protections.set(outpoint, { txid: output.txid, vout: output.vout, network, publicKeyHex: owner, kind: output.kind, scriptKind: output.scriptKind });
        count += 1;
      }
      if (count > 0) {
        ensureProviderRegistered();
        // 注册表缓存了上一次的集合：新增输出必须通知刷新，否则普通转账仍会把它
        // 当可用余额花掉——登记成功但保护没生效是最难发现的一种失败。
        notifyChanged();
      }
      return count;
    },

    unprotect(outputs) {
      let removed = 0;
      for (const output of outputs) {
        if (protections.delete(`${output.txid}:${output.vout}`)) removed += 1;
      }
      if (removed === 0) return;
      // 集合空了就把 provider 撤掉：留着空 provider 会让诊断显示「有保护」而实际没有。
      if (protections.size === 0 && providerRegistered) {
        deps.protectedOutpoints.unregister(FORUM_SELF_OUTPUT_PROTECTION_ID);
        providerRegistered = false;
        listeners.clear();
        return;
      }
      notifyChanged();
    },

    /**
     * 会话结束时清空保护集合并撤掉 provider。
     *
     * 锁定、切 Key 与 Scope 撤销都要走这里：否则下一个 owner 会继承上一个 owner 的
     * 保护集合，而那些输出的 scriptCode 用当前密钥签不了。
     */
    dispose(reason: string) {
      if (protections.size > 0 || providerRegistered) {
        protections.clear();
        if (providerRegistered) {
          deps.protectedOutpoints.unregister(FORUM_SELF_OUTPUT_PROTECTION_ID);
          providerRegistered = false;
        }
      }
      listeners.clear();
      void reason;
    },

    async sweep(input) {
      const spend = deps.protocolSpend();
      if (spend === undefined) {
        throw new Error("P2PKH 协议资金能力不可用，无法归集自有 Forum 输出");
      }
      if (input.outpoints.length === 0) throw new Error("没有可归集的自有输出");
      if (input.outpoints.length > FORUM_SELF_OUTPUT_MAX_SWEEP_INPUTS) {
        throw new Error(`单次归集最多 ${FORUM_SELF_OUTPUT_MAX_SWEEP_INPUTS} 个输出`);
      }
      // 重复坐标会让一笔交易里出现两个花同一 UTXO 的输入。
      const seen = new Set<string>();
      for (const outpoint of input.outpoints) {
        const key = `${outpoint.txid}:${outpoint.vout}`;
        if (seen.has(key)) throw new Error(`归集列表里有重复坐标 ${key}`);
        seen.add(key);
      }
      const owner = deps.ownerPublicKeyHex().toLowerCase();
      // 关键：金额与锁定脚本全部来自链上核验结果，不接受调用方提供的值。
      const verified = await verifySelfOutpoints({
        outpoints: input.outpoints,
        network: input.network,
        ownerPublicKeyHex: owner,
        getRawTransaction: deps.getRawTransaction,
        signal: input.signal,
      });
      const total = verified.reduce((sum, output) => sum + output.value, 0);
      // 先按交易大小估费用上限；实际费用由受控无找零模式收敛。
      const feeCap = Math.max(1, Math.ceil((verified.length * 200 + 250) * input.feeRateSatoshisPerKb / 1000));
      if (total <= feeCap) throw new Error("归集金额不足以覆盖矿工费");
      const changeAddress = await deps.deriveOwnerAddress(owner, input.network);
      const inputs: ProtocolSpendInput[] = verified.map((output) => ({
        txid: output.txid,
        vout: output.vout,
        value: output.value,
        // address 不参与签名（给了 lockingScriptHex 就用它当 scriptCode），
        // 但必须是一个形状合法的占位：钱包侧仍会按地址校验输入形状。
        address: changeAddress,
        // 关键：裸公钥脚本的 scriptCode 就是锁定脚本本身，且这一份来自链上核验。
        lockingScriptHex: output.lockingScriptHex,
      }));
      const preview = await spend.prepare({
        ownerPublicKeyHex: owner,
        requestingPluginId: "forum",
        network: input.network,
        inputs,
        outputs: [{
          value: total - feeCap,
          scriptHex: p2pkhScriptHexOf(changeAddress),
          label: "forum-self-sweep",
        }],
        feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
        noChangeRule: { maxMinerFeeSatoshis: feeCap, allowZeroValueOutputs: true },
      });
      const result = await spend.submit(preview);
      const outcome = classifyProtocolSpendResult(result.status);
      if (outcome === "uncertain") {
        throw new Error(`归集交易广播结果为 ${result.status}，必须先对账原提交，不要重复归集`);
      }
      if (outcome === "not-broadcast") {
        // 明确没进网络：输出仍在链上，可以调费率重试。
        throw new Error(`归集交易被明确拒绝（${result.status}），自有输出仍在原处`);
      }
      return { txid: result.canonicalTxid ?? result.txid, rawTxHex: result.rawTxHex, sweptSatoshis: String(total - feeCap) };
    },
  };
}

/** 由 P2PKH 地址得到锁定脚本 hex；这里只做形状转换，不解析 base58 之外的语义。 */
function p2pkhScriptHexOf(address: string): string {
  // 复用 Forum 侧已有的地址编解码，避免在两处各写一份。
  const script = p2pkhScriptFromAddress(address);
  return bytesToHex(script);
}

function p2pkhScriptFromAddress(address: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = [0];
  for (const char of address) {
    let carry = ALPHABET.indexOf(char);
    if (carry < 0) throw new Error("Invalid P2PKH address character");
    for (let i = 0; i < bytes.length; i += 1) {
      const value = bytes[i]! * 58 + carry;
      bytes[i] = value & 0xff;
      carry = value >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const char of address) {
    if (char !== "1") break;
    leadingZeros += 1;
  }
  const decoded = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) decoded[decoded.length - 1 - i] = bytes[i]!;
  if (decoded.length !== 25) throw new Error("Invalid P2PKH address length");
  return Uint8Array.from([0x76, 0xa9, 0x14, ...decoded.slice(1, 21), 0x88, 0xac]);
}

export { DATA_OUTPUT_SATOSHIS };

/**
 * 会话级的自有输出服务持有者。
 *
 * 保护集合在服务实例里，因此**同一 owner 会话必须复用同一实例**：每次调用新建实例
 * 会让第二次 `protect` 重复注册 provider，而 `unprotect` 操作的是另一个空集合——
 * 表面成功，实际保护从未生效。这个持有者把「复用、owner 变更重建、会话结束清理」
 * 三件事收在一处，manifest 只负责提供依赖。
 */
export interface ForumSelfOutputSession {
  /** 当前 owner 的服务；依赖缺席或钱包锁定时返回 undefined。 */
  current(): ForumSelfOutputService | undefined;
  /** 撤销当前实例并清空保护集合；锁定、切 Key、Scope 撤销与插件卸载都要调用。 */
  dispose(reason: string): void;
}

export function createForumSelfOutputSession(deps: {
  /** 当前 owner；抛错表示钱包已锁定。 */
  currentOwner(): string;
  /** 构造服务的工厂；依赖缺席时返回 undefined。 */
  create(ownerPublicKeyHex: string): ForumSelfOutputService | undefined;
}): ForumSelfOutputSession {
  let active: { owner: string; service: ForumSelfOutputService } | undefined;
  return {
    current() {
      const owner = deps.currentOwner();
      if (active !== undefined && active.owner === owner) return active.service;
      active?.service.dispose("owner-changed");
      const service = deps.create(owner);
      // 构造不出来（链数据源或签名能力缺席）时保持「无会话」，
      // 下一次调用会重试，而不是记住一个残缺实例。
      active = service === undefined ? undefined : { owner, service };
      return service;
    },
    dispose(reason: string) {
      active?.service.dispose(reason);
      active = undefined;
    },
  };
}
