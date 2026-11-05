import { signMixedInputs } from "./p2pkhSigner.js";
// P2PKH 协议 spend：受控签名 + 广播任意输出计划。

import type {
  BsvNetwork,
  ProtocolSpendInput,
  ProtocolSpendOutput,
  ProtocolSpendExecutionInput,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  P2pkhProtocolExecutor,
  ProtectedOutpointStore,
  CentralBroadcastService,
  VaultService
} from "@keymaster/contracts";
import { isDefinitelyNotDispatchedBroadcastError } from "@keymaster/contracts";
import type { P2pkhProtocolSubmission } from "./p2pkhContracts.js";
import {
  calcTxidFromRawTxHex,
  pubKeyHash160Hex,
  rawTxHexByteLength,
  serializeTx,
  type UnsignedTx,
} from "./p2pkhSigner.js";
import { resourceIdFor } from "./storage/p2pkhStateRepository.js";
import { p2pkhAddressToScriptHex } from "./p2pkhTransactionParser.js";
import { unsignedFromExact, type P2pkhSubmissionRuntime, type SubmissionPlan } from "./p2pkhSubmissionRuntime.js";
import type { P2pkhFundingAllocation, FundingIdentity } from "./p2pkhUtxoManager.js";

// value 必须随协议 claim 一起写入，供协议资产自身的审计与恢复使用；
// 普通 P2PKH 余额不读取这些 claim，避免把协议资产保护混入 P2PKH 选币。
type P2pkhInputOutpoint = Pick<ProtocolSpendInput, "txid" | "vout" | "value">;

export interface P2pkhProtocolSpendClaimStore {
  tryClaimInputs(input: {
    submissionId: string;
    resourceId: string;
    publicKeyHex: string;
    network: BsvNetwork;
    inputs: P2pkhInputOutpoint[];
    expectedCanonicalTxid?: string;
    observation?: "unconfirmed" | "confirmed";
  }): Promise<{ claimIds: string[] }>;
  releaseLocalInputClaims(input: { publicKeyHex: string; claimIds: string[] }): Promise<void>;
}

export interface P2pkhProtocolSpendSubmissionStore {
  getProtocolSubmission(input: { publicKeyHex: string; id: string }): Promise<P2pkhProtocolSubmission | undefined>;
  putProtocolSubmission(record: P2pkhProtocolSubmission): Promise<void>;
}

/**
 * Runtime allocation port for protocol callers. The pool only freezes wallet
 * inputs; protocol validation, signing and submission belong to this service.
 */
export interface P2pkhProtocolManagerPort {
  assertAllocationUsable(input: FundingIdentity & {allocationId: string}): Promise<void>;
  release(input: FundingIdentity & {allocationId: string}): Promise<void>;
}

