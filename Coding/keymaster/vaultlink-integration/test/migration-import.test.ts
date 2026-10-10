import {encodePaymentPolicy,policyArchiveId,policyArchiveRecord} from '@vaultlink/sdk';
import {test,expect} from 'vitest';
import {createIndexedDbWalletStore} from '../../../../packages/platform-storage/src/coordinator/index.js';
import {createVaultBootstrapStorage} from '../../../../packages/platform-storage/src/coordinator/vaultBootstrapStorage.js';
import {createWalletKeyRepository,inspectWalletKeyBytes} from '../../../../packages/plugin-vault/src/walletKeyRepository.js';
import {createAndVerifyMigrationKeyHold} from '../../../../packages/plugin-vault/src/migrationKeyHold.js';
import {WALLET_KEYHOLD_PATH,WALLET_META_PATH,WALLET_META_FORMAT,WALLET_CURRENT_SCHEMA_VERSION} from '@keymaster/contracts';
import {WALLET_PAYMENT_POLICY_PATH} from '@keymaster/contracts/storage-internal';
import {serializeStoredPaymentPolicy,parseStoredPaymentPolicy} from '../src/policy-storage.js';
import {createSoftwareToHardwareMigration,createMigrationJournalService} from '../src/migration-journal.js';
import {ProvisionMigrationConnection} from '../src/provision-migration-connection.js';
import {openActualMigrationDevice} from './native-migration-device.mjs';
// Explicit HOST three-button event/PIN entry and Node IndexedDB API adapters.
// All encryption, KeyStore wrapping, source-key proof and atomic commits are
// real product code; this is not physical USB or flash power-cut evidence.
test('soft-to-hard imports actual source key and bank, proves wrapped possession before replacing KeyHold, and preserves business data',async()=>{
 const device=await openActualMigrationDevice(ProvisionMigrationConnection,{importing:true});
 const store=createIndexedDbWalletStore({databaseName:'migration-import-'+crypto.randomUUID()});
 const generation=crypto.randomUUID(),id=crypto.randomUUID(),encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
 const secret=new Uint8Array(32);secret[31]=1;
 const source=await createAndVerifyMigrationKeyHold({privateKey:secret,publicKeyHex:device.pub,label:'same key'},'software-password');secret.fill(0);
 const key=await store.put(WALLET_KEYHOLD_PATH,source);
 await store.put(WALLET_META_PATH,encode({format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,walletGeneration:generation,createdAt:new Date().toISOString()}));
 const business=encode({contact:'保留联系人'});await store.put('contacts/original',business);
 const ledger={version:3 as const,key:device.pub,channels:[{id:'app-channel',owner:'trusted-app',kind:'app' as const,network:'main' as const,paymentType:'p2pkh' as const,singleLimit:2n,defaultSessionLimit:10n,revision:1,enabled:true}],
  sessions:[{id:'closed-connection',owner:'trusted-app',limit:10n,used:9n,archivedUsed:4n,revision:1,active:false}],
  pending:[{id:'paid',channelId:'app-channel',sessionId:'closed-connection',amount:3n,configRevision:1,sessionRevision:1,commitment:new Uint8Array(32).fill(1),state:'signed' as const,pool:null},
   {id:'unknown',channelId:'app-channel',sessionId:'closed-connection',amount:2n,configRevision:1,sessionRevision:1,commitment:new Uint8Array(32).fill(2),state:'unknown' as const,pool:null}],pools:[],archive:{payments:[{idHash:policyArchiveId('archived-paid'),recordHash:policyArchiveRecord({id:'archived-paid',channelId:'app-channel',sessionId:'closed-connection',amount:4n,configRevision:1,sessionRevision:1,commitment:new Uint8Array(32).fill(3),state:'signed',pool:null})}],sessions:[]}};
 await store.put(WALLET_PAYMENT_POLICY_PATH,serializeStoredPaymentPolicy(ledger,device.pub));
 const bootstrap=createVaultBootstrapStorage(store),repo=createWalletKeyRepository(bootstrap.keys);
 const service=createMigrationJournalService({store:bootstrap.migration,inspectKey:inspectWalletKeyBytes});let received:Uint8Array|undefined;
 try {
  const migration=createSoftwareToHardwareMigration({service,device:device.backend,assertExclusive(){},sourceBank:()=>service.sourceBank(device.pub),
   async unlockSource(){const key=await repo.unlock('software-password');received=key.privateKeyBytes;return received;},
   hardwareDocument:j=>encode({format:'keymaster.hardware-key',version:1,backend:'vaultlink',wireVersion:2,label:'same key',publicKeyHex:j.publicKeyHex,walletGeneration:j.walletGeneration,backendGeneration:1})});
  const result=await migration.run({migrationId:id,expectedRevision:key.revision});
  expect(result).toMatchObject({phase:'complete',source:'software',target:'hardware',walletGeneration:generation,publicKeyHex:device.pub});
  expect(received?.every(v=>v===0)).toBe(true);
  expect((await repo.read())?.backend).toBe('hardware');
  expect(encodePaymentPolicy(parseStoredPaymentPolicy((await store.get(WALLET_PAYMENT_POLICY_PATH))!.bytes,device.pub),device.pub)).toEqual(encodePaymentPolicy(ledger,device.pub));
  await expect(repo.unlock('software-password')).rejects.toBeDefined();
  expect((await store.get('contacts/original'))?.bytes).toEqual(business);
  expect(await device.backend.migrationStatus()).toMatchObject({id,phase:'complete',direction:'to-hardware'});
  expect(device.log()).toMatch(/host-review:migration.import-key:pin=1/);
  await repo.rename('updated label');expect((await service.current())?.phase).toBe('complete');
 }finally{store.close();await device.close();}
},30_000);

