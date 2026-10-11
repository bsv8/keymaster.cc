import {encodePaymentPolicy,policyArchiveId,policyArchiveRecord} from '@vaultlink/sdk';
import {test,expect} from 'vitest';
import {createIndexedDbWalletStore} from '../../../../packages/platform-storage/src/coordinator/index.js';
import {createVaultBootstrapStorage} from '../../../../packages/platform-storage/src/coordinator/vaultBootstrapStorage.js';
import {createWalletKeyRepository,inspectWalletKeyBytes} from '../../../../packages/plugin-vault/src/walletKeyRepository.js';
import {createAndVerifyMigrationKeyHold} from '../../../../packages/plugin-vault/src/migrationKeyHold.js';
import {WALLET_KEYHOLD_PATH,WALLET_META_PATH,WALLET_META_FORMAT,WALLET_CURRENT_SCHEMA_VERSION} from '@keymaster/contracts';
import {WALLET_PAYMENT_POLICY_PATH,WALLET_MIGRATION_PATH} from '@keymaster/contracts/storage-internal';
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
 const source=await createAndVerifyMigrationKeyHold({bsvNetwork: "main" as const, privateKey:secret,publicKeyHex:device.pub,label:'same key'},'software-password');secret.fill(0);
 const key=await store.put(WALLET_KEYHOLD_PATH,source);
 await store.put(WALLET_META_PATH,encode({format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,walletGeneration:generation,createdAt:new Date().toISOString()}));
 const business=encode({contact:'保留联系人'});await store.put(`main/${device.pub}/contacts/original`,business);
 const ledger={version:3 as const,key:device.pub,channels:[{id:'app-channel',owner:'trusted-app',kind:'app' as const,network:'main' as const,paymentType:'p2pkh' as const,singleLimit:2n,defaultSessionLimit:10n,revision:1,enabled:true}],
  sessions:[{id:'closed-connection',owner:'trusted-app',limit:10n,used:9n,archivedUsed:4n,revision:1,active:false}],
  pending:[{id:'paid',channelId:'app-channel',sessionId:'closed-connection',amount:3n,configRevision:1,sessionRevision:1,commitment:new Uint8Array(32).fill(1),state:'signed' as const,pool:null},
   {id:'unknown',channelId:'app-channel',sessionId:'closed-connection',amount:2n,configRevision:1,sessionRevision:1,commitment:new Uint8Array(32).fill(2),state:'unknown' as const,pool:null}],pools:[],archive:{payments:[{idHash:policyArchiveId('archived-paid'),recordHash:policyArchiveRecord({id:'archived-paid',channelId:'app-channel',sessionId:'closed-connection',amount:4n,configRevision:1,sessionRevision:1,commitment:new Uint8Array(32).fill(3),state:'signed',pool:null})}],sessions:[]}};
 await store.put(`main/${device.pub}/${WALLET_PAYMENT_POLICY_PATH}`,serializeStoredPaymentPolicy(ledger,device.pub));
 const bootstrap=createVaultBootstrapStorage(store),repo=createWalletKeyRepository(bootstrap.keys);
 const service=createMigrationJournalService({store:bootstrap.migration,inspectKey:inspectWalletKeyBytes});let received:Uint8Array|undefined;
 try {
  const migration=createSoftwareToHardwareMigration({service,device:device.backend,assertExclusive(){},sourceBank:()=>service.sourceBank(device.pub),
   async unlockSource(){const key=await repo.unlock('software-password');received=key.privateKeyBytes;return received;},
   hardwareDocument:j=>encode({bsvNetwork: "main" as const, format:'keymaster.hardware-key',version:1,backend:'vaultlink',wireVersion:2,label:'same key',publicKeyHex:j.publicKeyHex,walletGeneration:j.walletGeneration,backendGeneration:1})});
  const result=await migration.run({migrationId:id,expectedRevision:key.revision});
  expect(result).toMatchObject({phase:'complete',source:'software',target:'hardware',walletGeneration:generation,publicKeyHex:device.pub});
  expect(received?.every(v=>v===0)).toBe(true);
  expect((await repo.read())?.backend).toBe('hardware');
  expect(encodePaymentPolicy(parseStoredPaymentPolicy((await store.get(`main/${device.pub}/${WALLET_PAYMENT_POLICY_PATH}`))!.bytes,device.pub),device.pub)).toEqual(encodePaymentPolicy(ledger,device.pub));
  await expect(repo.unlock('software-password')).rejects.toBeDefined();
  expect((await store.get(`main/${device.pub}/contacts/original`))?.bytes).toEqual(business);
  expect(await device.backend.migrationStatus()).toMatchObject({id,phase:'complete',direction:'to-hardware'});
  expect(device.log()).toMatch(/host-review:migration.import-key:pin=1/);
  await repo.rename('updated label');expect((await service.current())?.phase).toBe('complete');
 }finally{store.close();await device.close();}
},30_000);

test('迁入连接拒绝已有同一私钥的真实设备',async()=>{
 await expect(openActualMigrationDevice(ProvisionMigrationConnection)).rejects.toThrow('device-already-has-key');
},30_000);

