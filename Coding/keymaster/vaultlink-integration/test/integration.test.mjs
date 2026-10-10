import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SoftwarePaymentGate, VaultLinkHardwareBackend } from '../dist/index.js';
import { DeviceIdentityKey, PaymentPolicy, P2pkhPaymentOperation, acceptDevice, DeviceServer,
  serializeTransaction, p2pkhScript, sha256d } from '@vaultlink/sdk';
const keyBytes = new Uint8Array(32); keyBytes[31] = 1;
const key = new DeviceIdentityKey(keyBytes);
const pub = Buffer.from(key.publicKey()).toString('hex');
const config = { id: 'channel', owner: 'app', kind: 'app', network: 'main', paymentType: 'p2pkh', enabled: true,
  singleLimit: 400n, defaultSessionLimit: 500n, revision: 1 };
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'keymaster-vlp-'));
  return { dir, value: {
    async load() { try { return JSON.parse(await readFile(join(dir, 'state'), 'utf8'), (_k, v) => v && typeof v === 'object' && '$big' in v ? BigInt(v.$big) : v && typeof v === 'object' && '$bytes' in v ? Uint8Array.from(v.$bytes) : v); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async save(s) { await writeFile(join(dir, 'temp'), JSON.stringify(s, (_k,v) => typeof v === 'bigint' ? { $big: String(v) } : v instanceof Uint8Array ? { $bytes: [...v] } : v)); await rename(join(dir,'temp'),join(dir,'state')); },
  }};
}
// 两端使用真实 SDK/密码及字节流；此宿主流不是硬件验证。
function pair() {
  const a = new TransformStream(), b = new TransformStream();
  function end(readable, writable) {
    const reader=readable.getReader(), writer=writable.getWriter(); let closed=false;
    return { async read(){ const r=await reader.read(); return r.done?null:r.value; }, async write(v){ await writer.write(v.slice()); }, async close(){ if(closed)return;closed=true;await Promise.allSettled([reader.cancel(),writer.abort()]); } };
  }
  return [end(a.readable,b.writable),end(b.readable,a.writable)];
}
async function payment(id) {
  const other = new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),2]));
  const previous=serializeTransaction({version:1,inputs:[{txid:new Uint8Array(32),vout:0xffffffff,script:Uint8Array.of(1),sequence:0xffffffff}],outputs:[{satoshis:1000n,script:p2pkhScript(key.publicKey())}],locktime:0});
  const rawTx=serializeTransaction({version:2,inputs:[{txid:await sha256d(previous),vout:0,script:new Uint8Array(),sequence:0xffffffff}],outputs:[{satoshis:300n,script:p2pkhScript(other.publicKey())},{satoshis:690n,script:p2pkhScript(key.publicKey())}],locktime:0});
  other.close(); return {rawTx,prevTransactions:[previous],channelId:'channel',paymentId:id,sessionId:'session',network:'main'};
}
test('wallet hardware adapter: actual handshake/proof, P2PKH response verified, auto then one cumulative approval', async()=>{
  const persisted=await store(); const deviceKey=new DeviceIdentityKey(keyBytes);
  const policy=await PaymentPolicy.open(persisted.value,pub);
  await policy.configure(config,true); await policy.startSession('session','app',true);
  const [host,device]=pair(); let prompts=0,hostPair=0,devicePair=0;
  let server;
  const serve=acceptDevice(device,deviceKey,1,1,async code=>{assert.match(code,/^\d{6}$/);devicePair++;return true;}).then(session=>{
    server=new DeviceServer(session,()=>{deviceKey.close();policy.lock();});
    server.register('tx.p2pkh-payment',new P2pkhPaymentOperation(deviceKey,policy,null,async()=>{prompts++;return {allow:true,raiseSessionLimit:1000n};}));
    return server.run();
  });
  let active=true;
  const backend=await VaultLinkHardwareBackend.connect(host,{publicKeyHex:pub,generations:{walletGeneration:1,backendGeneration:1,hostRunGeneration:1},assertActive(){if(!active)throw Error('stale');}},async()=>{hostPair++;return true;});
  try {
    const one=await backend.signP2pkh(await payment('one')); assert.equal(one.amount,300n);assert.equal(one.fee,10n);assert.equal(prompts,0);
    const two=await backend.signP2pkh(await payment('two'));assert.equal(two.signatures.length,1);assert.equal(prompts,1);
    assert.equal((await policy.snapshot()).sessions[0].used,600n);assert.equal(hostPair,1);assert.equal(devicePair,1);
    active=false; assert.throws(()=>backend.signP2pkh({}),/stale/);
  } finally { await backend.close();await serve;await rm(persisted.dir,{recursive:true,force:true}); }
});
test('software policy adapter retains signed/unknown quotas and current-session increase never changes defaults',async()=>{
  const persisted=await store();let active=true;const gate=await SoftwarePaymentGate.open(persisted.value,pub,()=>{if(!active)throw Error('stale');});
  try {
    await gate.configure(config,async()=>true);await gate.startSession('session','app',async()=>true);
    let prompts=0,signs=0; const inspection=id=>({requestId:id,channelId:'channel',owner:'app',kind:'app',sessionId:'session',network:'main',paymentType:'p2pkh',amount:300n,commitment:Uint8Array.from([...new Uint8Array(31),1])});
    const confirm=async()=>{prompts++;return {allow:true,raiseSessionLimit:1200n};};
    await gate.execute(inspection('one'),confirm,async()=>{signs++;return 'signed';});assert.equal(prompts,0);
    await gate.execute(inspection('two'),confirm,async()=>{signs++;return 'signed';});assert.equal(prompts,1);
    await assert.rejects(gate.execute(inspection('three'),confirm,async()=>{throw Error('unknown-after-sign');}),/unknown-after-sign/);
    const snap=await gate.snapshot();assert.equal(snap.sessions[0].used,900n);assert.equal(snap.sessions[0].limit,1200n);assert.equal(snap.channels[0].defaultSessionLimit,500n);assert.equal(signs,2);
    await assert.rejects(gate.execute(inspection('one'),confirm,async()=>{signs++;}),/request-reuse/);
    active=false;await assert.rejects(gate.execute(inspection('four'),confirm,async()=>{}),/stale/);
  } finally {gate.lock();await rm(persisted.dir,{recursive:true,force:true});}
});
test('trusted plugin pays at the single limit without a session; excess needs approval and denial never signs',async()=>{
  const persisted=await store();
  const gate=await SoftwarePaymentGate.open(persisted.value,pub,()=>{});
  try {
    await gate.configure({...config,id:'plugin-channel',owner:'plugin',kind:'plugin',defaultSessionLimit:0n},async()=>true);
    let prompts=0,signs=0;
    const inspection=(id,amount)=>({requestId:id,channelId:'plugin-channel',owner:'plugin',kind:'plugin',sessionId:null,network:'main',paymentType:'p2pkh',amount,commitment:Uint8Array.from([...new Uint8Array(31),2])});
    const approve=async(_request,quote)=>{prompts++;assert.deepEqual(quote.reasons,['single-limit']);assert.equal(quote.sessionLimit,null);return {allow:true};};
    const sign=async()=>{signs++;return 'signed';};
    await gate.execute(inspection('plugin-one',400n),approve,sign);
    await gate.execute(inspection('plugin-two',400n),approve,sign);
    assert.equal(prompts,0); // 插件没有累计额度，两笔合计超过单笔额度也不询问。
    await assert.rejects(gate.execute(inspection('plugin-denied',401n),async()=>({allow:false}),sign),/denied/);
    assert.equal(signs,2);
    await gate.execute(inspection('plugin-three',401n),approve,sign);
    assert.equal(prompts,1);assert.equal(signs,3);
    assert.equal((await gate.snapshot()).sessions.length,0);
  } finally {gate.lock();await rm(persisted.dir,{recursive:true,force:true});}
});
test('one App connection aggregates channels and approval alone never increases or resets its limit',async()=>{
  const persisted=await store();
  const gate=await SoftwarePaymentGate.open(persisted.value,pub,()=>{});
  try {
    await gate.configure(config,async()=>true);
    await gate.configure({...config,id:'second-channel'},async()=>true);
    await gate.startSession('connection','app',async()=>true);
    const inspection=(id,channelId,amount)=>({requestId:id,channelId,owner:'app',kind:'app',sessionId:'connection',network:'main',paymentType:'p2pkh',amount,commitment:Uint8Array.from([...new Uint8Array(31),3])});
    let prompts=0;
    const confirm=async(_request,quote)=>{prompts++;assert.deepEqual(quote.reasons,['session-limit']);return {allow:true};};
    await gate.execute(inspection('a','channel',300n),confirm,async()=>{});
    await gate.execute(inspection('b','second-channel',200n),confirm,async()=>{});
    assert.equal(prompts,0); // 等于总额度自动授权。
    await gate.execute(inspection('c','second-channel',1n),confirm,async()=>{});
    await gate.execute(inspection('d','channel',1n),confirm,async()=>{});
    assert.equal(prompts,2);
    const snapshot=await gate.snapshot();
    assert.equal(snapshot.sessions[0].used,502n);assert.equal(snapshot.sessions[0].limit,500n);
  } finally {gate.lock();await rm(persisted.dir,{recursive:true,force:true});}
});
test('cancellation checked after durable reservation but before crypto releases only a proven unsigned payment',async()=>{
 const persisted=await store(), deviceKey=new DeviceIdentityKey(keyBytes);
 const gate=await SoftwarePaymentGate.open(persisted.value,pub,()=>{});
 try{
  await gate.configure(config,async()=>true);await gate.startSession('session','app',async()=>true);
  const inspection=id=>({requestId:id,channelId:'channel',owner:'app',kind:'app',sessionId:'session',network:'main',paymentType:'p2pkh',amount:300n,commitment:Uint8Array.from([...new Uint8Array(31),7])});
  let signatures=0;
  const tx=await payment('fixture');
  const sign=async()=>{signatures++;return deviceKey.signAllP2pkh(tx.rawTx,tx.prevTransactions.map(transaction=>({transaction})),new AbortController().signal,async()=>{});};
  await assert.rejects(gate.execute(inspection('cancelled-before-key'),async()=>({allow:true}),sign,()=>{throw Error('payment-cancelled');}),/payment-cancelled/);
  assert.equal(signatures,0);
  const snapshot=await gate.snapshot();assert.equal(snapshot.sessions[0].used,0n);
  assert.equal(snapshot.pending.find(p=>p.id==='cancelled-before-key').state,'released');
  await assert.rejects(gate.execute(inspection('cancelled-before-key'),async()=>({allow:true}),sign),/request-reuse/);
  const der=await gate.execute(inspection('new-payment'),async()=>({allow:true}),sign);
  assert.equal(der.length,1);assert.ok(der[0].length>=9);assert.equal(signatures,1);assert.equal((await gate.snapshot()).sessions[0].used,300n);
 }finally{gate.lock();deviceKey.close();await rm(persisted.dir,{recursive:true,force:true});}
});
