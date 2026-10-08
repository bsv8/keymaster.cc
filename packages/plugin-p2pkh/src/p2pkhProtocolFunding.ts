// P2PKH 侧的协议专用资金能力。
//
// 协议交易不能直接花钱包的大额余额：差额会变成矿工费。这里的做法是先用一笔
// **普通** P2PKH 资金准备交易（含正常找零）拆出一个金额已知的单输入专用 UTXO，
// 之后的协议交易只花这一个 UTXO 且不带找零。
//
// 关键点：
//   - 选币用既有 allocateUtxos（受保护输入已被过滤掉），因此专用资金不会被
//     普通选币重复选中；
//   - 资金准备交易提供 changeAddress，所以余额差走找零而不是矿工费；
//   - 产出的专用 UTXO 立即登记为受保护输出，普通转账不能误花；
//   - 同一个 fundingId 只对应一笔专用资金，重复准备返回同一个 UTXO。

import type {
  ProtectedOutpointRegistry,
  ProtocolDedicatedFunding,
  ProtocolDedicatedFundingState,
  ProtocolFundingService,
} from "@keymaster/contracts";
import type { ProtocolSpendService } from "@keymaster/contracts";

import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";

export interface ProtocolFundingStore {
  get(fundingId: string): Promise<ProtocolDedicatedFunding | undefined>;
  put(record: ProtocolDedicatedFunding): Promise<void>;
  delete(fundingId: string): Promise<void>;
}

/**
 * 受保护输出登记。
 *
 * 直接复用 contracts 里的 `ProtectedOutpointRegistry` 形状，而不是在这里另写一份
 * 近似类型：另写一份迟早会和真正的 provider 形状漂移。
 */
export type ProtocolFundingProtectedOutpoints = Pick<ProtectedOutpointRegistry, "register" | "unregister">;

export interface CreateProtocolFundingServiceDeps {
  /** 受控协议 spend：构造并签名资金准备交易。 */
  protocolSpend(): ProtocolSpendService | undefined;
  protectedOutpoints: ProtocolFundingProtectedOutpoints;
  store: ProtocolFundingStore;
  /** 枚举并分配钱包 UTXO；金额单位为 number，越界必须由调用方拒绝。 */
  allocate(input: { assetId: "bsv" | "bsvtest"; amountSatoshis: number; feeReserveSatoshis: number }): Promise<{
    selected: { txid: string; vout: number; value: number; address: string }[];
    totalInputSatoshis: number;
  }>;
  /** 派发后观察一笔已广播交易的链上状态。 */
  observeChain(network: "main" | "test", txid: string): Promise<ProtocolDedicatedFundingState>;
  /** 由 Vault 派生的当前 owner 找零地址。 */
  deriveChangeAddress(ownerPublicKeyHex: string, network: "main" | "test"): Promise<string>;
}

export const PROTOCOL_FUNDING_PROTECTION_KIND = "protocol-dedicated-funds";

