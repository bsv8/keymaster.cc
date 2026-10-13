import {verifyMigrationImportProof,enrollHost,secpIdentityVerifier,inspectDeviceMigration,assertDeviceMigrationBinding,unhex,equal,hex,sha256,commitment,object,
 type DeviceMigrationRecord,type Transport,type Generations,type ProtocolClient,type Value} from '@vaultlink/sdk';
import type {MigrationJournal} from './migration-journal.js';
/** Private Worker import portal. The paired transport key is provisional and
 * must never become a wallet record. Only a source-key challenge signature
 * after actual device wrapping proves successful import. */
export class ProvisionMigrationConnection {
 readonly disconnected:Promise<void>;private closed=false;
 private constructor(private client:ProtocolClient,private assertLive:()=>void,private readonly network:"main"|"test"){
  this.disconnected=client.run().then(()=>{this.closed=true;},()=>{this.closed=true;});
 }
 static async connect(transport:Transport,context:{generations:Generations;bsvNetwork:"main"|"test";assertActive():void},confirmPairing:(code:string)=>Promise<boolean>){
  context.assertActive();
  // Admission is for an empty device only. Transport identity is provisional;
  // after import the same connection may prove the newly saved actual key.
  const verified=await enrollHost(transport,context.generations,secpIdentityVerifier,async code=>{context.assertActive();const yes=await confirmPairing(code);context.assertActive();return yes;},[]);
  try{context.assertActive();const portal=new ProvisionMigrationConnection(verified.client,context.assertActive,context.bsvNetwork);
   const raw=await portal.request('identity.network','identity-network',{});
   const wrapped=raw!==null&&typeof raw==='object'&&!Array.isArray(raw)&&!(raw instanceof Uint8Array)&&'publicKey' in raw;
   const identity=object(raw,wrapped?['bsvNetwork','publicKey']:['bsvNetwork']);
   // Any existing business key forbids import, even the same public key.
   if(wrapped)throw Error('device-already-has-key');
   if(identity.bsvNetwork!==null&&identity.bsvNetwork!==context.bsvNetwork)throw Error('network-identity-mismatch');
   return portal;}
  catch(error){await verified.client.close(error);throw error;}
 }
 private async request(op:string,profile:string,body:Value):Promise<Value>{
  this.assertLive();if(this.closed)throw Error('disconnected');
  const raw=await this.client.execute(op,body,await commitment(profile,1,body),op==='migration.import-key'?300000:120000);this.assertLive();
  if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&!(raw instanceof Uint8Array)&&'error' in raw)throw Error(String(raw.error));return raw;
 }
 private binding(j:MigrationJournal){
  if(j.source!=='software'||j.target!=='hardware')throw Error('migration-conflict');
  return {id:j.migrationId,walletGeneration:j.walletGeneration,publicKey:unhex(j.publicKeyHex),sourceHash:unhex(j.sourceHash),policyHash:unhex(j.policyHash),direction:'to-hardware' as const};
 }
 private check(j:MigrationJournal,raw:Value):DeviceMigrationRecord{
  const state=inspectDeviceMigration(object(raw,['migration']).migration);assertDeviceMigrationBinding(state,this.binding(j));
  if(j.targetHash!==null&&state.targetHash!==null&&hex(state.targetHash)!==j.targetHash)throw Error('migration-conflict');return state;
 }
 async migrationStatus():Promise<DeviceMigrationRecord|null>{
  const value=object(await this.request('migration.status','key-migration-status',{}),['migration']).migration;
  return value===null?null:inspectDeviceMigration(value);
 }
 async stage(j:MigrationJournal,bank:Uint8Array):Promise<void>{
  if(bank.length<1||bank.length>65536||hex(await sha256(bank))!==j.policyHash)throw Error('migration-policy-changed');
  const {direction,...body}=this.binding(j);
  const begun=this.check(j,await this.request('migration.import-begin','key-import-begin',{...body,size:bank.length,bsvNetwork:this.network}));
  if(begun.phase!=='staged')throw Error('migration-conflict');
  const read=async()=>object(await this.request('migration.import-stage-status','key-import-stage-status',{id:j.migrationId}),['size','total','sha256']);
  const valid=async(v:Record<string,Value>)=>{
   if(typeof v.size!=='number'||!Number.isSafeInteger(v.size)||v.size<0||v.size>bank.length||v.total!==bank.length||!(v.sha256 instanceof Uint8Array)||!equal(v.sha256,await sha256(bank.subarray(0,v.size))))throw Error('migration-stage-conflict');
   return v.size;
  };
  let offset=await valid(await read());
  while(offset<bank.length){const chunk=bank.slice(offset,Math.min(offset+8192,bank.length));
   const reply=object(await this.request('migration.import-stage','key-import-stage',{id:j.migrationId,offset,chunk}),['size','total','sha256']);
   const next=await valid(reply);if(next!==offset+chunk.length)throw Error('migration-stage-conflict');offset=next;
  }
 }
 async prove(j:MigrationJournal,privateKey?:Uint8Array):Promise<DeviceMigrationRecord>{
  const challenge=crypto.getRandomValues(new Uint8Array(32));
  if(privateKey!==undefined&&privateKey.length!==32)throw Error('invalid-key');
  const op=privateKey?'migration.import-key':'migration.import-proof',profile=privateKey?'key-import-key':'key-import-proof-request';
  const raw=await this.request(op,profile,{id:j.migrationId,challenge,...(privateKey?{privateKey}:{})});
  const result=object(raw,['migration','signature']),state=inspectDeviceMigration(result.migration);assertDeviceMigrationBinding(state,this.binding(j));
  if(!(result.signature instanceof Uint8Array))throw Error("migration-key-proof-invalid");
  await verifyMigrationImportProof(state,challenge,result.signature);
  // Empty transport identity has no network. Before deleting the source
  // envelope, verify the now-persisted actual (network, public key) identity.
  const identity=object(await this.request('identity.network','identity-network',{}),['bsvNetwork','publicKey']);
  if(identity.bsvNetwork!==this.network||!(identity.publicKey instanceof Uint8Array)||!equal(identity.publicKey,unhex(j.publicKeyHex)))throw Error('network-identity-mismatch');
  this.assertLive();return state;
 }
 async commit(j:MigrationJournal):Promise<DeviceMigrationRecord>{
  if(j.phase!=='local-committed'||j.targetHash===null)throw Error('migration-conflict');
  const state=this.check(j,await this.request('migration.import-commit','key-import-commit',{id:j.migrationId,targetHash:unhex(j.targetHash)}));
  if(state.phase!=='complete'||state.targetHash===null||hex(state.targetHash)!==j.targetHash)throw Error('migration-conflict');return state;
 }
 async close(){this.closed=true;await this.client.close();}
}
