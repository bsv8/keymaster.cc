import {parseTransaction,unhex,p2pkhSighash,secpIdentityVerifier} from '@vaultlink/sdk';
import type {P2pkhConnectPaymentPreview} from '@keymaster/contracts';
import {buildSignedP2pkhExact,inspectConnectPayment,type PaymentFileStore} from './wallet-payments.js';
type State='prepared'|'device_started'|'unknown'|'signed_complete'|'cancelled_before_sign';
interface Row {paymentId:string;planDigest:string;sessionId:string|null;version:number;state:State;raw:string;previous:string[];review:P2pkhConnectPaymentPreview;signatures?:string[];signedTxHex?:string;acknowledged?:boolean;}
/** Host persistence only; device is still the sole approval/signing authority.
 * No not-signed proof is issued once dispatch MAY have reached the device. */
export class HardwareConnectJournal {
  private tail:Promise<unknown>=Promise.resolve();
  private path='connect-payment-hardware-executions.json';
  constructor(private files:PaymentFileStore,private key:string,private network:string){}
  private run<T>(fn:()=>Promise<T>):Promise<T>{const next=this.tail.then(fn);this.tail=next.catch(()=>{});return next;}
  private async read(){
    const file=await this.files.get(this.path);if(!file)return {records:{} as Record<string,Row>,revision:undefined as string|undefined};
    const value=JSON.parse(new TextDecoder().decode(file.bytes));
    if(value?.version!==1||value.key!==this.key||value.network!==this.network||!value.records||Array.isArray(value.records)||typeof value.records!=='object')throw Error('corrupt-hardware-connect-journal');
    const entries=Object.entries(value.records);if(entries.length>256)throw Error('corrupt-hardware-connect-journal');
    for(const [id,entry] of entries){const r=entry as Row;
      if(!r||r.paymentId!==id||typeof r.planDigest!=='string'||!r.planDigest||!Number.isSafeInteger(r.version)||r.version<1||!['prepared','device_started','unknown','signed_complete','cancelled_before_sign'].includes(r.state)||!(r.sessionId===null||typeof r.sessionId==='string')||typeof r.raw!=='string'||!Array.isArray(r.previous)||r.previous.length>16||!r.review||r.review.paymentId!==id||r.review.planDigest!==r.planDigest)throw Error('corrupt-hardware-connect-journal');
      unhex(r.raw);for(const p of r.previous)unhex(p);
      if(r.acknowledged!==undefined&&typeof r.acknowledged!=='boolean')throw Error('corrupt-hardware-connect-journal');
      if((r.state==='prepared'||r.state==='cancelled_before_sign')&&(r.signatures!==undefined||r.signedTxHex!==undefined))throw Error('corrupt-hardware-connect-journal');
      if(r.state==='signed_complete'&&(!Array.isArray(r.signatures)||typeof r.signedTxHex!=='string'))throw Error('corrupt-hardware-connect-journal');
    }
    return {records:value.records as Record<string,Row>,revision:file.revision};
  }
  private async save(records:Record<string,Row>,revision:string|undefined){
    await this.files.put(this.path,new TextEncoder().encode(JSON.stringify({version:1,key:this.key,network:this.network,records})),revision===undefined?{ifNoneMatch:true}:{ifRevision:revision});
  }
  prepare(review:P2pkhConnectPaymentPreview,sessionId:string|null,raw:string,previous:string[]){return this.run(async()=>{
    const {records,revision}=await this.read();if(records[review.paymentId])throw Error('request-reuse');if(Object.keys(records).length>=256)throw Error('capacity');
    records[review.paymentId]={paymentId:review.paymentId,planDigest:review.planDigest,sessionId,version:1,state:'prepared',raw,previous:[...previous],review:structuredClone(review)};await this.save(records,revision);
  });}
  start(id:string){return this.run(async()=>{const {records,revision}=await this.read(),row=records[id];if(!row||row.state!=='prepared')throw Error('payment-cancelled');row.state='device_started';row.version++;await this.save(records,revision);});}
  signed(id:string,signatures:string[]){return this.run(async()=>{
    const {records,revision}=await this.read(),row=records[id];if(!row||!['device_started','unknown'].includes(row.state))throw Error('invalid-connect-journal-state');
    row.signatures=[...signatures];row.signedTxHex=await this.verifyExact(row);row.state='signed_complete';row.version++;await this.save(records,revision);
  });}
  private async verifyExact(row:Row){
    if(!row.signatures)throw Error('invalid-signatures');const raw=unhex(row.raw),previous=row.previous.map(unhex),pub=unhex(this.key);
    await inspectConnectPayment(raw,previous,pub,row.review);const tx=parseTransaction(raw);
    if(tx.inputs.length!==row.signatures.length)throw Error('invalid-signatures');
    for(let i=0;i<tx.inputs.length;i++){const input=tx.inputs[i]!,sig=unhex(row.signatures[i]!);if(sig.length<9||sig.at(-1)!==0x41||!secpIdentityVerifier.verify(await p2pkhSighash(tx,i,parseTransaction(previous[i]!).outputs[input.vout]!),sig.slice(0,-1),pub))throw Error('invalid-signature');}
    const exact=buildSignedP2pkhExact(raw,tx,row.signatures,pub);if(row.signedTxHex!==undefined&&row.signedTxHex!==exact)throw Error('invalid-signed-exact');return exact;
  }
  cancelUnexecuted(id:string,deviceDenied=false){return this.run(async()=>{const {records,revision}=await this.read(),row=records[id];
    if(!row||(row.state!=='prepared'&&!(deviceDenied&&row.state==='device_started')))return undefined;
    row.state='cancelled_before_sign';row.version++;await this.save(records,revision);
    return {paymentId:row.paymentId,planDigest:row.planDigest,version:row.version,state:'cancelled_before_sign' as const};
  });}
  cancel(sessionId:string){return this.run(async()=>{const {records,revision}=await this.read();let changed=false;for(const row of Object.values(records))if(row.sessionId===sessionId&&(row.state==='prepared'||row.state==='device_started')){row.state=row.state==='prepared'?'cancelled_before_sign':'unknown';row.version++;changed=true;}if(changed)await this.save(records,revision);});}
  recovery(){return this.run(async()=>{const {records,revision}=await this.read();let changed=false;for(const row of Object.values(records))if(row.state==='prepared'){row.state='cancelled_before_sign';row.version++;changed=true;}
    if(changed)await this.save(records,revision);return Object.values(records).filter(r=>r.state==='cancelled_before_sign'&&!r.acknowledged).map(r=>({paymentId:r.paymentId,planDigest:r.planDigest,version:r.version,state:'cancelled_before_sign' as const}));
  });}
  recoverSigned(){return this.run(async()=>{
    const {records}=await this.read(),result=[];
    for(const row of Object.values(records)){
      if(row.state==='prepared'||row.state==='cancelled_before_sign')continue;
      let exact:string|undefined;
      if(row.state==='signed_complete')try{exact=await this.verifyExact(row);}catch{/* retain corrupt signed material */}
      result.push({paymentId:row.paymentId,planDigest:row.planDigest,version:row.version,...(exact?{state:'signed_complete' as const,signedTxHex:exact}:{state:'quarantined' as const})});
    }
    return result;
  });}
  /** ACK is a durable handoff tombstone, never permission to erase signed exact
   * or reuse a payment identity. Mirrors the software execution journal. */
  ack(ids:string[]){return this.run(async()=>{const {records,revision}=await this.read();let changed=false;for(const id of ids){const row=records[id];if(row&&!row.acknowledged&&(row.state==='cancelled_before_sign'||row.state==='signed_complete')){row.acknowledged=true;changed=true;}}if(changed)await this.save(records,revision);});}
}