test('actual import endpoint rejects changed staged bytes, wrong private key and ordinary signature requests before physical import',async()=>{
 const device=await openActualMigrationDevice(ProvisionMigrationConnection,{importing:true});
 const store=createIndexedDbWalletStore({databaseName:'migration-import-negative-'+crypto.randomUUID()});
 const bootstrap=createVaultBootstrapStorage(store),pub=device.pub,secret=new Uint8Array(32);secret[31]=1;
 const source=await createAndVerifyMigrationKeyHold({bsvNetwork: "main" as const, privateKey:secret,publicKeyHex:pub,label:'same key'},'software-password');secret.fill(0);
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


test('空设备从源钱包接收 test 网络，保存证明后保留 test 身份而不改为 main',async()=>{
 const device=await openActualMigrationDevice(ProvisionMigrationConnection,{importing:true,bsvNetwork:'test'});
 const store=createIndexedDbWalletStore({databaseName:'migration-test-network-'+crypto.randomUUID()});
 const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
 const generation=crypto.randomUUID(),id=crypto.randomUUID(),secret=new Uint8Array(32);secret[31]=1;
 const source=await createAndVerifyMigrationKeyHold({bsvNetwork:'test',privateKey:secret,publicKeyHex:device.pub,label:'test identity'},'software-password');secret.fill(0);
 const key=await store.put(WALLET_KEYHOLD_PATH,source);
 await store.put(WALLET_META_PATH,encode({format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,walletGeneration:generation,createdAt:new Date().toISOString()}));
 const bootstrap=createVaultBootstrapStorage(store),repo=createWalletKeyRepository(bootstrap.keys);
 const service=createMigrationJournalService({store:bootstrap.migration,inspectKey:inspectWalletKeyBytes});
 try{
  const migration=createSoftwareToHardwareMigration({service,device:device.backend,assertExclusive(){},sourceBank:()=>service.sourceBank(device.pub),
   unlockSource:async()=> (await repo.unlock('software-password')).privateKeyBytes,
   hardwareDocument:j=>encode({bsvNetwork:j.bsvNetwork,format:'keymaster.hardware-key',version:1,backend:'vaultlink',wireVersion:2,label:'test identity',publicKeyHex:j.publicKeyHex,walletGeneration:j.walletGeneration,backendGeneration:1})});
  expect(await migration.run({migrationId:id,expectedRevision:key.revision})).toMatchObject({phase:'complete',bsvNetwork:'test',publicKeyHex:device.pub});
  expect(await repo.read()).toMatchObject({backend:'hardware',document:{bsvNetwork:'test',publicKeyHex:device.pub}});
 }finally{store.close();await device.close();}
},30_000);

// Refresh after the device has saved is a real one-sided commit, not a
// device-response stub: the browser source and its ledger must stay usable.
test('设备已保存但网页尚未提交时刷新：保留正常软件钱包，没有持久迁移中记录',async()=>{
 const device=await openActualMigrationDevice(ProvisionMigrationConnection,{importing:true});
 const databaseName='migration-interrupted-'+crypto.randomUUID();
 const store=createIndexedDbWalletStore({databaseName}),bootstrap=createVaultBootstrapStorage(store);
 const secret=new Uint8Array(32);secret[31]=1;
 const source=await createAndVerifyMigrationKeyHold({bsvNetwork:'main',privateKey:secret,publicKeyHex:device.pub,label:'original'},'source-password');
 const key=await store.put(WALLET_KEYHOLD_PATH,source),generation=crypto.randomUUID();
 const encode=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
 await store.put(WALLET_META_PATH,encode({format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,walletGeneration:generation,createdAt:new Date().toISOString()}));
 const service=createMigrationJournalService({store:bootstrap.migration,inspectKey:inspectWalletKeyBytes});
 let reopened:ReturnType<typeof createIndexedDbWalletStore>|undefined;
 try{
  const bank=await service.sourceBank(device.pub);
  const journal=await service.begin({migrationId:crypto.randomUUID(),expectedRevision:key.revision,policyBank:bank});
  await device.backend.stage(journal,bank);
  expect(await device.backend.prove(journal,secret)).toMatchObject({phase:'device-committed'});
  expect(await store.get(WALLET_MIGRATION_PATH)).toBeUndefined();
  store.close();reopened=createIndexedDbWalletStore({databaseName});
  const repo=createWalletKeyRepository(createVaultBootstrapStorage(reopened).keys);
  expect((await repo.read())?.backend).toBe('software');
  const unlocked=await repo.unlock('source-password');
  expect(unlocked.privateKeyBytes).toEqual(secret);unlocked.privateKeyBytes.fill(0);
  expect((await reopened.get(WALLET_KEYHOLD_PATH))?.bytes).toEqual(source);
  expect(await reopened.get(WALLET_MIGRATION_PATH)).toBeUndefined();
  expect(await device.backend.migrationStatus()).toMatchObject({phase:'device-committed'});
 }finally{secret.fill(0);store.close();reopened?.close();await device.close();}
},30_000);
