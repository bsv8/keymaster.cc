import {expect,test} from 'vitest';
import {migrationCoordinatorHarness} from './migration-coordinator-harness.js';
import {createIndexedDbWalletStore} from '../../../../packages/platform-storage/src/coordinator/index.js';
import {createVaultBootstrapStorage} from '../../../../packages/platform-storage/src/coordinator/vaultBootstrapStorage.js';
import {inspectWalletKeyBytes} from '../../../../packages/plugin-vault/src/walletKeyRepository.js';
import {createMigrationJournalService} from '../src/migration-journal.js';
import {WALLET_KEYHOLD_PATH} from '@keymaster/contracts';
import {__testColdBootCoordinator,__testSeedWalletLocalRecords} from '../../../../apps/web/src/keymasterSessionCoordinator.worker.js';
import {startActualMigrationDevice} from './native-migration-device.mjs';

const pub='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

test('未完成迁移冷启动保留数据，并发布 corrupt 以显示恢复入口',async()=>{
  const harness=await migrationCoordinatorHarness(pub),store=createIndexedDbWalletStore();
  try {
    const source=(await store.get(WALLET_KEYHOLD_PATH))!;
    const service=createMigrationJournalService({store:createVaultBootstrapStorage(store).migration,inspectKey:inspectWalletKeyBytes});
    const journal=await service.begin({migrationId:crypto.randomUUID(),expectedRevision:source.revision,policyBank:await service.sourceBank(pub)});
    expect(await __testColdBootCoordinator()).toMatchObject({status:'corrupt'});
    expect(harness.status()).toBe('locked');
    expect(await harness.coldStart()).toMatchObject({state:'corrupt',reason:expect.stringContaining('unfinished')});
    expect(await service.current()).toEqual(journal);
    expect((await store.get(WALLET_KEYHOLD_PATH))!.bytes).toEqual(source.bytes);
  } finally {store.close();await harness.close();}
});

for (const phase of ['prepared','local-committed'] as const) {
  test(`正式冷启动后从 ${phase} 恢复连接原设备并完成同身份迁入`,async()=>{
    const harness=await migrationCoordinatorHarness(pub),store=createIndexedDbWalletStore();
    let device:Awaited<ReturnType<typeof startActualMigrationDevice>>|undefined;
    const channel=new MessageChannel(),leaseId=crypto.randomUUID();
    let pump:Promise<void>|undefined;
    let connection:Promise<unknown>|undefined;
    try {
      const source=(await store.get(WALLET_KEYHOLD_PATH))!;
      const service=createMigrationJournalService({store:createVaultBootstrapStorage(store).migration,inspectKey:inspectWalletKeyBytes});
      const bank=await service.sourceBank(pub);
      const journal=await service.begin({migrationId:crypto.randomUUID(),expectedRevision:source.revision,policyBank:bank});
      if(phase==='local-committed') {
        await service.deviceCommitted(journal.migrationId,journal.policyHash);
        await service.commitLocal(journal.migrationId,new TextEncoder().encode(JSON.stringify({format:'keymaster.hardware-key',version:1,backend:'vaultlink',wireVersion:2,label:'same key',publicKeyHex:pub,walletGeneration:harness.walletGeneration,backendGeneration:1})),bank);
      }
      device=await startActualMigrationDevice({importing:true,...(phase==='local-committed'?{phase:'device-committed',journal}:{})});
      const actual=device;
      channel.port1.onmessage=async event=>{
        const m=event.data;if(m.lease!==leaseId)return;
        if(m.type==='write'){await actual.transport.write(m.bytes);channel.port1.postMessage({type:'written',lease:leaseId,id:m.id,ok:true});}
        else if(m.type==='close'){await actual.transport.close();channel.port1.close();}
      };
      pump=(async()=>{for(;;){const b=await actual.transport.read();if(b===null)break;try{channel.port1.postMessage({type:'data',lease:leaseId,bytes:b});}catch{break;}}})();
      expect(await __testColdBootCoordinator()).toMatchObject({status:'corrupt'});
      // 生产重启撤销旧页面订阅；重新附加测试宿主 peer，业务 handler 不变。
      harness.reconnect();
      connection=harness.vault.hardware({action:'recover-import',port:channel.port2,leaseId});
      void connection.catch(()=>{});
      await connection;
      await harness.vault.migrateToHardware(phase==='local-committed'?'':harness.password);
      expect((await service.current())?.phase).toBe('complete');
      expect(await __testColdBootCoordinator()).toMatchObject({status:'locked',walletGeneration:harness.walletGeneration});
      expect(await harness.coldStart()).toMatchObject({state:'ready',key:{backend:'hardware',publicKeyHex:pub}});
    } finally {
      store.close();await harness.close();channel.port1.close();channel.port2.close();await device?.close();await pump;
      await Promise.allSettled([connection]);
    }
  },30_000);
}

test('过新 schema 冷启动发布 unsupported，不误报数据库不可用',async()=>{
  const harness=await migrationCoordinatorHarness(pub);
  try {
    await __testSeedWalletLocalRecords({meta:JSON.stringify({format:'keymaster.wallet-meta',version:1,schemaVersion:999,initialized:true,walletGeneration:harness.walletGeneration,createdAt:new Date().toISOString()})});
    expect(await __testColdBootCoordinator()).toMatchObject({status:'unsupported'});
  } finally {await harness.close();}
});