for(const phase of ['import-staged','key-wrapped','device-committed','local-committed'] as const){
 test(`forward recovery from declared ${phase} commit point preserves same journal and source ledger`,async()=>{
  const store=createIndexedDbWalletStore({databaseName:'migration-import-recovery-'+crypto.randomUUID()}),bootstrap=createVaultBootstrapStorage(store);
  const pub='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',secret=new Uint8Array(32);secret[31]=1;
  const source=await createAndVerifyMigrationKeyHold({privateKey:secret,publicKeyHex:pub,label:'same key'},'software-password');secret.fill(0);
  const key=await store.put(WALLET_KEYHOLD_PATH,source),generation=crypto.randomUUID(),id=crypto.randomUUID();
  const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
  await store.put(WALLET_META_PATH,encode({format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,walletGeneration:generation,createdAt:new Date().toISOString()}));
  const service=createMigrationJournalService({store:bootstrap.migration,inspectKey:inspectWalletKeyBytes});
  const journal=await service.begin({migrationId:id,expectedRevision:key.revision,policyBank:await service.sourceBank(pub)});
  if(phase==='local-committed'){await service.deviceCommitted(id,journal.policyHash);await service.commitLocal(id,encode({format:'keymaster.hardware-key',version:1,backend:'vaultlink',wireVersion:2,label:'same key',publicKeyHex:pub,walletGeneration:generation,backendGeneration:1}),await service.sourceBank(pub));}
  const device=await openActualMigrationDevice(ProvisionMigrationConnection,{importing:true,phase:phase==='local-committed'?'device-committed':phase,journal}),repo=createWalletKeyRepository(bootstrap.keys);
  let decrypts=0;
  try{
   const migration=createSoftwareToHardwareMigration({service,device:device.backend,assertExclusive(){},sourceBank:()=>service.sourceBank(pub),
    async unlockSource(){decrypts++;return (await repo.unlock('software-password')).privateKeyBytes;},
    hardwareDocument:j=>encode({format:'keymaster.hardware-key',version:1,backend:'vaultlink',wireVersion:2,label:'same key',publicKeyHex:j.publicKeyHex,walletGeneration:j.walletGeneration,backendGeneration:1})});
   expect(await migration.run({migrationId:id,expectedRevision:key.revision})).toMatchObject({migrationId:id,phase:'complete',target:'hardware'});
   expect(decrypts).toBe(phase==='import-staged'?1:0);
   expect((await repo.read())?.document.publicKeyHex).toBe(pub);
   expect((await device.backend.migrationStatus())?.phase).toBe('complete');
  }finally{store.close();await device.close();}
 },30_000);
}

test('actual import endpoint rejects changed staged bytes, wrong private key and ordinary signature requests before physical import',async()=>{
 const device=await openActualMigrationDevice(ProvisionMigrationConnection,{importing:true});
 const store=createIndexedDbWalletStore({databaseName:'migration-import-negative-'+crypto.randomUUID()});
 const bootstrap=createVaultBootstrapStorage(store),pub=device.pub,secret=new Uint8Array(32);secret[31]=1;
 const source=await createAndVerifyMigrationKeyHold({privateKey:secret,publicKeyHex:pub,label:'same key'},'software-password');secret.fill(0);
 const key=await store.put(WALLET_KEYHOLD_PATH,source),generation=crypto.randomUUID();
 await store.put(WALLET_META_PATH,new TextEncoder().encode(JSON.stringify({format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,walletGeneration:generation,createdAt:new Date().toISOString()})));
 const service=createMigrationJournalService({store:bootstrap.migration,inspectKey:inspectWalletKeyBytes}),bank=await service.sourceBank(pub);
 const journal=await service.begin({migrationId:crypto.randomUUID(),expectedRevision:key.revision,policyBank:bank});
 try{
  await device.backend.stage(journal,bank);
  const {commitment}=await import('@vaultlink/sdk');
  // White-box access solely to send adversarial real wire bytes; the production
  // private portal deliberately has no ordinary signing API.
  const client=(device.backend as unknown as {client:import('@vaultlink/sdk').ProtocolClient}).client;
  const badChunk=bank.slice();badChunk[0]^=1;const changed={id:journal.migrationId,offset:0,chunk:badChunk};
  expect(await client.execute('migration.import-stage',changed,await commitment('key-import-stage',1,changed))).toMatchObject({error:'migration-conflict'});
  const wrong=new Uint8Array(32);wrong[31]=2;
  try{await expect(device.backend.prove(journal,wrong)).rejects.toThrow('wrong-key');}finally{wrong.fill(0);}
  const core={scope:'adversarial',staticKey:new Uint8Array(32)};
  expect(await client.execute('identity.noise-proof',core,await commitment('noise-proof',1,core))).toMatchObject({error:'unsupported'});
  expect((await device.backend.migrationStatus())?.phase).toBe('staged');
  expect((await createWalletKeyRepository(bootstrap.keys).read())?.backend).toBe('software');
  expect(device.log()).not.toMatch(/host-review:migration.import-key/);
 }finally{store.close();await device.close();}
},30_000);
