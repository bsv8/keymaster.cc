import {expect,test} from 'vitest';
import {migrationCoordinatorHarness} from './migration-coordinator-harness.js';
import {createIndexedDbWalletStore} from '../../../../packages/platform-storage/src/coordinator/index.js';
import {createVaultBootstrapStorage} from '../../../../packages/platform-storage/src/coordinator/vaultBootstrapStorage.js';
import {inspectWalletKeyBytes} from '../../../../packages/plugin-vault/src/walletKeyRepository.js';
import {createMigrationJournalService} from '../src/migration-journal.js';
import {WALLET_MIGRATION_PATH} from '@keymaster/contracts/storage-internal';
import {WALLET_KEYHOLD_PATH} from '@keymaster/contracts';
import {__testColdBootCoordinator,__testSeedWalletLocalRecords} from '../../../../apps/web/src/keymasterSessionCoordinator.worker.js';
import {startActualMigrationDevice} from './native-migration-device.mjs';

const pub='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

test.each(['prepared','device-committed'] as const)('旧 %s 标记冷启动自动恢复完整软件钱包，保留原数据',async phase=>{
 const harness=await migrationCoordinatorHarness(pub),store=createIndexedDbWalletStore();
 try {
  const source=(await store.get(WALLET_KEYHOLD_PATH))!;
  const service=createMigrationJournalService({store:createVaultBootstrapStorage(store).migration,inspectKey:inspectWalletKeyBytes});
  const journal=await service.begin({migrationId:crypto.randomUUID(),expectedRevision:source.revision,policyBank:await service.sourceBank(pub)});
  // Exact bytes of the old product format, not an emulated storage backend.
  await store.put(WALLET_MIGRATION_PATH,new TextEncoder().encode(JSON.stringify({...journal,phase})));
  expect(await __testColdBootCoordinator()).toMatchObject({status:'locked'});
  expect(await harness.coldStart()).toMatchObject({state:'ready',key:{backend:'software'}});
  expect((await store.get(WALLET_KEYHOLD_PATH))!.bytes).toEqual(source.bytes);
  expect(await store.get(WALLET_MIGRATION_PATH)).toBeUndefined();
 }finally{store.close();await harness.close();}
});

test('过新 schema 冷启动发布 unsupported，不误报数据库不可用',async()=>{
  const harness=await migrationCoordinatorHarness(pub);
  try {
    await __testSeedWalletLocalRecords({meta:JSON.stringify({format:'keymaster.wallet-meta',version:1,schemaVersion:999,initialized:true,walletGeneration:harness.walletGeneration,createdAt:new Date().toISOString()})});
    expect(await __testColdBootCoordinator()).toMatchObject({status:'unsupported'});
  } finally {await harness.close();}
});
