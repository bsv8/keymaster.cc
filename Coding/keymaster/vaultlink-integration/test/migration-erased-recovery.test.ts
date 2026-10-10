import {test,expect} from 'vitest';
import {createIndexedDbWalletStore} from '../../../../packages/platform-storage/src/coordinator/index.js';
import {createVaultBootstrapStorage} from '../../../../packages/platform-storage/src/coordinator/vaultBootstrapStorage.js';
import {createWalletKeyRepository,inspectWalletKeyBytes} from '../../../../packages/plugin-vault/src/walletKeyRepository.js';
import {createAndVerifyMigrationKeyHold} from '../../../../packages/plugin-vault/src/migrationKeyHold.js';
import {WALLET_KEYHOLD_PATH,WALLET_META_PATH,WALLET_META_FORMAT,WALLET_CURRENT_SCHEMA_VERSION} from '@keymaster/contracts';
import {encodePaymentPolicy,commitment,type ProtocolClient} from '@vaultlink/sdk';
import {createMigrationJournalService,verifyDeviceMigrationJournal} from '../src/migration-journal.js';
import {ErasedMigrationConnection} from '../src/erased-migration-connection.js';
import {openActualMigrationDevice} from './native-migration-device.mjs';
const publicKeyHex='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
for(const phase of ['erasing','erased'])test(`committed browser + actual empty-device ${phase} fixture: temporary paired identity has receipt-only authority`,async()=>{
 // Deliberately seeded COMMIT-POINT fixture. Does not claim a physical prior
 // browser/device session or a real flash power cut. Both resumes execute the
 // actual SDK encryption, KeyStore erase, journal and IndexedDB commit code.
 const store=createIndexedDbWalletStore({databaseName:'erased-migration-'+crypto.randomUUID()}),generation=crypto.randomUUID();
 const encode=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v));
 const source=await store.put(WALLET_KEYHOLD_PATH,encode({format:'keymaster.hardware-key',version:1,backend:'vaultlink',wireVersion:2,label:'保持身份',publicKeyHex,walletGeneration:generation,backendGeneration:1}));
 await store.put(WALLET_META_PATH,encode({format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,walletGeneration:generation,createdAt:new Date().toISOString()}));
 const service=createMigrationJournalService({store:createVaultBootstrapStorage(store).migration,inspectKey:inspectWalletKeyBytes});
 const bank=encodePaymentPolicy({version:2,key:publicKeyHex,channels:[],sessions:[],pending:[],pools:[]},publicKeyHex);
 const id=crypto.randomUUID(),journal=await service.begin({migrationId:id,expectedRevision:source.revision,policyBank:bank});
 await service.deviceCommitted(id,journal.policyHash);const privateKey=new Uint8Array(32);privateKey[31]=1;
 try{const target=await createAndVerifyMigrationKeyHold({privateKey,publicKeyHex,label:'保持身份'},'new-software-password');await service.commitLocal(id,target,bank);}finally{privateKey.fill(0);}
 const committed=(await service.current())!;
 const d=await openActualMigrationDevice(ErasedMigrationConnection,{phase,journal:committed});
 try{
  const portal=d.backend as ErasedMigrationConnection;
  expect(verifyDeviceMigrationJournal(committed,await portal.migrationStatus()).phase).toBe(phase);
  // Adversarial wire request through the actual host client: the temporary
  // transport identity must NOT make a wiped device a signing wallet.
  const client=(portal as unknown as {client:ProtocolClient}).client,body={staticKey:new Uint8Array(32).fill(7)};
  expect(await client.execute('identity.noise-proof',body,await commitment('network-noise-proof',1,body))).toMatchObject({error:'unsupported'});
  const receipt=await portal.finishErase();expect(verifyDeviceMigrationJournal(committed,receipt).phase).toBe('erased');
  await service.finish(id);const complete=(await service.current())!;await portal.completeDevice(complete);
  expect((await portal.migrationStatus()).phase).toBe('complete');
  const unlocked=await createWalletKeyRepository(createVaultBootstrapStorage(store).keys).unlock('new-software-password');
  try{expect(unlocked.document.publicKeyHex).toBe(publicKeyHex);}finally{unlocked.privateKeyBytes.fill(0);}
  if(phase==='erasing')expect(d.log()).toMatch(/host-review:migration.recover-erased:pin=0/);
  else expect(d.log()).not.toMatch(/host-review:migration.recover-erased/);
 }finally{await d.close();store.close();}
},30_000);
