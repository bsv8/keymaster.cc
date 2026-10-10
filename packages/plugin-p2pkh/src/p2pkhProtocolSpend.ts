import { signProtocolPayment } from "@keymaster/vaultlink-integration";
// P2PKH 协议 spend：受控签名 + 广播任意输出计划。

import type {
  BsvNetwork,
  ProtocolSpendInput,
  ProtocolSpendOutput,
  ProtocolSpendPrepareInput,
  ProtocolSpendPreview,
  ProtocolSpendResult,
  ProtocolSpendService,
  ProtectedOutpointRegistry,
  CentralBroadcastService,
  P2pkhUtxoBinding,
  VaultService
} from "@keymaster/contracts";
import { isDefinitelyNotDispatchedBroadcastError } from "@keymaster/contracts";
import type { P2pkhProtocolSubmission, P2pkhUtxo } from "./p2pkhContracts.js";
import {
  calcTxidFromRawTxHex,
  rawTxHexByteLength,
  serializeTx,
  type UnsignedTx,
} from "./p2pkhSigner.js";
import { resourceIdFor } from "./storage/p2pkhStateRepository.js";

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

export interface P2pkhProtocolSpendDeps {
  vault: Pick<VaultService, "status" | "createActiveKeyCrypto" | "requestPayment">;
  previousTransactions(network: BsvNetwork, inputs: readonly ProtocolSpendInput[]): Promise<string[]>;
  /** Production query: reject spent/unknown inputs immediately before claiming/signing. */
  assertInputsUnspent?(network:BsvNetwork,inputs:readonly ProtocolSpendInput[]):Promise<void>;
  /** 生产广播入口；协议 spend 不直接依赖 WOC 或其它 Provider。 */
  centralBroadcastService?: CentralBroadcastService;
  /** 从当前快照取得协议输入对应的序号绑定。 */
  getUtxoBinding?: (input: { ownerPublicKeyHex: string; network: BsvNetwork }) => Promise<P2pkhUtxoBinding | undefined>;
  getKeyForOwner: (ownerPublicKeyHex: string) => Promise<{ publicKeyHex: string }>;
  claimStore: P2pkhProtocolSpendClaimStore;
  submissionStore?: P2pkhProtocolSpendSubmissionStore;
  protectedOutpoints?: ProtectedOutpointRegistry;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function buildUnsignedTx(
  inputs: ProtocolSpendInput[],
  outputs: ProtocolSpendOutput[],
  changeAddress: string | undefined,
  changeSatoshis: number
): UnsignedTx {
  const txInputs = inputs.map((u) => ({
    prevTxid: u.txid,
    prevVout: u.vout,
    scriptSig: new Uint8Array(0),
    sequence: 0xfffffffe
  }));
  const txOutputs = [
    ...outputs.map((o) => ({ value: o.value, script: hexToBytes(o.scriptHex) })),
    ...(changeAddress && changeSatoshis > 0
      ? [{ value: changeSatoshis, script: addressToP2pkhScript(changeAddress) }]
      : [])
  ];
  return { version: 1, inputs: txInputs, outputs: txOutputs, lockTime: 0 };
}

function addressToP2pkhScript(address: string): Uint8Array {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error("Invalid P2PKH address");
  }
  const version = decoded[0]!;
  if (version !== 0x00 && version !== 0x6f) {
    throw new Error("Unsupported P2PKH address network");
  }
  const hash160 = decoded.slice(1, 21);
  return Uint8Array.from([
    0x76,
    0xa9,
    0x14,
    ...hash160,
    0x88,
    0xac
  ]);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  const bytes = [0];
  for (const ch of input) {
    let carry = BASE58_ALPHABET.indexOf(ch);
    if (carry < 0) throw new Error("Invalid base58 character");
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i]! * 58 + carry;
      bytes[i] = v & 0xff;
      carry = (v / 256) | 0;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = (carry / 256) | 0;
    }
  }
  let leadingZeros = 0;
  for (const ch of input) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[out.length - 1 - i] = bytes[i]!;
  }
  return out;
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

function normalizePositiveInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * 输出金额闸门。
 *
 * 无找零模式允许零值输出：固定位置的协议输出里，索引费为零时 vout 0 的值就是 0，
 * 位置本身是协议的一部分。零值只在调用方显式声明后才允许，其余路径继续 fail closed。
 */
