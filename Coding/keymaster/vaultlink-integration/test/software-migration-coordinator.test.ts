import {expect,test} from 'vitest';
import {startActualMigrationDevice} from './native-migration-device.mjs';
import {migrationCoordinatorHarness} from './migration-coordinator-harness.js';
import {__testColdBootCoordinator} from '../../../../apps/web/src/keymasterSessionCoordinator.worker.js';
import {createIndexedDbWalletStore} from '../../../../packages/platform-storage/src/coordinator/index.js';
import {createVaultBootstrapStorage} from '../../../../packages/platform-storage/src/coordinator/vaultBootstrapStorage.js';
import {inspectWalletKeyBytes} from '../../../../packages/plugin-vault/src/walletKeyRepository.js';
import {createMigrationJournalService} from '../src/migration-journal.js';
import {WALLET_KEYHOLD_PATH} from '@keymaster/contracts';

// The host adapter supplies explicit physical events. Migration, encrypted USB
// protocol, password wrapping, IndexedDB and Coordinator sessions are real.
test.each(['erase','retain','disconnect','unanswered','export-denied'] as const)('迁回流程：设备状态 %s，保存与可选擦除分别处理',async choice=>{
 const device=await startActualMigrationDevice({eraseDecision:'pending',denyExport:choice==='export-denied'});
 const harness=await migrationCoordinatorHarness(device.pub,'hardware');
 const channel=new MessageChannel(),leaseId=crypto.randomUUID();
 channel.port1.onmessage=async event=>{
  const m=event.data;if(m.lease!==leaseId)return;
  if(m.type==='write'){
   try{await device.transport.write(m.bytes);channel.port1.postMessage({type:'written',lease:leaseId,id:m.id,ok:true});}
   catch{channel.port1.postMessage({type:'written',lease:leaseId,id:m.id,ok:false});}
  }else if(m.type==='close'){await device.transport.close();channel.port1.close();}
 };
 const pump=(async()=>{for(;;){const bytes=await device.transport.read();if(bytes===null)break;try{channel.port1.postMessage({type:'data',lease:leaseId,bytes});}catch{break;}}})();
 try{
  await harness.vault.hardware({action:'attach',port:channel.port2,leaseId});
  expect(harness.status()).toBe('unlocked');
  const newPassword='new-software-password';
  if(choice==='export-denied'){
   await expect(harness.vault.migrateToSoftware(newPassword)).rejects.toThrow('denied');
   expect(harness.status()).toBe('unlocked');
   expect(await harness.vault.migrationState()).toBeNull();
   expect(await harness.coldStart()).toMatchObject({state:'ready',key:{backend:'hardware'}});
   expect(device.log()).toContain('host-export-choice:deny:key=1');
   return;
  }
  await harness.vault.migrateToSoftware(newPassword);
  expect(harness.status()).toBe('unlocked');
  expect(harness.vault.walletSnapshot().activeKeyIdentity?.backend).toBe('software');
  expect(await harness.coldStart()).toMatchObject({state:'ready',key:{backend:'software',publicKeyHex:device.pub}});
  expect(await harness.vault.migrationState()).toBeNull();
  // The migration returned while the independent erase decision is pending.
  await expect.poll(()=>device.log()).toContain('host-review:migration.erase:pin=0');
  expect(device.log()).toContain('host-review:migration.export:pin=0');
  await harness.vault.verifyPassword(newPassword);
  if(choice==='erase'){
   device.approveErase();
   await expect.poll(()=>device.log()).toContain('host-device-key:erased');
  }else if(choice==='retain'){
   device.denyErase();
   await expect.poll(()=>device.log()).toContain('host-erase-choice:keep:key=1');
  }else if(choice==='disconnect'){
   await harness.vault.hardware({action:'disconnect',leaseId});
  }
  expect(harness.status()).toBe('unlocked');
  await harness.vault.verifyPassword(newPassword);
  // Completed ciphertext survives a reboot regardless of a device response.
  expect(await __testColdBootCoordinator()).toMatchObject({status:'locked',walletGeneration:harness.walletGeneration});
  expect(await harness.coldStart()).toMatchObject({state:'ready',key:{backend:'software',publicKeyHex:device.pub}});
 }finally{
  await harness.close();channel.port1.close();channel.port2.close();
  await device.close();await pump;
 }
},30_000);