export interface P2pkhProtocolSpendDeps {
  vault: Pick<VaultService, "status" | "createActiveKeyCrypto">;
  /** 生产广播入口；协议 spend 不直接依赖 WOC 或其它 Provider。 */
  centralBroadcastService?: CentralBroadcastService;
  getKeyForOwner: (ownerPublicKeyHex: string) => Promise<{ publicKeyHex: string }>;
  claimStore: P2pkhProtocolSpendClaimStore;
  submissionStore?: P2pkhProtocolSpendSubmissionStore;
  protectedOutpoints?: ProtectedOutpointStore;
  /** Shared runtime wallet-input allocation pool. */
  protocolManager?: P2pkhProtocolManagerPort;
  submissions: P2pkhSubmissionRuntime;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The wallet's own P2PKH locking script, derived from the owner public key. */
function p2pkhScriptForPublicKey(publicKeyHex: string): string {
  return `76a914${pubKeyHash160Hex(publicKeyHex).toLowerCase()}88ac`;
}

function isP2pkhLockingScript(script: Uint8Array): boolean {
  return script.length === 25 && script[0] === 0x76 && script[1] === 0xa9 && script[2] === 0x14 && script[23] === 0x88 && script[24] === 0xac;
}

function isOwnerBarePubkeyLockingScript(script: Uint8Array, ownerPublicKeyHex: string): boolean {
  if (script.length !== 35 || script[0] !== 33 || script[34] !== 0xac) return false;
  const owner = hexToBytes(ownerPublicKeyHex);
  for (let i = 0; i < 33; i++) if (script[1 + i] !== owner[i]) return false;
  return true;
}

function buildUnsignedTx(
  inputs: ProtocolSpendInput[],
  outputs: ProtocolSpendOutput[],
  changeAddress: string | undefined,
  changeSatoshis: number
): UnsignedTx {  const txInputs = inputs.map((u) => ({
    prevTxid: u.txid,
    prevVout: u.vout,
    scriptSig: new Uint8Array(0),
    sequence: 0xfffffffe
  }));
  const txOutputs = [
    ...outputs.map((o) => ({ value: o.value, script: hexToBytes(o.scriptHex) })),
    ...(changeAddress && changeSatoshis > 0
      ? [{ value: changeSatoshis, script: hexToBytes(p2pkhAddressToScriptHex(changeAddress)) }]
      : [])
  ];
  return { version: 1, inputs: txInputs, outputs: txOutputs, lockTime: 0 };
}

async function resolveOwnerKeyIdentity(
  deps: P2pkhProtocolSpendDeps,
  ownerPublicKeyHex: string
): Promise<{ publicKeyHex: string }> {
  const key = await deps.getKeyForOwner(ownerPublicKeyHex);
  if (!key.publicKeyHex) {
    throw new Error(`P2PKH protocol spend: owner ${ownerPublicKeyHex} is not ready`);
  }
  if (key.publicKeyHex !== ownerPublicKeyHex) {
    throw new Error(`P2PKH protocol spend: resolved key ${key.publicKeyHex} != ${ownerPublicKeyHex}`);
  }
  return key;
}

function buildProtocolSubmissionRecord(input: {
  submissionId: string;
  resourceId: string;
  publicKeyHex: string;
  network: BsvNetwork;
  canonicalTxid: string;
  inputs: Array<{ txid: string; vout: number }>;
  protectedClaimIds: string[];
  localInputClaimIds: string[];
  status: P2pkhProtocolSubmission["status"];
  observation?: "unconfirmed" | "confirmed";
  droppedReason?: string;
  createdAt?: string;
}): P2pkhProtocolSubmission {
  const now = new Date().toISOString();
  return {
    id: input.submissionId,
    resourceId: input.resourceId,
    publicKeyHex: input.publicKeyHex,
    network: input.network,
    submissionId: input.submissionId,
    canonicalTxid: input.canonicalTxid,
    inputs: input.inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
    protectedClaimIds: [...input.protectedClaimIds],
    localInputClaimIds: [...input.localInputClaimIds],
    status: input.status,
    observation: input.observation,
    droppedReason: input.droppedReason,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  };
}

export function createP2pkhProtocolSpendService(deps: P2pkhProtocolSpendDeps): P2pkhProtocolExecutor {
  const submissionTails = new Map<string, Promise<void>>();
  async function serializeSubmissionOperation<T>(submissionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = submissionTails.get(submissionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    submissionTails.set(submissionId, queued);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (submissionTails.get(submissionId) === queued) submissionTails.delete(submissionId);
    }
  }

  const tickets=new Map<string,{input:ProtocolSpendExecutionInput;expires:number}>();
  const build=async(input:ProtocolSpendExecutionInput,sign:boolean):Promise<ProtocolSpendPreview>=>{
      if (!deps.protocolManager) throw new Error("Protocol spend requires the runtime UTXO allocation pool");
      let protectedClaimIds: string[] = [];
      let inputClaimIds: string[] = [];
      let submissionId: string = crypto.randomUUID();
      const scope = {ownerPublicKeyHex: input.ownerPublicKeyHex, network: input.network};
      let originalPlan: SubmissionPlan | undefined;
      let managerAllocationId: string | undefined;
      // 放在 try 之前：签名闭包要读它，而闭包定义在 owner 解析之前。
      const resolvedOwner = await resolveOwnerKeyIdentity(deps, input.ownerPublicKeyHex);

      /**
       * 签名 + 占用输入 + 落盘预签名记录。
       *
       * 两条路径（按费率迭代的找零模式与无找零模式）共用这一段：它们只在费用怎么
       * 算出来上不同，签名、输入占用与写前日志的顺序必须完全一致。
       */
      const signAndRecord = async (plan: {
        inputs: ProtocolSpendInput[];
        outputs: ProtocolSpendOutput[];
        unsignedTxHex?: string;
        changeAddress: string | undefined;
        changeSatoshis: number;
        feeSatoshis: number;
        /** 费率型授权（rate）还是已确认的固定费用（exact）。 */
        feePolicy: "rate" | "exact";
        /** 裸公钥单签输入的锁定脚本；按输入顺序给出，缺省项按 P2PKH 处理。 */
        lockingScripts?: readonly (string | undefined)[];
      }): Promise<ProtocolSpendPreview> => {
        if (input.maxFeeSatoshis !== undefined && plan.feeSatoshis > input.maxFeeSatoshis) throw new Error("Protocol miner fee exceeds business cap");
        if (plan.outputs.some(row => row.value < 0 || (row.value === 0 && input.noChangeRule?.allowZeroValueOutputs !== true))) throw new Error("Output value violates protocol zero-value policy");
        if (input.noChangeRule && (plan.changeSatoshis > 0 || plan.feeSatoshis > input.noChangeRule.maxMinerFeeSatoshis)) throw new Error("Original funding layout violates no-change budget");
        const unsigned = plan.unsignedTxHex ? unsignedFromExact(plan.unsignedTxHex) : buildUnsignedTx(plan.inputs, plan.outputs, plan.changeAddress, plan.changeSatoshis);
        if(!sign){
          const now=Date.now();for(const [id,t] of tickets)if(t.expires<=now)tickets.delete(id);
          if(tickets.size>=32)throw Error("Too many pending protocol previews");
          const rawTxHex=Array.from(serializeTx(unsigned),b=>b.toString(16).padStart(2,"0")).join("");
          const preview:ProtocolSpendPreview={previewId:crypto.randomUUID(),ownerPublicKeyHex:resolvedOwner.publicKeyHex,requestingPluginId:input.requestingPluginId,network:input.network,
            inputs:structuredClone(plan.inputs),outputs:structuredClone(plan.outputs),...(plan.changeAddress===undefined?{}:{changeAddress:plan.changeAddress}),changeSatoshis:plan.changeSatoshis,
            estimatedFeeSatoshis:plan.feeSatoshis,serializedSizeBytes:serializeTx(unsigned).length+plan.inputs.reduce((n,u)=>n+(u.lockingScriptHex===undefined?108:74),0),txid:"",rawTxHex};
          tickets.set(preview.previewId!,{input:structuredClone(input),expires:now+120000});return preview;
        }
        if (!originalPlan) {
          originalPlan = {...scope, submissionId, unsignedTxHex: Array.from(serializeTx(unsigned), b => b.toString(16).padStart(2, "0")).join(""),
            inputs: plan.inputs, outputs: plan.outputs, feeSatoshis: plan.feeSatoshis, feeRateSatoshisPerKb: input.feeRateSatoshisPerKb, changeSatoshis: plan.changeSatoshis,
            ...(plan.changeAddress ? {changeAddress: plan.changeAddress} : {})};
          deps.submissions.prepare(originalPlan);
        }
        // 无审批直签：按实际输入锁定脚本选择 scriptCode/解锁结构（P2PKH 缺省，裸公钥按脚本本身）。
        const activeCrypto = await deps.vault.createActiveKeyCrypto();
        const signingInputs = plan.inputs.map((utxo, index) => {
          const lockingHex = plan.lockingScripts?.[index];
          if (lockingHex === undefined) {
            return { scriptCode: hexToBytes(p2pkhScriptForPublicKey(resolvedOwner.publicKeyHex)), value: utxo.value, pushPublicKeyInUnlock: true };
          }
          const script = hexToBytes(lockingHex);
          if (isP2pkhLockingScript(script)) return { scriptCode: script, value: utxo.value, pushPublicKeyInUnlock: true };
          if (isOwnerBarePubkeyLockingScript(script, resolvedOwner.publicKeyHex)) return { scriptCode: script, value: utxo.value, pushPublicKeyInUnlock: false };
          throw new Error("Unsupported protocol input locking script");
        });
        deps.submissions.beginSigning({...scope, submissionId});
        const rawTxHex = await signMixedInputs(
          unsigned,
          signingInputs,
          async (digest) => {
            const result = await activeCrypto.signDigest({ digest: new Uint8Array(digest).buffer as ArrayBuffer, format: "der" });
            return new Uint8Array(result.signature);
          },
          { publicKey: Uint8Array.from(Buffer.from(resolvedOwner.publicKeyHex, "hex")) },
        );
        deps.submissions.signed({...scope, submissionId, rawTxHex});
        const serializedSizeBytes = rawTxHexByteLength(rawTxHex);
        if (managerAllocationId && plan.feeSatoshis < Math.ceil(serializedSizeBytes * originalPlan.feeRateSatoshisPerKb / 1000)) throw new Error("Signed protocol size exceeds original funding fee");

        if (deps.submissionStore) {
          await deps.submissionStore.putProtocolSubmission(buildProtocolSubmissionRecord({
            submissionId,
            resourceId: resourceIdFor(input.network),
            publicKeyHex: resolvedOwner.publicKeyHex,
            network: input.network,
            canonicalTxid: calcTxidFromRawTxHex(rawTxHex),
            inputs: plan.inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
            protectedClaimIds,
            localInputClaimIds: inputClaimIds,
            status: "prepared"
          }));
        }
        return {
          ownerPublicKeyHex: resolvedOwner.publicKeyHex,
          requestingPluginId: input.requestingPluginId,
          network: input.network,
          inputs: plan.inputs,
          outputs: plan.outputs,
          ...(plan.changeAddress === undefined ? {} : { changeAddress: plan.changeAddress }),
          changeSatoshis: plan.changeSatoshis,
          estimatedFeeSatoshis: plan.feeSatoshis,
          serializedSizeBytes,
          txid: calcTxidFromRawTxHex(rawTxHex),
          rawTxHex,
          protectedClaimIds,
          inputClaimIds,
          submissionId,
          managerAllocationId,

        };
      };

      try {
        if (input.managerAllocationId) {
          // The original funding request owns the input/output plan. Caller
          // display fields cannot replace it or force a different change layout.
          const planned = deps.submissions.preparedForAllocation({...scope, allocationId: input.managerAllocationId});
          await deps.protocolManager!.assertAllocationUsable({...scope, allocationId: input.managerAllocationId});
          if (sign) {originalPlan = planned; submissionId = planned.submissionId; managerAllocationId = planned.allocationId;}
          return await signAndRecord({inputs: planned.inputs, outputs: planned.outputs, unsignedTxHex: planned.unsignedTxHex,
            changeAddress: planned.changeAddress, changeSatoshis: planned.changeSatoshis, feeSatoshis: planned.feeSatoshis,
            feePolicy: "rate", lockingScripts: planned.inputs.map(row => row.lockingScriptHex)});
        }
        const walletScriptHex = p2pkhScriptForPublicKey(resolvedOwner.publicKeyHex);
        if (sign && input.inputs.some(item => (item.lockingScriptHex ?? p2pkhAddressToScriptHex(item.address, input.network)).toLowerCase() === walletScriptHex)) {
          throw new Error("Wallet inputs require prior manager funding selection");
        }
        if (deps.protectedOutpoints) {
          const hasProtectedInputs = input.inputs.some((u) => deps.protectedOutpoints?.isProtected({
            txid: u.txid,
            vout: u.vout,
            network: input.network,
            publicKeyHex: input.ownerPublicKeyHex
          }));
          if (hasProtectedInputs && !input.requestingPluginId) {
            throw new Error("Protocol spend requires requestingPluginId for protected inputs");
          }
          if (sign && input.requestingPluginId) {
            protectedClaimIds = (await deps.protectedOutpoints.claimProtectedInputs({
              ownerPluginId: input.requestingPluginId,
              publicKeyHex: input.ownerPublicKeyHex,
              network: input.network,
              inputs: input.inputs.map((u) => ({ txid: u.txid, vout: u.vout }))
            })).claimIds;
          }
        }
        const noChangeRule = input.noChangeRule;
        if (noChangeRule !== undefined && input.changeAddress !== undefined) {
          // 受控无找零与找零互斥：同时给出就意味着调用方自己也不确定要哪种布局，
          // 这里拒绝而不是猜一个。
          throw new Error("Protocol spend accepts either changeAddress or noChangeRule, not both");
        }
        const inputs = input.inputs.map((u) => ({
          id: `${u.txid}:${u.vout}`,
          resourceId: "protocol-spend",
          publicKeyHex: resolvedOwner.publicKeyHex,
          network: input.network,
          status: "confirmed" as const,
          isSpentInMempoolTx: false,
          syncedAt: new Date().toISOString(),
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          address: u.address
        }));
        const outputs = input.outputs.map((o) => ({
          value: o.value,
          scriptHex: o.scriptHex,
          label: o.label
        }));
        const totalInput = inputs.reduce((sum, u) => sum + u.value, 0);
        const fixedOutput = outputs.reduce((sum, o) => sum + o.value, 0);
        if (noChangeRule !== undefined) {
          // 无找零：余额差必须精确成为矿工费，不能是 0（那是无效交易），
          // 也不能超过用户确认的预算。这条路径不需要按费率迭代：没有找零输出，
          // 交易大小不再反过来改变费用。
          const feeSatoshis = totalInput - fixedOutput;
          if (feeSatoshis <= 0) {
            throw new Error(`Protocol spend failed: insufficient inputs (${totalInput}) for outputs (${fixedOutput})`);
          }
          if (feeSatoshis > noChangeRule.maxMinerFeeSatoshis) {
            throw new Error(
              `Protocol spend requires a larger miner fee (${feeSatoshis}) than the confirmed budget (${noChangeRule.maxMinerFeeSatoshis})`
            );
          }
          return await signAndRecord({
            inputs,
            outputs,
            changeAddress: undefined,
            changeSatoshis: 0,
            feeSatoshis,
            feePolicy: "exact",
            // 裸公钥脚本的输入必须按自己的 scriptCode 签：传给签名器。
            lockingScripts: input.inputs.map((u) => u.lockingScriptHex),
          });
        }
        let feeSatoshis = 1;
        for (let round = 0; round < 12; round++) {
          const changeSatoshis = totalInput - fixedOutput - feeSatoshis;
          if (changeSatoshis < 0) {
            throw new Error(`Protocol spend failed: insufficient inputs (${totalInput}) for outputs (${fixedOutput}) and fee (${feeSatoshis})`);
          }
          if (!input.changeAddress && changeSatoshis > 0) {
            throw new Error("Protocol spend requires changeAddress when inputs exceed outputs + fee");
          }
          const unsigned = buildUnsignedTx(inputs, outputs, input.changeAddress, changeSatoshis);
          // DER 长度不再驱动真实签名迭代；使用每输入解锁脚本上界求稳定费用。
          const serializedSizeBytes = serializeTx(unsigned).length + inputs.reduce((n, _u, i) => n + (input.inputs[i]?.lockingScriptHex === undefined ? 108 : 74), 0);
          const nextFee = Math.max(1, Math.ceil((serializedSizeBytes * input.feeRateSatoshisPerKb) / 1000));
          // Changing change changes the signature digest and DER length. Exact
          // equality can alternate forever between adjacent fee values. A fee
          // already covering the signed size is sufficient; never lower it and
          // re-enter that cycle. Output values and no-change budgets stay fixed.
          if (nextFee <= feeSatoshis) {
            return await signAndRecord({
              inputs,
              outputs,
              changeAddress: input.changeAddress,
              changeSatoshis,
              feeSatoshis,
              feePolicy: "rate",
              lockingScripts: input.inputs.map((u) => u.lockingScriptHex),
            });
          }
          feeSatoshis = nextFee;
        }
        throw new Error("Protocol spend fee failed to converge");
      } catch (err) {
        // build never broadcasts. Seal any failed signing attempt before
        // release; signed() rejects a late result for this cancelled intention.
        if (originalPlan) {
          deps.submissions.cancelUndispatched({...scope, submissionId});
          if (managerAllocationId) await deps.protocolManager!.release({...scope, allocationId: managerAllocationId});
        }
        if (protectedClaimIds.length > 0 && deps.protectedOutpoints) {
          await deps.protectedOutpoints.releaseClaims(protectedClaimIds);
        }
        if (inputClaimIds.length > 0) {
          await deps.claimStore.releaseLocalInputClaims({
            publicKeyHex: input.ownerPublicKeyHex,
            claimIds: inputClaimIds
          });
        }
        throw err;
      }
    };
  return {
    prepare:input=>build(input,false),
    presign:input=>build(input,true),
    async releasePrepared(preview): Promise<void> {
      if (preview.previewId) {
        const ticket = tickets.get(preview.previewId); tickets.delete(preview.previewId);
        if (ticket?.input.managerAllocationId) {
          const scope = {ownerPublicKeyHex: ticket.input.ownerPublicKeyHex, network: ticket.input.network};
          const plan = deps.submissions.preparedForAllocation({...scope, allocationId: ticket.input.managerAllocationId});
          if (deps.submissions.cancelUnsigned({...scope, submissionId: plan.submissionId})) await deps.protocolManager!.release({...scope, allocationId: ticket.input.managerAllocationId});
        }
        return;
      }
      const submissionId = preview.submissionId;
      if (!submissionId || !deps.submissionStore) throw new Error("Prepared protocol spend has no durable submission record");
      await serializeSubmissionOperation(submissionId, async () => {
        await resolveOwnerKeyIdentity(deps, preview.ownerPublicKeyHex);
        if (calcTxidFromRawTxHex(preview.rawTxHex) !== preview.txid) throw new Error("Prepared protocol spend txid does not match its raw bytes");
        const existing = await deps.submissionStore!.getProtocolSubmission({ publicKeyHex: preview.ownerPublicKeyHex, id: submissionId });
        if (!existing
          || (existing.status !== "prepared" && existing.status !== "rejected")
          || existing.canonicalTxid !== preview.txid
          || existing.network !== preview.network
          || existing.resourceId !== resourceIdFor(preview.network)
          || existing.inputs.length !== preview.inputs.length
          || existing.inputs.some((input, index) => input.txid !== preview.inputs[index]?.txid || input.vout !== preview.inputs[index]?.vout)) {
          throw new Error("Only a matching undispatched protocol spend can be released");
        }
        const scope = {ownerPublicKeyHex: preview.ownerPublicKeyHex, network: preview.network, submissionId};
        const active = deps.submissions.find(scope);
        const plan = active ? deps.submissions.cancelUndispatched(scope) : undefined;
        const protectedClaimIds = existing.protectedClaimIds;
        const inputClaimIds = existing.localInputClaimIds;
        if (existing.status === "prepared") {
          // 先封住后续 submit，再解除输入 claim；写盘失败时资金仍保持占用。
          await deps.submissionStore!.putProtocolSubmission(buildProtocolSubmissionRecord({
            submissionId,
            resourceId: resourceIdFor(preview.network),
            publicKeyHex: preview.ownerPublicKeyHex,
            network: preview.network,
            canonicalTxid: preview.txid,
            inputs: existing.inputs,
            protectedClaimIds,
            localInputClaimIds: inputClaimIds,
            status: "rejected",
            droppedReason: "prepared-spend-released",
            createdAt: existing.createdAt,
          }));
        }
        if (plan?.allocationId) await deps.protocolManager!.release({...scope, allocationId: plan.allocationId});
        if (protectedClaimIds.length > 0 && deps.protectedOutpoints) {
          await deps.protectedOutpoints.releaseClaims(protectedClaimIds);
        }
        if (inputClaimIds.length > 0) {
          await deps.claimStore.releaseLocalInputClaims({ publicKeyHex: preview.ownerPublicKeyHex, claimIds: inputClaimIds });
        }
      });
    },

    async releasePreparedSubmission(input): Promise<void> {
      const submissionId = input.submissionId;
      if (!submissionId || !deps.submissionStore) throw new Error("Prepared protocol submission has no durable record");
      await serializeSubmissionOperation(submissionId, async () => {
        await resolveOwnerKeyIdentity(deps, input.ownerPublicKeyHex);
        const existing = await deps.submissionStore!.getProtocolSubmission({ publicKeyHex: input.ownerPublicKeyHex, id: submissionId });
        if (!existing
          || (existing.status !== "prepared" && existing.status !== "rejected")
          || existing.submissionId !== submissionId
          || existing.canonicalTxid !== input.txid
          || existing.network !== input.network
          || existing.publicKeyHex.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()
          || existing.resourceId !== resourceIdFor(input.network)) {
          throw new Error("Only a matching definitely undispatched protocol submission can be released");
        }
        const scope = {ownerPublicKeyHex: input.ownerPublicKeyHex, network: input.network, submissionId};
        const active = deps.submissions.find(scope);
        const plan = active ? deps.submissions.cancelUndispatched(scope) : undefined;
        if (existing.status === "prepared") {
          // 先持久化拒绝状态，之后即使释放过程被中断也不能再提交原交易。
          await deps.submissionStore!.putProtocolSubmission(buildProtocolSubmissionRecord({
            submissionId,
            resourceId: resourceIdFor(input.network),
            publicKeyHex: input.ownerPublicKeyHex,
            network: input.network,
            canonicalTxid: input.txid,
            inputs: existing.inputs,
            protectedClaimIds: existing.protectedClaimIds,
            localInputClaimIds: existing.localInputClaimIds,
            status: "rejected",
            droppedReason: "prepared-spend-released",
            createdAt: existing.createdAt,
          }));
        }
        if (plan?.allocationId) await deps.protocolManager!.release({...scope, allocationId: plan.allocationId});
        if (existing.protectedClaimIds.length > 0 && deps.protectedOutpoints) {
          await deps.protectedOutpoints.releaseClaims(existing.protectedClaimIds);
        }
        if (existing.localInputClaimIds.length > 0) {
          await deps.claimStore.releaseLocalInputClaims({ publicKeyHex: input.ownerPublicKeyHex, claimIds: existing.localInputClaimIds });
        }
      });
    },

    async submit(preview): Promise<ProtocolSpendResult> {
      if(preview.previewId){
        const ticket=tickets.get(preview.previewId);
        if(!ticket||ticket.expires<=Date.now()){tickets.delete(preview.previewId);throw Error("Protocol preview expired or already submitted");}
        tickets.delete(preview.previewId);
        // The ticket owns the original plan. Re-evaluate current protection
        // and external prevouts at signing; display metadata is not a plan.
        preview=await build(ticket.input,true);
      }
      if (!preview.managerAllocationId || !preview.submissionId) throw new Error("Protocol submission requires a current runtime allocation and original submission");
      const retained = deps.submissions.read({ownerPublicKeyHex: preview.ownerPublicKeyHex, network: preview.network, submissionId: preview.submissionId});
      if (!retained.txid || !retained.rawTxHex) throw new Error("Protocol transaction has not completed signing");
      preview = {...preview, inputs: retained.plan.inputs, outputs: retained.plan.outputs, txid: retained.txid, rawTxHex: retained.rawTxHex,
        managerAllocationId: retained.plan.allocationId, changeAddress: retained.plan.changeAddress, changeSatoshis: retained.plan.changeSatoshis,
        estimatedFeeSatoshis: retained.plan.feeSatoshis};
      const submissionIdForLock = retained.plan.submissionId;
      return serializeSubmissionOperation(submissionIdForLock, async () => {
      if (preview.submissionId && deps.submissionStore) {
        const existing = await deps.submissionStore.getProtocolSubmission({
          publicKeyHex: preview.ownerPublicKeyHex,
          id: preview.submissionId,
        });
        if (!existing || existing.canonicalTxid !== preview.txid || existing.status === "rejected") {
          throw new Error("Protocol spend is missing, mismatched, or already released");
        }
      }
      try {
        let canonicalTxid = preview.txid;
        let providerReturnedTxidRaw: string | undefined;
        let providerReturnedTxidNormalized: string | undefined;
        let txidIntegrity: "exact" | "reversed" | "mismatch" | "missing" | undefined;
        let isolated = false;
        if (deps.centralBroadcastService) {
          const result = await deps.centralBroadcastService.submitOnce({
            ownerPublicKeyHex: preview.ownerPublicKeyHex,
            network: preview.network,
            submissionId: preview.submissionId ?? crypto.randomUUID(),
            resourceId: resourceIdFor(preview.network),
            txid: preview.txid,
            rawTxHex: preview.rawTxHex,
            ...(preview.utxoBinding === undefined ? {} : { utxoBinding: preview.utxoBinding }),
            ...(preview.managerAllocationId === undefined ? {} : { managerAllocationId: preview.managerAllocationId }),
          });
          if (result.status === "isolated" && result.providerCode !== "woc-tx-rejected") {
            isolated = true;
            canonicalTxid = result.canonicalTxid ?? preview.txid;
            providerReturnedTxidRaw = result.providerReturnedTxidRaw;
            providerReturnedTxidNormalized = result.providerReturnedTxidNormalized;
            txidIntegrity = result.txidIntegrity;
          } else if (result.status === "not-dispatched" || (result.status === "isolated" && result.providerCode === "woc-tx-rejected")) {
            // 中文：Worker 已明确证明未派发时，协议输入占用和保护 claim
            // 必须在这里立即释放；不能把它当成 unknown 留到后台观察。
            const existing = deps.submissionStore && preview.submissionId
              ? await deps.submissionStore.getProtocolSubmission({ publicKeyHex: preview.ownerPublicKeyHex, id: preview.submissionId })
              : undefined;
            const protectedClaimIds = preview.protectedClaimIds && preview.protectedClaimIds.length > 0
              ? preview.protectedClaimIds
              : existing?.protectedClaimIds ?? [];
            const inputClaimIds = preview.inputClaimIds && preview.inputClaimIds.length > 0
              ? preview.inputClaimIds
              : existing?.localInputClaimIds ?? [];
            if (protectedClaimIds.length > 0 && deps.protectedOutpoints) {
              await deps.protectedOutpoints.releaseClaims(protectedClaimIds);
            }
            if (inputClaimIds.length > 0) {
              await deps.claimStore.releaseLocalInputClaims({ publicKeyHex: preview.ownerPublicKeyHex, claimIds: inputClaimIds });
            }
            const scope = {ownerPublicKeyHex: preview.ownerPublicKeyHex, network: preview.network, submissionId: preview.submissionId!};
            if (deps.submissions.read(scope).state !== "rejected") await this.releasePreparedSubmission({...scope, txid: preview.txid});
            return {
              status: "rejected",
              txid: preview.txid,
              rawTxHex: preview.rawTxHex,
              inputClaimIds,
              submissionId: preview.submissionId,
              error: result.reason,
            };
          } else {
            canonicalTxid = result.canonicalTxid ?? ("txid" in result ? result.txid : preview.txid);
            providerReturnedTxidRaw = "providerReturnedTxidRaw" in result
              ? result.providerReturnedTxidRaw
              : canonicalTxid;
            providerReturnedTxidNormalized = "providerReturnedTxidNormalized" in result
              ? result.providerReturnedTxidNormalized
              : canonicalTxid.toLowerCase();
            if ("txidIntegrity" in result && result.txidIntegrity !== undefined) {
              txidIntegrity = result.txidIntegrity;
            } else {
              txidIntegrity = providerReturnedTxidNormalized === preview.txid.toLowerCase() ? "exact" : "mismatch";
            }
          }
        } else {
          throw new Error("Central broadcast service is unavailable");
        }
        const scope = {ownerPublicKeyHex: preview.ownerPublicKeyHex, network: preview.network, submissionId: preview.submissionId!};
        deps.submissions.outcome({...scope, state: isolated || txidIntegrity === "mismatch" ? "unknown" : "accepted"});
        return {
          status: txidIntegrity === "mismatch" ? "provider-inconsistent" : isolated ? "unknown" : "broadcast-pending-woc",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          inputClaimIds: preview.inputClaimIds,
          submissionId: preview.submissionId,
          canonicalTxid,
          providerReturnedTxidRaw,
          providerReturnedTxidNormalized,
          txidIntegrity
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const scope = {ownerPublicKeyHex: preview.ownerPublicKeyHex, network: preview.network, submissionId: preview.submissionId!};
        const current = deps.submissions.read(scope);
        if (current.state === "accepted" || current.state === "already-known") return {status: "broadcast-pending-woc", txid: preview.txid, rawTxHex: preview.rawTxHex, submissionId: preview.submissionId};
        const definitivelyRejected = isDefinitelyNotDispatchedBroadcastError(err) || (err as {code?: string})?.code === "woc-tx-rejected";
        const existing = deps.submissionStore && preview.submissionId
          ? await deps.submissionStore.getProtocolSubmission({ publicKeyHex: preview.ownerPublicKeyHex, id: preview.submissionId })
          : undefined;
        const protectedClaimIds = preview.protectedClaimIds && preview.protectedClaimIds.length > 0
          ? preview.protectedClaimIds
          : existing?.protectedClaimIds ?? [];
        const inputClaimIds = preview.inputClaimIds && preview.inputClaimIds.length > 0
          ? preview.inputClaimIds
          : existing?.localInputClaimIds ?? [];
        if (protectedClaimIds.length > 0 && deps.protectedOutpoints && definitivelyRejected) {
          await deps.protectedOutpoints.releaseClaims(protectedClaimIds);
        }
        if (inputClaimIds.length > 0 && definitivelyRejected) {
          await deps.claimStore.releaseLocalInputClaims({
            publicKeyHex: preview.ownerPublicKeyHex,
            claimIds: inputClaimIds
          });
        }
        if (definitivelyRejected) {
          if (current.state !== "rejected") await this.releasePreparedSubmission({...scope, txid: preview.txid});
        } else if (current.state === "signed" || current.state === "dispatching") {
          deps.submissions.outcome({...scope, state: "unknown"});
        }
        if (definitivelyRejected) {
          return {
            status: "rejected",
            txid: preview.txid,
            rawTxHex: preview.rawTxHex,
            inputClaimIds,
            submissionId: preview.submissionId,
            error: msg
          };
        }
        return {
          status: "unknown",
          txid: preview.txid,
          rawTxHex: preview.rawTxHex,
          inputClaimIds: preview.inputClaimIds,
          submissionId: preview.submissionId,
          error: msg
        };
      }
      });
    }
  };
}
