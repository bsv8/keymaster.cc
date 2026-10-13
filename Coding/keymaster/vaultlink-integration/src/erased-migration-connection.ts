import {enrollHost,secpIdentityVerifier,inspectDeviceMigration,assertDeviceMigrationBinding,unhex,equal,commitment,object,
 type DeviceMigrationRecord,type Transport,type Generations,type ProtocolClient} from '@vaultlink/sdk';
import type {MigrationJournal} from './migration-journal.js';
/** A device that erased its old key CANNOT prove old-key possession. Physical
 * pairing authenticates a fresh RAM-only transport identity, solely to compare
 * the browser's already committed migration receipt. This class has no wallet
 * record, key import/export, signature, payment or ordinary activation API. */
export class ErasedMigrationConnection {
 readonly disconnected:Promise<void>;private closed=false;
 private constructor(private client:ProtocolClient,private journal:MigrationJournal,private assertLive:()=>void){
  this.disconnected=client.run().then(()=>{this.closed=true;},()=>{this.closed=true;});
 }
 static async connect(transport:Transport,context:{generations:Generations;journal:MigrationJournal;assertActive():void},confirmPairing:(code:string)=>Promise<boolean>):Promise<ErasedMigrationConnection>{
  const journal=structuredClone(context.journal);
  if(journal.source!=='hardware'||journal.target!=='software'||!['local-committed','complete'].includes(journal.phase)||journal.targetHash===null)throw Error('migration-conflict');
  context.assertActive();
  const verified=await enrollHost(transport,context.generations,secpIdentityVerifier,async code=>{context.assertActive();const allowed=await confirmPairing(code);context.assertActive();return allowed;},[0x231]);
  try{context.assertActive();return new ErasedMigrationConnection(verified.client,journal,context.assertActive);}
  catch(error){await verified.client.close(error);throw error;}
 }
 private check(state:DeviceMigrationRecord){
  assertDeviceMigrationBinding(state,{id:this.journal.migrationId,walletGeneration:this.journal.walletGeneration,publicKey:unhex(this.journal.publicKeyHex),
   sourceHash:unhex(this.journal.sourceHash),policyHash:unhex(this.journal.policyHash),direction:'to-software'});
  if(!['erasing','erased','complete'].includes(state.phase)||state.targetHash===null||!equal(state.targetHash,unhex(this.journal.targetHash!)))throw Error('migration-conflict');
  return state;
 }
 private async request(op:string,profile:string,body:Record<string,string|Uint8Array>):Promise<DeviceMigrationRecord>{
  this.assertLive();if(this.closed)throw Error('disconnected');
  const raw=await this.client.execute(op,body,await commitment(profile,1,body));this.assertLive();
  if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&!(raw instanceof Uint8Array)&&'error' in raw)throw Error(String(raw.error));
  return this.check(inspectDeviceMigration(object(raw,['migration']).migration));
 }
 migrationStatus(){return this.request('migration.status','key-migration-status',{});}
 async finishErase():Promise<DeviceMigrationRecord>{
  let state=await this.migrationStatus();
  if(state.phase==='erasing')state=await this.request('migration.recover-erased','key-migration-recover-erased',{id:this.journal.migrationId,targetHash:unhex(this.journal.targetHash!)});
  if(state.phase!=='erased'&&state.phase!=='complete')throw Error('migration-conflict');return state;
 }
 /** Public completion acknowledgement only after the actual browser journal
  * completes. It confers no permission to create or reset a device key. */
 async completeDevice(journal:MigrationJournal):Promise<void>{
  if(journal.phase!=='complete'||journal.migrationId!==this.journal.migrationId||journal.targetHash!==this.journal.targetHash)throw Error('migration-conflict');
  const state=await this.request('migration.complete','key-migration-complete',{id:journal.migrationId,targetHash:unhex(journal.targetHash!)});
  if(state.phase!=='complete')throw Error('migration-conflict');
 }
 async close(){this.closed=true;await this.client.close();}
}
