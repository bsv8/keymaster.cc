import {nativeSdkSources} from './native-sdk-sources.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {VaultLinkHardwareBackend,WorkerUsbTransport} from '../dist/index.js';
import {DeviceIdentityKey, serializeTransaction, p2pkhScript, feePoolScript, parseTransaction, sha256d, hex} from '@vaultlink/sdk';
import {encode,sha256,secpIdentityVerifier} from '@vaultlink/sdk';
// 运行实际 RocKey 产品支付服务与 C++ Endpoint；确认由公开测试 harness 控制，非 USB/按钮验收。
test('Keymaster SDK interoperates with actual RocKey C++ payment service: configuration, session, auto quota, over-limit physical-approval adapter and signatures',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rockey-vlp-native-'));
 const root=process.env.ROCKEY_ROOT ?? join(fileURLToPath(new URL('../../../../../',import.meta.url)),'Rockey');
 const prefix=process.env.VLP_MBEDTLS_PREFIX ?? '/opt/homebrew/opt/mbedtls@3';
 const exe=join(dir,'device');
 const compiled=spawnSync(process.env.CXX ?? 'c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',`-I${prefix}/include`,...nativeSdkSources(root),join(root,'Coding/Rockey/vaultlink-integration/tests/native.cpp'),`-L${prefix}/lib`,`-Wl,-rpath,${prefix}/lib`,'-lmbedtls','-lmbedx509','-lmbedcrypto','-o',exe],{encoding:'utf8'});
 assert.equal(compiled.status,0,compiled.stderr);
 const device=spawn(exe,[join(dir,'policy')]);let log='';device.stderr.setEncoding('utf8');device.stderr.on('data',s=>log+=s);
 const exited=once(device,'exit');const iterator=device.stdout[Symbol.asyncIterator]();
 const transport={async read(){const r=await iterator.next();return r.done?null:new Uint8Array(r.value);},async write(bytes){if(!device.stdin.write(bytes))await once(device.stdin,'drain');},async close(){device.stdin.end();}};
 // 使用真实 MessageChannel 转发字节到真实 C++ 设备端，Worker 不直接占用串口。
 const bridge=new MessageChannel(),lease=crypto.randomUUID();
 bridge.port1.onmessage=async e=>{const m=e.data;if(m.lease!==lease)return;if(m.type==='write'){try{await transport.write(m.bytes);bridge.port1.postMessage({type:'written',lease,id:m.id,ok:true});}catch{bridge.port1.postMessage({type:'closed',lease});}}else if(m.type==='close'){await transport.close();bridge.port1.close();}};
 void(async()=>{while(true){const bytes=await transport.read();if(bytes===null)break;for(let at=0;at<bytes.length;at+=4096)bridge.port1.postMessage({type:'data',lease,bytes:bytes.slice(at,at+4096)});}try{bridge.port1.postMessage({type:'closed',lease});}catch{}})();
 const bridged=new WorkerUsbTransport(bridge.port2,lease);
 const secret=new Uint8Array(32);secret[31]=1;const key=new DeviceIdentityKey(secret);const publicKeyHex=hex(key.publicKey());
 let backend;
 try{
  backend=await VaultLinkHardwareBackend.connect(bridged,{bsvNetwork: "main", publicKeyHex,generations:{walletGeneration:1,backendGeneration:1,hostRunGeneration:1},assertActive(){}},async code=>{assert.match(code,/^\d{6}$/);return true;});
  const connection=crypto.randomUUID();
  const config={id:'app-channel',owner:'app',kind:'app',network:'main',paymentType:'p2pkh',enabled:true,singleLimit:400n,defaultSessionLimit:500n,revision:1};
  await backend.configureChannel(config);assert.equal((await backend.readChannel(config.id)).owner,'app');
  await backend.startAppSession(connection,'app');
  const other=new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),2]));
  const prev=serializeTransaction({version:1,inputs:[{txid:new Uint8Array(32),vout:0xffffffff,script:Uint8Array.of(1),sequence:0xffffffff}],outputs:[{satoshis:1000n,script:p2pkhScript(key.publicKey())},...Array.from({length:40},()=>({satoshis:0n,script:p2pkhScript(key.publicKey())}))],locktime:0});
  const rawTx=serializeTransaction({version:1,inputs:[{txid:await sha256d(prev),vout:0,script:new Uint8Array(),sequence:0xffffffff}],outputs:[{satoshis:300n,script:p2pkhScript(other.publicKey())},{satoshis:690n,script:p2pkhScript(key.publicKey())}],locktime:0});other.close();
  const payment=id=>({rawTx,prevTransactions:[prev],channelId:config.id,paymentId:id,sessionId:connection,network:'main'});
  assert.equal((await backend.signP2pkh(payment('one'))).amount,300n);
  assert.equal((log.match(/review:tx.p2pkh-payment/g)??[]).length,0);
  assert.equal((await backend.signP2pkh(payment('two'))).fee,10n);
  assert.equal((log.match(/review:tx.p2pkh-payment/g)??[]).length,1);
  const session=await backend.readAppSession(connection);assert.equal(BigInt(session.used),600n);assert.equal(BigInt(session.limit),500n);
  await assert.rejects(backend.signP2pkh(payment('one')),/request-reuse/);
  await backend.configureChannel({...config,id:'plugin-channel',owner:'plugin',kind:'plugin',singleLimit:300n,defaultSessionLimit:0n});
  assert.equal((await backend.signP2pkh({...payment('plugin-one'),channelId:'plugin-channel',sessionId:null})).amount,300n);
  assert.equal((log.match(/review:tx.p2pkh-payment/g)??[]).length,1);
  const beforeResume = await backend.readAppSession(connection);
  const promptsBeforeResume = (log.match(/review:payment.session-open/g)??[]).length;
  await backend.startAppSession(connection,'app');
  assert.deepEqual(await backend.readAppSession(connection),beforeResume);
  assert.equal((log.match(/review:payment.session-open/g)??[]).length,promptsBeforeResume);
  const peer=new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),2])), arbiter=new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),3]));
  for(const family of ['connect','bitfs']){
    const id=family==='connect'?'connect.'+'a'.repeat(64)+'.feepool.connect.main':'bitfs.buyer.main';await backend.configureChannel({...config,id,paymentType:`feepool.${family}`});
    const keys=family==='connect'?[peer.publicKey(),key.publicKey()]:[key.publicKey(),peer.publicKey(),arbiter.publicKey()];
    let fund=serializeTransaction({version:1,inputs:[{txid:await sha256d(prev),vout:0,script:new Uint8Array(),sequence:0xfffffffe}],outputs:[{satoshis:900n,script:feePoolScript(keys)},{satoshis:90n,script:p2pkhScript(key.publicKey())}],locktime:0});
    const context={channelId:id,sessionId:connection,network:'main',family};
    const funded=await backend.signFeePool({...context,stage:'fund',rawTx:fund,prevTransactions:[prev],paymentId:crypto.randomUUID()});assert.equal(funded.amount,0n);
    // 后续使用真正完整的、带该设备返回签名的 FundingTx；不能用空 scriptSig 缩小报文。
    const tx=parseTransaction(fund),sig=funded.signatures[0],pub=key.publicKey();
    tx.inputs[0].script=Uint8Array.from([sig.length,...sig,pub.length,...pub]);fund=serializeTransaction(tx);
    const state=paid=>serializeTransaction({version:1,inputs:[{txid:sha,vout:0,script:new Uint8Array(),sequence:0xfffffffe}],outputs:keys.map(k=>({satoshis:hex(k)===publicKeyHex?890n-paid:hex(k)===hex(peer.publicKey())?paid:0n,script:p2pkhScript(k)})),locktime:0});
    const sha=await sha256d(fund);
    let authorization;
    if(family==='bitfs') {
      await backend.configureChannel({...config,id:'bitfs.authorization',owner:'msfile',kind:'plugin',paymentType:'feepool.bitfs',singleLimit:400n,defaultSessionLimit:0n});
      const original=parseTransaction(state(0n));original.inputs[0].sequence=0;original.locktime=500;const refundTemplate=serializeTransaction(original);
      const target=parseTransaction(state(100n));target.inputs[0].sequence=1;
      const document=encode([await sha256(Uint8Array.of(7)),await sha256d(refundTemplate),1,100n,encode([await sha256(Uint8Array.of(1,2,3))]),2000],16384);
      authorization={document,refundTemplate};
      const signed=await backend.signFeePool({family:'bitfs',stage:'state',rawTx:serializeTransaction(target),prevTransactions:[fund],channelId:'bitfs.authorization',paymentId:crypto.randomUUID(),sessionId:null,network:'main',authorization});
      assert.equal(signed.amount,100n);assert.equal((log.match(/review:tx.feepool-bitfs-authorize/g)??[]).length,0);
      const digest=await sha256(encode(['bitfs/wire-signature',1,5,document],32768));assert.equal(secpIdentityVerifier.verify(digest,signed.signatures[0],key.publicKey()),true);
      await assert.rejects(backend.signBitfsWire(5,document),/payment-context-required/);
      await assert.rejects(backend.signFeePool({family:'bitfs',stage:'state',rawTx:serializeTransaction(target),prevTransactions:[fund],channelId:'bitfs.authorization',paymentId:crypto.randomUUID(),sessionId:null,network:'main',authorization:{...authorization,document:encode([await sha256(Uint8Array.of(7)),await sha256d(refundTemplate),1,101n,encode([await sha256(Uint8Array.of(1,2,3))]),2000],16384)}}),/invalid-authorization/);
    }
    for(const [phase,paid,amount] of [['first',100n,100n],['next',150n,50n],['close',150n,0n]]){
      const before=BigInt((await backend.readAppSession(connection)).used);
      const response=await backend.signFeePool({...context,stage:'state',rawTx:state(paid),prevTransactions:[fund],paymentId:crypto.randomUUID()});
      const actual=family==='bitfs'&&phase==='first'?0n:amount;
      assert.equal(response.amount,actual);assert.equal(BigInt((await backend.readAppSession(connection)).used),before+actual);
    }
    await assert.rejects(backend.signFeePool({...context,stage:'state',rawTx:state(149n),prevTransactions:[fund],paymentId:crypto.randomUUID()}),/payment-rollback/);
    if(authorization){
      const target=parseTransaction(state(600n));target.inputs[0].sequence=0xfffffffe;
      const document=encode([await sha256(Uint8Array.of(7)),await sha256d(authorization.refundTemplate),0xfffffffe,600n,encode([await sha256(Uint8Array.of(4,5,6))]),2000],16384);
      const signed=await backend.signFeePool({family:'bitfs',stage:'state',rawTx:serializeTransaction(target),prevTransactions:[fund],channelId:'bitfs.authorization',paymentId:crypto.randomUUID(),sessionId:null,network:'main',authorization:{...authorization,document}});
      assert.equal(signed.amount,450n);assert.equal((log.match(/review:tx.feepool-bitfs-authorize/g)??[]).length,1);
      const before=(log.match(/review:tx.feepool-bitfs/g)??[]).length;
      assert.equal((await backend.signFeePool({...context,stage:'state',rawTx:serializeTransaction(target),prevTransactions:[fund],paymentId:crypto.randomUUID()})).amount,0n);
      assert.equal((log.match(/review:tx.feepool-bitfs/g)??[]).length,before);
    }
  }
  await backend.configureChannel({...config,id:'protocol.standard',owner:'forum',kind:'plugin',paymentType:'bsv.standard',singleLimit:400n,defaultSessionLimit:0n});
  const standard=serializeTransaction({version:1,inputs:[{txid:await sha256d(prev),vout:0,script:new Uint8Array(),sequence:0xfffffffe}],outputs:[{satoshis:100n,script:Uint8Array.from([33,...peer.publicKey(),0xac])},{satoshis:890n,script:p2pkhScript(key.publicKey())}],locktime:0});
  const result=await backend.signStandard({rawTx:standard,prevTransactions:[prev],channelId:'protocol.standard',paymentId:crypto.randomUUID(),sessionId:null,network:'main'});
  assert.equal(result.amount,100n);assert.equal(result.fee,10n);
  const secret=new Uint8Array(512).map((_,i)=>i%251);
  const sealed=await backend.sealLocalSecret('storage.bucket-password',secret);
  assert.deepEqual(await backend.openLocalSecret('storage.bucket-password',sealed),secret);
  await assert.rejects(backend.openLocalSecret('other.scope',sealed),/invalid-secret/);
  const altered={...sealed,ciphertextHex:(sealed.ciphertextHex.startsWith('00')?'01':'00')+sealed.ciphertextHex.slice(2)};
  await assert.rejects(backend.openLocalSecret('storage.bucket-password',altered),/invalid-secret/);
  assert.deepEqual(await backend.openLocalSecret('storage.bucket-password',sealed),secret);
  assert.throws(()=>backend.sealLocalSecret('storage.bucket-password',new Uint8Array(513)),/invalid-secret/);
  secret.fill(0);
  const beforeClose = await backend.readAppSession(connection);
  await backend.closeAppSession(connection); await backend.closeAppSession(connection);
  const afterClose = await backend.readAppSession(connection);
  assert.equal(afterClose.active,false); assert.equal(afterClose.used,beforeClose.used);
  await assert.rejects(backend.startAppSession(connection,'app'),/invalid-session/);
  await assert.rejects(backend.signP2pkh(payment('after-close')),/invalid-session/);
  peer.close();arbiter.close();
 } finally {
  key.close();if(backend)await backend.close();else device.stdin.end();
  const timer=setTimeout(()=>device.kill('SIGKILL'),3000);
  const [code]=await exited;clearTimeout(timer);await rm(dir,{recursive:true,force:true});assert.equal(code,0,log);
 }
});

