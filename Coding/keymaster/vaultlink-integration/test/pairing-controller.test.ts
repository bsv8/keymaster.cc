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
    const registrationBody={network:"main",channels:[
      {id:"identity.noise-proof",owner:"window-p2p",kind:"plugin",operation:"identity.noise-proof",mode:"automatic",revision:1},
      {id:"identity.peer-record",owner:"window-p2p",kind:"plugin",operation:"identity.peer-record",mode:"manual",revision:1},
    ]};
    const registration=client.submit("signing.register",registrationBody,await commitment("signing-register",1,registrationBody));
    await expect.poll(()=>device.log()).toContain('host-tone:2300');
    await new Promise(resolve=>setTimeout(resolve,2500));for(let i=0;i<8;i++){device.scrollReview();await new Promise(resolve=>setTimeout(resolve,1000));}device.approvePair();
    expect(await registration.result).toHaveProperty("channels");
    const wrapped=async(operation:string,body:import("@vaultlink/sdk").Value,hash:Uint8Array)=>{
      const request={channelId:operation,operation,body,commitment:hash};return {body:request,hash:await commitment("signing-request",1,request)};
    };
    const before=device.log();
    for(let index=0;index<3;++index){
      const body={staticKey:new Uint8Array(32).fill(index+7)};
      const review=await inspectNetworkIdentity('noise',body,unhex(device.pub));
      const request=await wrapped('identity.noise-proof',body,await commitment('libp2p-identity-noise',1,body));
      const result=await client.execute('signing.execute',request.body,request.hash) as {signature:Uint8Array};
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
    const recordRequest=await wrapped('identity.peer-record',recordBody,recordHash);
    const record=client.submit('signing.execute',recordRequest.body,recordRequest.hash);
    void record.result.catch(()=>{});
    await expect.poll(()=>device.log().slice(recordStart)).toContain('host-ui:pair-visible');
    await expect.poll(()=>device.log().slice(recordStart)).toContain('host-tone:2300');
    const cancelBody={requestId:record.requestId,commitment:recordRequest.hash};
    await client.execute('system.cancel',cancelBody,await commitment('system',1,{op:'system.cancel',...cancelBody}));
    expect(await record.result).toEqual({error:'cancelled'});
    expect(device.log().slice(recordStart)).not.toContain('host-tone:2600');
    const noiseBody={staticKey:new Uint8Array(32).fill(11)};
    const noiseReview=await inspectNetworkIdentity('noise',noiseBody,unhex(device.pub));
    const noiseRequest=await wrapped('identity.noise-proof',noiseBody,await commitment('libp2p-identity-noise',1,noiseBody));
    const noise=await client.execute('signing.execute',noiseRequest.body,noiseRequest.hash) as {signature:Uint8Array};
    verifyChannelSignature(noise.signature,noiseReview.digest,unhex(device.pub));
    await expect.poll(()=>device.log().slice(recordStart)).toContain('host-tone:2600');
    await client.close();await loop;
  }finally{await client?.close();await device.close();await loop;}
},60_000);