export function createProtocolFundingService(deps: CreateProtocolFundingServiceDeps): ProtocolFundingService {
  const protectionId = (fundingId: string): string => `protocol-funding:${fundingId}`;

  return {
    async prepareDedicatedFunding(input) {
      const required = parseAmount(input.requiredSatoshis, "requiredSatoshis");
      // 同一个编号只允许一笔专用资金：第二次调用返回同一笔，而不是再拆一次钱。
      const existing = await deps.store.get(input.fundingId);
      if (existing !== undefined) return existing;

      const spend = deps.protocolSpend();
      if (spend === undefined) throw new Error("P2PKH 协议资金能力不可用");
      const assetId = assetIdFor(input.network);
      // 资金准备交易本身的矿工费预算：按输出规模估，真实费率由 spend 收敛。
      // 资金准备交易自身的矿工费预算：按输出规模估，再加一笔常数余量。
      const feeReserveSatoshis = toSafeNumber((required + 999n) / 1000n) + 500;
      const allocation = await deps.allocate({
        assetId,
        amountSatoshis: toSafeNumber(required),
        feeReserveSatoshis,
      });
      if (allocation.selected.length === 0) throw new Error("没有可用于准备专用资金的 UTXO");

      const changeAddress = await deps.deriveChangeAddress(input.ownerPublicKeyHex, input.network);
      // 专用 UTXO 是本交易自己的 vout 0 P2PKH 输出，收款地址就是当前 owner 的地址。
      const dedicatedAddress = changeAddress;
      const dedicatedScriptHex = p2pkhAddressToScriptHex(dedicatedAddress, input.network);
      const preview = await spend.prepare({
        ownerPublicKeyHex: input.ownerPublicKeyHex,
        requestingPluginId: "forum",
        network: input.network,
        inputs: allocation.selected.map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          value: requireSafeNumber(utxo.value, `准备资金输入 ${utxo.txid}:${utxo.vout}`),
          address: utxo.address,
        })),
        outputs: [{ value: toSafeNumber(required), scriptHex: dedicatedScriptHex, label: "protocol-dedicated-funding" }],
        feeRateSatoshisPerKb: input.feeRateSatoshisPerKb,
        // 余额差走找零：没有 changeAddress 时 spend 会拒绝把余款当矿工费。
        changeAddress,
      });
      const result = await spend.submit(preview);

      const record: ProtocolDedicatedFunding = {
        fundingId: input.fundingId,
        txid: result.canonicalTxid ?? result.txid,
        vout: 0,
        rawTxHex: result.rawTxHex,
        valueSatoshis: input.requiredSatoshis,
        address: dedicatedAddress,
        ...(result.submissionId ?? preview.submissionId ? { submissionId: result.submissionId ?? preview.submissionId } : {}),
      };
      await deps.store.put(record);
      // 专用 UTXO 必须挡住普通选币：否则它会被普通转账当成可用余额花掉。
      deps.protectedOutpoints.register({
        id: protectionId(input.fundingId),
        ownerPluginId: input.ownerPluginId ?? "protocol",
        listProtectedOutpoints: () => [{
          txid: record.txid,
          vout: record.vout,
          network: input.network,
          ownerPluginId: input.ownerPluginId ?? "protocol",
          publicKeyHex: input.ownerPublicKeyHex,
          kind: PROTOCOL_FUNDING_PROTECTION_KIND,
          reason: input.protectionReason ?? `协议专用资金 ${input.fundingId}`,
        }],
      });
      return record;
    },

    async observeDedicatedFunding(input) {
      const record = await deps.store.get(input.fundingId);
      // 记录必须对上 outpoint，否则不返回猜测状态。
      if (record === undefined || record.txid !== input.txid || record.vout !== input.vout) return "unknown";
      return deps.observeChain(input.network, input.txid);
    },

    async releaseDedicatedFunding(input) {
      const spend = deps.protocolSpend();
      const record = await deps.store.get(input.fundingId);
      if (record === undefined) return;
      // 只在明确未派发时释放：已广播或未知的输入不得提前放开。
      if (spend?.releasePreparedSubmission !== undefined && record.submissionId !== undefined) {
        await spend.releasePreparedSubmission({
          ownerPublicKeyHex: input.ownerPublicKeyHex,
          network: input.network,
          txid: record.txid,
          submissionId: record.submissionId,
        });
      }
      await deps.store.delete(input.fundingId);
      deps.protectedOutpoints.unregister(protectionId(input.fundingId));
    },
  };
}

/** 资产 id 与网络的映射；P2PKH 的资产维度是 bsv/bsvtest 而不是资源 id。 */
function assetIdFor(network: "main" | "test"): "bsv" | "bsvtest" {
  return network === "test" ? "bsvtest" : "bsv";
}

function parseAmount(value: string, label: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${label} 必须是规范十进制 uint64`);
  const parsed = BigInt(value);
  if (parsed > 0xffffffffffffffffn) throw new Error(`${label} 超过 uint64 上限`);
  return parsed;
}

/** bigint → 钱包 number，越过安全整数明确拒绝。 */
function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`金额 ${value} 超出钱包安全整数范围，拒绝截断`);
  }
  return Number(value);
}

function requireSafeNumber(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} 必须是安全非负整数，实际 ${value}`);
  return value;
}