function normalizeOutputValue(value: number, label: string, allowZeroValueOutputs: boolean): number {
  if (allowZeroValueOutputs) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`${label} must be a non-negative integer`);
    }
    return value;
  }
  return normalizePositiveInteger(value, label);
}

/** 无找零模式的预算闸门：必须是正的安全整数。 */
function normalizeMinerFeeBudget(value: number): number {
  return normalizePositiveInteger(value, "noChangeRule.maxMinerFeeSatoshis");
}

function assertUnprotectedInputs(
  registry: ProtectedOutpointRegistry | undefined,
  input: ProtocolSpendPrepareInput
): void {
  if (!registry) return;
  for (const utxo of input.inputs) {
    if (!input.requestingPluginId && registry.isProtected({
      txid: utxo.txid,
      vout: utxo.vout,
      network: input.network,
      publicKeyHex: input.ownerPublicKeyHex
    })) {
      throw new Error(`Protocol spend blocked by protected outpoint: ${utxo.txid}:${utxo.vout}`);
    }
  }
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

export function createP2pkhProtocolSpendService(deps: P2pkhProtocolSpendDeps): ProtocolSpendService {
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

  const tickets=new Map<string,{preview:ProtocolSpendPreview;input:ProtocolSpendPrepareInput;expires:number}>();
  const build=async(input:ProtocolSpendPrepareInput,sign:boolean):Promise<ProtocolSpendPreview>=>{
      let protectedClaimIds: string[] = [];
      let inputClaimIds: string[] = [];
      const submissionId = crypto.randomUUID();
      // 放在 try 之前：签名闭包要读它，而闭包定义在 owner 解析之前。
      const resolvedOwner = await resolveOwnerKeyIdentity(deps, input.ownerPublicKeyHex);

      /**
       * 签名 + 占用输入 + 落盘预签名记录。
       *
       * 两条路径（按费率迭代的找零模式与无找零模式）共用这一段：它们只在费用怎么
       * 算出来上不同，签名、输入占用与写前日志的顺序必须完全一致。
       */
      const signAndRecord = async (plan: {
        inputs: P2pkhUtxo[];
        outputs: ProtocolSpendOutput[];
        changeAddress: string | undefined;
        changeSatoshis: number;
        feeSatoshis: number;
        /** 裸公钥单签输入的锁定脚本；按输入顺序给出，缺省项按 P2PKH 处理。 */
        lockingScripts?: readonly (string | undefined)[];
      }): Promise<ProtocolSpendPreview> => {
        const unsigned = buildUnsignedTx(plan.inputs, plan.outputs, plan.changeAddress, plan.changeSatoshis);
        if(!sign){
          const now=Date.now();for(const [id,t] of tickets)if(t.expires<=now)tickets.delete(id);
          if(tickets.size>=32)throw Error("Too many pending protocol previews");
          const rawTxHex=Array.from(serializeTx(unsigned),b=>b.toString(16).padStart(2,"0")).join("");
          const preview:ProtocolSpendPreview={previewId:crypto.randomUUID(),ownerPublicKeyHex:resolvedOwner.publicKeyHex,requestingPluginId:input.requestingPluginId,network:input.network,
            inputs:structuredClone(input.inputs),outputs:structuredClone(plan.outputs),...(plan.changeAddress===undefined?{}:{changeAddress:plan.changeAddress}),changeSatoshis:plan.changeSatoshis,
            estimatedFeeSatoshis:plan.feeSatoshis,serializedSizeBytes:serializeTx(unsigned).length+input.inputs.reduce((n,u)=>n+(u.lockingScriptHex===undefined?108:74),0),txid:"",rawTxHex};
          tickets.set(preview.previewId!,{preview:structuredClone(preview),input:structuredClone(input),expires:now+120000});return preview;
        }
        await deps.assertInputsUnspent?.(input.network,input.inputs);
        // 输入占用先于额度批准/签名，竞争失败不产生第二份可花费签名。
        inputClaimIds = (await deps.claimStore.tryClaimInputs({submissionId, resourceId: resourceIdFor(input.network), publicKeyHex: resolvedOwner.publicKeyHex, network: input.network,
          inputs: input.inputs.map(u => ({txid: u.txid, vout: u.vout, value: u.value})),
        })).claimIds;
        const rawTxHex = await signProtocolPayment({
          rawTxHex: Array.from(serializeTx(unsigned), b => b.toString(16).padStart(2, "0")).join(""),
          prevTransactionHexes: await deps.previousTransactions(input.network, input.inputs),
          publicKeyHex: resolvedOwner.publicKeyHex, network: input.network,
          pluginId: input.requestingPluginId ?? "p2pkh", requestPayment: c => deps.vault.requestPayment(c),
        });
        const serializedSizeBytes = rawTxHexByteLength(rawTxHex);
        inputClaimIds = (await deps.claimStore.tryClaimInputs({
          submissionId,
          resourceId: resourceIdFor(input.network),
          publicKeyHex: resolvedOwner.publicKeyHex,
          network: input.network,
          inputs: input.inputs.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value })),
          expectedCanonicalTxid: calcTxidFromRawTxHex(rawTxHex)
        })).claimIds;
        if (deps.submissionStore) {
          await deps.submissionStore.putProtocolSubmission(buildProtocolSubmissionRecord({
            submissionId,
            resourceId: resourceIdFor(input.network),
            publicKeyHex: resolvedOwner.publicKeyHex,
            network: input.network,
            canonicalTxid: calcTxidFromRawTxHex(rawTxHex),
            inputs: input.inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
            protectedClaimIds,
            localInputClaimIds: inputClaimIds,
            status: "prepared"
          }));
        }
        const utxoBinding = await deps.getUtxoBinding?.({ ownerPublicKeyHex: resolvedOwner.publicKeyHex, network: input.network });
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
          ...(utxoBinding === undefined ? {} : { utxoBinding, utxoSeq: utxoBinding.seq })
        };
      };

      try {
        assertUnprotectedInputs(deps.protectedOutpoints, input);
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
        const allowZeroValueOutputs = noChangeRule?.allowZeroValueOutputs === true;
        if (noChangeRule !== undefined) normalizeMinerFeeBudget(noChangeRule.maxMinerFeeSatoshis);
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
          value: normalizePositiveInteger(u.value, "Input value"),
          address: u.address
        }));
        const outputs = input.outputs.map((o) => ({
          value: normalizeOutputValue(o.value, "Output value", allowZeroValueOutputs),
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
          return signAndRecord({
            inputs,
            outputs,
            changeAddress: undefined,
            changeSatoshis: 0,
            feeSatoshis,
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
            return signAndRecord({
              inputs,
              outputs,
              changeAddress: input.changeAddress,
              changeSatoshis,
              feeSatoshis,
              lockingScripts: input.inputs.map((u) => u.lockingScriptHex),
            });
          }
          feeSatoshis = nextFee;
        }
        throw new Error("Protocol spend fee failed to converge");
      } catch (err) {
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
      if(preview.previewId){tickets.delete(preview.previewId);return;}
      const submissionId = preview.submissionId;
      if (!submissionId || !deps.submissionStore) throw new Error("Prepared protocol spend has no durable submission record");
      await serializeSubmissionOperation(submissionId, async () => {
        const owner = await resolveOwnerKeyIdentity(deps, preview.ownerPublicKeyHex);
        if (owner.publicKeyHex.toLowerCase() !== preview.ownerPublicKeyHex.toLowerCase()) {
          throw new Error("Prepared protocol spend owner is not active");
        }
        if (calcTxidFromRawTxHex(preview.rawTxHex) !== preview.txid) throw new Error("Prepared protocol spend txid does not match its raw bytes");
        const existing = await deps.submissionStore!.getProtocolSubmission({ publicKeyHex: preview.ownerPublicKeyHex, id: submissionId });
        if (!existing
          || (existing.status !== "prepared" && !(existing.status === "rejected" && existing.droppedReason === "prepared-spend-released"))
          || existing.canonicalTxid !== preview.txid
          || existing.network !== preview.network
          || existing.resourceId !== resourceIdFor(preview.network)
          || existing.inputs.length !== preview.inputs.length
          || existing.inputs.some((input, index) => input.txid !== preview.inputs[index]?.txid || input.vout !== preview.inputs[index]?.vout)) {
          throw new Error("Only a matching undispatched protocol spend can be released");
        }
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
        const owner = await resolveOwnerKeyIdentity(deps, input.ownerPublicKeyHex);
        if (owner.publicKeyHex.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()) {
          throw new Error("Prepared protocol submission owner is not active");
        }
        const existing = await deps.submissionStore!.getProtocolSubmission({ publicKeyHex: input.ownerPublicKeyHex, id: submissionId });
        if (!existing
          || (existing.status !== "prepared" && !(existing.status === "rejected" && existing.droppedReason === "prepared-spend-released"))
          || existing.submissionId !== submissionId
          || existing.canonicalTxid !== input.txid
          || existing.network !== input.network
          || existing.publicKeyHex.toLowerCase() !== input.ownerPublicKeyHex.toLowerCase()
          || existing.resourceId !== resourceIdFor(input.network)) {
          throw new Error("Only a matching definitely undispatched protocol submission can be released");
        }
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
        if(JSON.stringify(ticket.preview)!==JSON.stringify(preview))throw Error("Protocol preview changed");
        tickets.delete(preview.previewId);
        // Rebuild and revalidate owner/protection/prevouts at actual authorization.
        preview=await build(ticket.input,true);
      }
      if(!preview.txid||calcTxidFromRawTxHex(preview.rawTxHex)!==preview.txid)throw Error("Protocol signed transaction bytes do not match txid");
      const submissionIdForLock = preview.submissionId ?? preview.txid;
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
          });
          if (result.status === "isolated") {
            isolated = true;
            canonicalTxid = result.canonicalTxid ?? preview.txid;
            providerReturnedTxidRaw = result.providerReturnedTxidRaw;
            providerReturnedTxidNormalized = result.providerReturnedTxidNormalized;
            txidIntegrity = result.txidIntegrity;
          } else if (result.status === "not-dispatched") {
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
            if (deps.submissionStore && preview.submissionId) {
              await deps.submissionStore.putProtocolSubmission(buildProtocolSubmissionRecord({
                submissionId: preview.submissionId,
                resourceId: resourceIdFor(preview.network),
                publicKeyHex: preview.ownerPublicKeyHex,
                network: preview.network,
                canonicalTxid: preview.txid,
                inputs: preview.inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
                protectedClaimIds,
                localInputClaimIds: inputClaimIds,
                status: "rejected",
                droppedReason: result.reason,
                createdAt: existing?.createdAt,
              }));
            }
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
        if (deps.submissionStore && preview.submissionId) {
          const existing = await deps.submissionStore.getProtocolSubmission({
            publicKeyHex: preview.ownerPublicKeyHex,
            id: preview.submissionId
          });
          await deps.submissionStore.putProtocolSubmission(buildProtocolSubmissionRecord({
            submissionId: preview.submissionId,
            resourceId: resourceIdFor(preview.network),
            publicKeyHex: preview.ownerPublicKeyHex,
            network: preview.network,
            canonicalTxid,
            inputs: preview.inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
            protectedClaimIds: preview.protectedClaimIds ?? existing?.protectedClaimIds ?? [],
            localInputClaimIds: preview.inputClaimIds ?? existing?.localInputClaimIds ?? [],
            status: txidIntegrity === "mismatch" ? "provider-inconsistent" : isolated ? "unknown" : "broadcast-pending-woc",
            observation: existing?.observation,
            createdAt: existing?.createdAt
          }));
        }
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
        const definitivelyRejected = isDefinitelyNotDispatchedBroadcastError(err);
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
        if (deps.submissionStore && preview.submissionId) {
          await deps.submissionStore.putProtocolSubmission(buildProtocolSubmissionRecord({
            submissionId: preview.submissionId,
            resourceId: resourceIdFor(preview.network),
            publicKeyHex: preview.ownerPublicKeyHex,
            network: preview.network,
            canonicalTxid: preview.txid,
            inputs: preview.inputs.map((u) => ({ txid: u.txid, vout: u.vout })),
            protectedClaimIds,
            localInputClaimIds: inputClaimIds,
            status: definitivelyRejected ? "rejected" : "unknown",
            droppedReason: definitivelyRejected ? msg : undefined,
            observation: existing?.observation,
            createdAt: existing?.createdAt
          }));
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
