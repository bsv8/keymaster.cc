import {expect,test} from 'vitest';
import {connectHost,secpIdentityVerifier,unhex,commitment,inspectNetworkIdentity,verifyChannelSignature} from '@vaultlink/sdk';
import {startActualMigrationDevice} from './native-migration-device.mjs';
test('真实 Controller/GPIO 去抖/长按确认/屏幕渲染完成配对，进度更新不清空整屏',async()=>{
  const device=await startActualMigrationDevice({controller:true});
  let client:Awaited<ReturnType<typeof connectHost>>|undefined,loop:Promise<void>|undefined;
  try {
    client=await connectHost(device.transport,{walletGeneration:1,backendGeneration:1,hostRunGeneration:1},unhex(device.pub),secpIdentityVerifier,
      async()=>{await expect.poll(()=>device.log()).toContain('host-ui:pair-visible');device.approvePair();return true;},[]);
    expect(device.log()).toContain('host-ui:pair-confirmed:full-redraws=0');
    loop=client.run();
    const before=device.log();
    for(let index=0;index<3;++index){
      const body={staticKey:new Uint8Array(32).fill(index+7)};
      const review=await inspectNetworkIdentity('noise',body,unhex(device.pub));
      const result=await client.execute('identity.noise-proof',body,await commitment('libp2p-identity-noise',1,body)) as {signature:Uint8Array};
      verifyChannelSignature(result.signature,review.digest,unhex(device.pub));
    }
    await expect.poll(()=>device.log().slice(before.length).match(/host-tone:2600/g)?.length??0).toBe(3);
    expect(device.log().slice(before.length)).not.toContain('host-tone:1700');
    expect(device.log().slice(before.length)).not.toContain('host-tone:2300');
    expect(device.log().slice(before.length)).not.toContain('host-ui:pair-visible');
    // A cancelled Peer Record must close its manual page without producing a
    // signature; a following Noise signature remains independently automatic.
    const recordBody={sequence:'1'},recordHash=await commitment('libp2p-identity-peer-record',1,recordBody);
    const recordStart=device.log().length;
    const record=client.submit('identity.peer-record',recordBody,recordHash);
    void record.result.catch(()=>{});
    await expect.poll(()=>device.log().slice(recordStart)).toContain('host-ui:pair-visible');
    await expect.poll(()=>device.log().slice(recordStart)).toContain('host-tone:2300');
    const cancelBody={requestId:record.requestId,commitment:recordHash};
    await client.execute('system.cancel',cancelBody,await commitment('system',1,{op:'system.cancel',...cancelBody}));
    expect(await record.result).toEqual({error:'cancelled'});
    expect(device.log().slice(recordStart)).not.toContain('host-tone:2600');
    const noiseBody={staticKey:new Uint8Array(32).fill(11)};
    const noiseReview=await inspectNetworkIdentity('noise',noiseBody,unhex(device.pub));
    const noise=await client.execute('identity.noise-proof',noiseBody,await commitment('libp2p-identity-noise',1,noiseBody)) as {signature:Uint8Array};
    verifyChannelSignature(noise.signature,noiseReview.digest,unhex(device.pub));
    await expect.poll(()=>device.log().slice(recordStart)).toContain('host-tone:2600');
    await client.close();await loop;
  }finally{await client?.close();await device.close();await loop;}
},30_000);
