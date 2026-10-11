import {expect,test} from 'vitest';
import {startActualMigrationDevice} from './native-migration-device.mjs';
import {migrationCoordinatorHarness} from './migration-coordinator-harness.js';
import {__testColdBootCoordinator} from '../../../../apps/web/src/keymasterSessionCoordinator.worker.js';

test.each(['confirm','cancel'] as const)('正式 Coordinator：设备单边确认 %s；确认前禁止迁移；保留身份完成导入',async mode=>{
  const device=await startActualMigrationDevice({importing:true,manualPair:true});
  const harness=await migrationCoordinatorHarness(device.pub),channel=new MessageChannel(),leaseId=crypto.randomUUID();
  channel.port1.onmessage=async event=>{
    const m=event.data;if(m.lease!==leaseId)return;
    if(m.type==='write'){await device.transport.write(m.bytes);channel.port1.postMessage({type:'written',lease:leaseId,id:m.id,ok:true});}
    else if(m.type==='close'){await device.transport.close();channel.port1.close();}
  };
  const pump=(async()=>{for(;;){const b=await device.transport.read();if(b===null)break;try{channel.port1.postMessage({type:'data',lease:leaseId,bytes:b});}catch{break;}}})();
  let connection:Promise<unknown>|undefined;
  try {
    connection=harness.vault.hardware({action:'provision',port:channel.port2,leaseId});
    void connection.catch(()=>{});
    let state=await harness.vault.hardware({action:'state'});
    const deadline=Date.now()+5000;
    while(state.status!=='pairing'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,10));state=await harness.vault.hardware({action:'state'});}
    expect(state).toMatchObject({status:'pairing',leaseId});
    // The native device callback is reached by the real encrypted PAIR_CONFIRM,
    // before the host button adapter's approval; no browser approval is required.
    await expect.poll(()=>device.log()).toContain(`host-pair:${state.pairingCode}`);
    await expect(harness.vault.migrateToHardware(harness.password)).rejects.toThrow('hardware-provision-required');
    expect(harness.status()).toBe('unlocked');
    expect((await harness.vault.hardware({action:'state'})).status).toBe('pairing');
    if(mode==='cancel'){
      await harness.vault.hardware({action:'disconnect',leaseId});
      await expect(connection).rejects.toThrow();
      expect((await harness.vault.hardware({action:'state'})).status).toBe('disconnected');
      expect(harness.status()).toBe('unlocked');return;
    }
    device.approvePair();await connection;
    expect((await harness.vault.hardware({action:'state'})).status).toBe('connected');
    await harness.vault.migrateToHardware(harness.password);
    expect(await harness.coldStart()).toMatchObject({state:'ready',key:{backend:'hardware',publicKeyHex:device.pub},meta:{walletGeneration:harness.walletGeneration}});
    expect(harness.status()).toBe('locked');
    expect(device.log()).toContain('host-review:migration.import-key:pin=1');
    expect(await __testColdBootCoordinator()).toMatchObject({status:'locked',walletGeneration:harness.walletGeneration});
    expect(await harness.coldStart()).toMatchObject({state:'ready',key:{backend:'hardware',publicKeyHex:device.pub}});
  } finally {
    await harness.close();channel.port1.close();channel.port2.close();
    await Promise.allSettled([connection]);await device.close();await pump;
  }
},30_000);
