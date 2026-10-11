import { object, type Value } from '@vaultlink/sdk';
import { VaultLinkHardwareBackend, type HardwarePaymentResult } from './hardware-backend.js';
import type { PaymentChannelDTO, WalletPaymentCommand } from './wallet-payments.js';

function money(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 0xffffffffffffffffn) throw Error('invalid-amount');
  return BigInt(value);
}
function hex(value: Uint8Array): string { return Array.from(value, v => v.toString(16).padStart(2,'0')).join(''); }
function bytes(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) throw Error('invalid-hex');
  return Uint8Array.from(value.match(/../g)!, v => Number.parseInt(v,16));
}
function channel(value: Value): PaymentChannelDTO {
  const c = object(value,['id','owner','kind','network','paymentType','enabled','singleLimit','defaultSessionLimit','revision']);
  for (const field of ['id','owner','network','paymentType']) if (typeof c[field] !== 'string') throw Error('invalid-channel-response');
  if ((c.kind !== 'plugin' && c.kind !== 'app') || (c.network !== 'main' && c.network !== 'test') || typeof c.enabled !== 'boolean'
    || typeof c.revision !== 'number' || !Number.isSafeInteger(c.revision) || c.revision < 1 || c.revision >= 0xffffffff) throw Error('invalid-channel-response');
  const amount = (v: Value | undefined) => {
    if (typeof v !== 'bigint' && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) throw Error('invalid-channel-response');
    return String(money(String(v)));
  };
  return {id:c.id as string,owner:c.owner as string,kind:c.kind,network:c.network,paymentType:c.paymentType as string,
    enabled:c.enabled,revision:c.revision,singleLimit:amount(c.singleLimit),defaultSessionLimit:amount(c.defaultSessionLimit)};
}
/** 与软件 WalletPayments 使用同一业务命令；硬件账本是唯一额度权威。
 * 浏览器不复制一份 used，也不在自动付款前增加第二次确认。配置只能通过设备实体确认提交。
 */
export class HardwareWalletPayments {
  private closed = false;
  private requests = new Map<string, {revoked:boolean}>();
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private backend: VaultLinkHardwareBackend, private assertActive: () => void) {}
  close(): void { this.closed = true; for (const token of this.requests.values()) token.revoked = true; }
  private assert(): void { this.assertActive(); if (this.closed) throw Error('payment-wallet-locked'); }
  handle(command: WalletPaymentCommand): Promise<unknown> {
    this.assert(); const frozen = structuredClone(command);
    // 取消不进入配置/签名 FIFO，立即撤销等候按钮的请求。
    if (frozen.action === 'session-cancel' || frozen.action === 'session-close') {
      const token = this.requests.get(frozen.id); if (token) token.revoked = true;
      return frozen.action === 'session-close' ? this.backend.closeAppSession(frozen.id) : this.backend.cancelAppRequests(frozen.id);
    }
    let token: {revoked:boolean} | undefined;
    if ('sessionId' in frozen && frozen.sessionId !== null) {
      token = this.requests.get(frozen.sessionId);
      if (!token || token.revoked) {
        if (!token && this.requests.size >= 16) throw Error('capacity');
        token = {revoked:false}; this.requests.set(frozen.sessionId,token);
      }
    }
    const guard = () => {this.assert();if(token?.revoked)throw Error('payment-cancelled');};
    if (['register','configure','session-open'].includes(frozen.action)) {
      const result = this.mutations.then(() => this.execute(frozen)); this.mutations = result.catch(() => {}); return result;
    }
    return this.execute(frozen,guard);
  }
  private async channels(): Promise<PaymentChannelDTO[]> {
    const value = await this.backend.listChannels(); this.assert();
    if (!Array.isArray(value) || value.length > 32) throw Error('invalid-channel-response');
    const list = value.map(channel);
    if (new Set(list.map(c => c.id)).size !== list.length) throw Error('invalid-channel-response');
    return list;
  }
  private async execute(command: WalletPaymentCommand, guard: () => void = () => this.assert()): Promise<unknown> {
    this.assert();
    if(command.action==='backend')return 'hardware';
    if(command.action==='signing-list'){const value=await this.backend.listSigningChannels();this.assert();return (value as {channels:unknown}).channels;}
    if(command.action==='signing-configure')throw Error('hardware-settings-local');
    if (command.action === 'list') return this.channels();
    if (command.action === 'pending') return []; // 硬件上确认；网页不产生可以绕过按键的批准入口。
    if (command.action === 'answer') throw Error('hardware-approval-required');
    if (command.action === 'register') {
      const channels = await this.channels(), existing = channels.find(c => c.id === command.id);
      if (existing) {
        if (existing.owner !== command.owner || existing.kind !== command.kind || existing.network !== command.network || existing.paymentType !== command.paymentType) throw Error('channel-conflict');
        return existing;
      }
      const config: PaymentChannelDTO = {id:command.id,owner:command.owner,kind:command.kind,network:command.network,paymentType:command.paymentType,
        enabled:false,singleLimit:'0',defaultSessionLimit:command.kind === 'app' ? channels.find(c => c.kind === 'app' && c.owner === command.owner)?.defaultSessionLimit ?? '0' : '0',revision:1};
      await this.backend.configureChannel({...config,singleLimit:money(config.singleLimit),defaultSessionLimit:money(config.defaultSessionLimit)});
      this.assert(); return channel(await this.backend.readChannel(config.id));
    }
    if (command.action === 'configure')throw Error('hardware-settings-local');
    if (command.action === 'session-open') { await this.backend.startAppSession(command.id,command.owner); this.assert(); return true; }
    if (command.action !== 'sign-p2pkh' && command.action !== 'sign-standard' && command.action !== 'sign-feepool') throw Error('unsupported');
    const config = channel(await this.backend.readChannel(command.channelId)); guard();
    if (config.paymentType !== (command.action === 'sign-feepool' ? `feepool.${command.family}${command.role === 'cosigner' ? '.cosigner' : ''}` : command.action === 'sign-standard' ? 'bsv.standard' : 'p2pkh')) throw Error('unsupported');
    const input = {rawTx:bytes(command.rawTxHex),prevTransactions:command.prevTransactionHexes.map(bytes),channelId:command.channelId,
      paymentId:command.paymentId,sessionId:command.sessionId,network:config.network as "main" | "test"};
    let result: HardwarePaymentResult;
    if (command.action === 'sign-feepool') result = await this.backend.signFeePool({...input,family:command.family,stage:command.stage,...(command.role ? {role:command.role} : {}),...(command.openingRequestHex ? {openingRequest:bytes(command.openingRequestHex)} : {}),...(command.authorization ? {authorization:{document:bytes(command.authorization.documentHex),refundTemplate:bytes(command.authorization.refundTemplateHex)}} : {})});
    else if (command.action === 'sign-standard') result = await this.backend.signStandard(input);
    else result = await this.backend.signP2pkh(input);
    guard(); return {signatures:result.signatures.map(hex),amount:String(result.amount),fee:String(result.fee)};
  }
}
