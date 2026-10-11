import {test,expect} from 'vitest';
import {createIndexedDbWalletStore} from '../../../../packages/platform-storage/src/coordinator/index.js';
import {createVaultBootstrapStorage} from '../../../../packages/platform-storage/src/coordinator/vaultBootstrapStorage.js';
import {createWalletKeyRepository,inspectWalletKeyBytes} from '../../../../packages/plugin-vault/src/walletKeyRepository.js';
import {createAndVerifyMigrationKeyHold} from '../../../../packages/plugin-vault/src/migrationKeyHold.js';
import {WALLET_KEYHOLD_PATH,WALLET_META_PATH,WALLET_META_FORMAT,WALLET_CURRENT_SCHEMA_VERSION} from '@keymaster/contracts';
import {WALLET_PAYMENT_POLICY_PATH} from '@keymaster/contracts/storage-internal';
import {createHardwareToSoftwareMigration,createMigrationJournalService} from '../src/migration-journal.js';
import {VaultLinkHardwareBackend} from '../src/hardware-backend.js';
import {openActualMigrationDevice} from './native-migration-device.mjs';
import {parseStoredPaymentPolicy} from '../src/policy-storage.js';

// The IndexedDB API uses the repository's explicit Node storage adapter. USB
// physical events use the named HOST adapter; all protocol, KeyStore, KeyHold
// cryptography, ledger validation and transaction code are actual product code.
test('hard-to-soft: encrypted real device export → verified KeyHold → atomic browser commit → independent physical-PIN-model erase',async()=>{
 const device=await openActualMigrationDevice(VaultLinkHardwareBackend);
 const store=createIndexedDbWalletStore({databaseName:'migration-wire-'+crypto.randomUUID()});
 const generation=crypto.randomUUID(),id=crypto.randomUUID(),encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
 const document={bsvNetwork: "main" as const, format:'keymaster.hardware-key',version:1,backend:'vaultlink',wireVersion:2,label:'同一身份',publicKeyHex:device.pub,walletGeneration:generation,backendGeneration:1};
 const key=await store.put(WALLET_KEYHOLD_PATH,encode(document));
 await store.put(WALLET_META_PATH,encode({format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,walletGeneration:generation,createdAt:new Date().toISOString()}));
 const business=encode({contact:'保留联系人',messages:['保留消息']});await store.put(`main/${device.pub}/contacts/original`,business);
 const service=createMigrationJournalService({store:createVaultBootstrapStorage(store).migration,inspectKey:inspectWalletKeyBytes});
 let received:Uint8Array|undefined;
 try {
  const migration=createHardwareToSoftwareMigration({service,device:device.backend,assertExclusive(){if(!device.backend.isMigrating())throw Error('migration-pending');},
   async createAndVerifyKeyHold(privateKey,publicKeyHex){received=privateKey;return createAndVerifyMigrationKeyHold({bsvNetwork: "main" as const, privateKey,publicKeyHex,label:document.label},'new-software-password');}});
  const result=await device.backend.withMigration(()=>migration.run({migrationId:id,expectedRevision:key.revision}));
  expect(result).toMatchObject({phase:'complete',source:'hardware',target:'software',walletGeneration:generation,publicKeyHex:device.pub});
  expect(received?.every(v=>v===0)).toBe(true);
  expect((await store.get(`main/${device.pub}/contacts/original`))?.bytes).toEqual(business);
  const repo=createWalletKeyRepository(createVaultBootstrapStorage(store).keys),unlocked=await repo.unlock('new-software-password');
  try{expect(unlocked.document.publicKeyHex).toBe(device.pub);expect(unlocked.privateKeyBytes[31]).toBe(1);}finally{unlocked.privateKeyBytes.fill(0);}
  await expect(repo.unlock('wrong-password')).rejects.toBeDefined();
  const ledger=await store.get(`main/${device.pub}/${WALLET_PAYMENT_POLICY_PATH}`);expect(ledger).toBeDefined();
  expect(parseStoredPaymentPolicy(ledger!.bytes,device.pub)).toMatchObject({key:device.pub,version:2,pending:[],sessions:[]});
  expect((await service.read())?.journal.targetHash).toBe(result.targetHash);
  expect(device.log()).toMatch(/host-review:migration.export:pin=1/);expect(device.log()).toMatch(/host-review:migration.erase:pin=1/);
  await repo.rename('after migration');
  await repo.changePassword({oldPassword:'new-software-password',newPassword:'changed-software-password'});
  expect((await service.current())?.phase).toBe('complete');
 }finally{store.close();await device.close();}
},30_000);