// 实际服务的持续授权/否决/撤销/断链检查，确认来自明确的宿主输入适配。
test('RocKey scope decisions: once, session allow/deny, revoke, capacity and disconnect use actual service',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rockey-vlp-grants-'));
 const root=process.env.ROCKEY_ROOT??join(fileURLToPath(new URL('../../../../../',import.meta.url)),'Rockey');
 const prefix=process.env.VLP_MBEDTLS_PREFIX??'/opt/homebrew/opt/mbedtls@3', exe=join(dir,'scope');
 try{
  const cc=spawnSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',`-I${prefix}/include`,...nativeSdkSources(root),join(root,'Coding/Rockey/vaultlink-integration/tests/scope_grants.cpp'),`-L${prefix}/lib`,`-Wl,-rpath,${prefix}/lib`,'-lmbedtls','-lmbedcrypto','-o',exe],{encoding:'utf8'});
  assert.equal(cc.status,0,cc.stderr);const run=spawnSync(exe,[join(dir,'policy')],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.match(run.stdout,/production service checks passed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

// 真实协议取消等待按钮的设备请求；预算和会话关闭使用同一持久产品账本。
test('RocKey cancels awaiting approval outside FIFO and retains App session on USB reconnect',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rockey-vlp-cancel-'));
 const root=process.env.ROCKEY_ROOT??join(fileURLToPath(new URL('../../../../../',import.meta.url)),'Rockey');
 const prefix=process.env.VLP_MBEDTLS_PREFIX??'/opt/homebrew/opt/mbedtls@3',exe=join(dir,'device');
 const cc=spawnSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',`-I${prefix}/include`,...nativeSdkSources(root),join(root,'Coding/Rockey/vaultlink-integration/tests/native.cpp'),`-L${prefix}/lib`,`-Wl,-rpath,${prefix}/lib`,'-lmbedtls','-lmbedx509','-lmbedcrypto','-o',exe],{encoding:'utf8'});
 assert.equal(cc.status,0,cc.stderr);
 const key=new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),1])),peer=new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),2]));
 const sessionId=crypto.randomUUID();
 const previous=serializeTransaction({version:1,inputs:[{txid:new Uint8Array(32),vout:0xffffffff,script:Uint8Array.of(1),sequence:0xffffffff}],outputs:[{satoshis:1000n,script:p2pkhScript(key.publicKey())}],locktime:0});
 const rawTx=serializeTransaction({version:1,inputs:[{txid:await sha256d(previous),vout:0,script:new Uint8Array(),sequence:0xffffffff}],outputs:[{satoshis:300n,script:p2pkhScript(peer.publicKey())},{satoshis:690n,script:p2pkhScript(key.publicKey())}],locktime:0});
 const config={id:'cancel-app',owner:'app',kind:'app',network:'main',paymentType:'p2pkh',enabled:true,singleLimit:300n,defaultSessionLimit:300n,revision:1};
 try{
  for(const phase of ['first','reconnect']){
   const child=spawn(exe,[join(dir,'policy')],{env:{...process.env,ROCKEY_HOST_HOLD_PAYMENT:'1'}});
   const exited=once(child,'exit');let log='';child.stderr.setEncoding('utf8');child.stderr.on('data',s=>log+=s);
   const iterator=child.stdout[Symbol.asyncIterator]();let backend;
   try{
    backend=await VaultLinkHardwareBackend.connect({async read(){const v=await iterator.next();return v.done?null:new Uint8Array(v.value);},async write(b){if(!child.stdin.write(b))await once(child.stdin,'drain');},async close(){child.stdin.end();}},
     {bsvNetwork: "main", publicKeyHex:hex(key.publicKey()),generations:{walletGeneration:1,backendGeneration:1,hostRunGeneration:phase==='first'?1:2},assertActive(){}},async()=>true);
    if(phase==='first'){
     await backend.configureChannel(config);await backend.startAppSession(sessionId,'app');
     const payment=id=>({rawTx,prevTransactions:[previous],channelId:config.id,paymentId:id,sessionId,network:'main'});
     assert.equal((await backend.signP2pkh(payment('first'))).amount,300n);
     const waiting=backend.signP2pkh(payment('awaiting')).then(value=>({value}),error=>({error}));
     const queued=backend.signP2pkh(payment('queued')).then(value=>({value}),error=>({error}));
     const deadline=Date.now()+3000;
     while(!log.includes('review:tx.p2pkh-payment')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
     assert.match(log,/review:tx.p2pkh-payment/);
     assert.deepEqual(await backend.activity(), {operation:'tx.p2pkh-payment', state:'awaiting-user'});
     await backend.cancelAppRequests(sessionId);
     assert.match((await waiting).error.message,/payment-cancelled/);
     assert.match((await queued).error.message,/payment-cancelled/);
     assert.deepEqual(await backend.activity(), {operation:'tx.p2pkh-payment', state:'cancelled'});
     const state=await backend.readAppSession(sessionId);assert.equal(BigInt(state.used),300n);assert.equal(state.active,true);
    }else{
     const before=await backend.readAppSession(sessionId);assert.equal(BigInt(before.used),300n);assert.equal(before.active,true);
     await backend.startAppSession(sessionId,'app');assert.deepEqual(await backend.readAppSession(sessionId),before);
     await backend.closeAppSession(sessionId);assert.equal((await backend.readAppSession(sessionId)).active,false);
     assert.equal(BigInt((await backend.readAppSession(sessionId)).used),300n);
    }
   }finally{
    await backend?.close();child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
    const [code]=await exited;clearTimeout(timer);assert.equal(code,0,log);
   }
  }
 }finally{key.close();peer.close();await rm(dir,{recursive:true,force:true});}
});
