// 产品钱包核心：真实磁盘 CAS、交易前序证据和 secp256k1 签名，不替换额度执行器。
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {WalletPayments} from '../dist/index.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {DeviceIdentityKey,serializeTransaction,p2pkhScript,sha256d,hex,unhex,parseTransaction,p2pkhSighash} from '@vaultlink/sdk';
import {encode,feePoolScript,sha256,bitfsWireDigest} from '@vaultlink/sdk';
const secret=unhex('00'.repeat(31)+'01');
const key=new DeviceIdentityKey(secret), other=new DeviceIdentityKey(unhex('00'.repeat(31)+'02'));
const revision=b=>createHash('sha256').update(b).digest('hex');
async function pending(wallet) {
  // 有期限的事件等待；失败不能挂到核心的 120 秒人工确认期限。
  for(let i=0;i<100;i++) {
    const rows=await wallet.handle({action:'pending'});
    if(rows.length) return rows[0];
    await new Promise(r=>setTimeout(r,5));
  }
  throw Error('approval did not become pending');
}
test('software core accounts Kind 5 before signing: under-limit automatic, over-limit approval, rejection, and no second charge for Kind 7',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'km-bitfs-authorization-')),file=join(dir,'policy');
 const files={async get(){try{const bytes=new Uint8Array(await readFile(file));return {bytes,revision:revision(bytes)};}catch(e){if(e.code==='ENOENT')return;throw e;}},
  async put(_path,bytes,condition){const old=await this.get();if(condition.ifNoneMatch&&old||condition.ifRevision&&condition.ifRevision!==old?.revision)throw Error('revision-conflict');await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);return {revision:revision(bytes)};}};
 let signs=0;const signer=async digest=>{signs++;return secp256k1.sign(digest,secret,{prehash:false,lowS:true,format:'der'});};
 const wallet=await WalletPayments.open(files,hex(key.publicKey()),()=>{},signer),arbiter=new DeviceIdentityKey(unhex('00'.repeat(31)+'03'));
 try{
  const registered=await wallet.handle({action:'register',id:'msfile.bitfs.main',owner:'msfile',kind:'plugin',network:'main',paymentType:'feepool.bitfs'});
  await wallet.handle({action:'configure',channel:{...registered,singleLimit:'100',revision:2}});
  const peers=[key.publicKey(),other.publicKey(),arbiter.publicKey()];
  const fund=serializeTransaction({version:1,inputs:[{txid:new Uint8Array(32),vout:0xffffffff,script:Uint8Array.of(1),sequence:0xffffffff}],outputs:[{satoshis:1000n,script:feePoolScript(peers)}],locktime:0}),txid=await sha256d(fund);
  const state=(paid,sequence,locktime=0)=>serializeTransaction({version:1,inputs:[{txid,vout:0,script:new Uint8Array(),sequence}],outputs:peers.map((pub,index)=>({satoshis:index===0?990n-paid:index===1?paid:0n,script:p2pkhScript(pub)})),locktime});
  const refund=state(0n,0,500),quoteId=await sha256(Uint8Array.of(7)),contentHash=await sha256(Uint8Array.of(1,2,3));
  const command=async(paid,sequence)=>({action:'sign-feepool',family:'bitfs',stage:'state',channelId:registered.id,paymentId:crypto.randomUUID(),sessionId:null,rawTxHex:hex(state(paid,sequence)),prevTransactionHexes:[hex(fund)],authorization:{documentHex:hex(encode([quoteId,await sha256d(refund),sequence,paid,encode([contentHash]),2000],16384)),refundTemplateHex:hex(refund)}});
  const first=await command(100n,1),authorized=await wallet.handle(first);assert.equal(authorized.amount,'100');assert.equal(signs,1);assert.deepEqual(await wallet.handle({action:'pending'}),[]);
  assert.equal(secp256k1.verify(unhex(authorized.signatures[0]),await bitfsWireDigest(5,unhex(first.authorization.documentHex)),key.publicKey(),{prehash:false,lowS:true,format:'der'}),true);
  const completed=await wallet.handle({...first,paymentId:crypto.randomUUID(),authorization:undefined});assert.equal(completed.amount,'0');assert.equal(signs,2);assert.equal(completed.signatures[0].endsWith('41'),true);
  const second=await command(250n,2),waiting=wallet.handle(second);const review=await pending(wallet);assert.equal(review.amount,'150');assert.deepEqual(review.reasons,['single-limit']);assert.equal(signs,2);
  await wallet.handle({action:'answer',id:review.id,allow:true});assert.equal((await waiting).amount,'150');assert.equal(signs,3);
  assert.equal((await wallet.handle({...second,paymentId:crypto.randomUUID(),authorization:undefined})).amount,'0');assert.equal(signs,4);
  const third=await command(400n,3),denied=wallet.handle(third),denial=assert.rejects(denied,/denied/);const prompt=await pending(wallet);
  await wallet.handle({action:'answer',id:prompt.id,allow:false});await denial;assert.equal(signs,4);
  await assert.rejects(wallet.handle({...second,paymentId:crypto.randomUUID(),rawTxHex:hex(state(251n,2))}),/invalid-authorization/);assert.equal(signs,4);
 }finally{wallet.close();arbiter.close();await rm(dir,{recursive:true,force:true});}
});
test('product core: actual transaction, cumulative approval, raise, denial, lock and persisted session replay',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'km-wallet-core-')), file=join(dir,'policy');
  const files={
    async get(){try{const bytes=new Uint8Array(await readFile(file));return {bytes,revision:revision(bytes)};}catch(e){if(e.code==='ENOENT')return;throw e;}},
    async put(_path,bytes,condition){const old=await this.get();if(condition.ifNoneMatch&&old||condition.ifRevision&&condition.ifRevision!==old?.revision)throw Error('revision-conflict');await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);return {revision:revision(bytes)};},
  };
  let signs=0;
  const signer=async digest=>{signs++;return secp256k1.sign(digest,secret,{prehash:false,lowS:true,format:'der'});};
  let wallet=await WalletPayments.open(files,hex(key.publicKey()),()=>{},signer);
  try {
    const channel=await wallet.handle({action:'register',id:'app.pay',owner:'app',kind:'app',network:'main',paymentType:'p2pkh'});
    assert.equal(channel.singleLimit,'0');
    await wallet.handle({action:'configure',channel:{...channel,singleLimit:'400',defaultSessionLimit:'500',revision:2}});
    await wallet.handle({action:'register',id:'own.pay',owner:'plugin',kind:'plugin',network:'main',paymentType:'p2pkh'});
    const sibling=await wallet.handle({action:'register',id:'app.pool',owner:'app',kind:'app',network:'main',paymentType:'feepool.connect'});
    assert.equal(sibling.defaultSessionLimit,'500');
    await wallet.handle({action:'session-open',id:'connection',owner:'app'});
    const prev=serializeTransaction({version:1,inputs:[{txid:new Uint8Array(32),vout:0xffffffff,script:Uint8Array.of(1),sequence:0xffffffff}],outputs:[{satoshis:1000n,script:p2pkhScript(key.publicKey())}],locktime:0});
    const tx=serializeTransaction({version:2,inputs:[{txid:await sha256d(prev),vout:0,script:new Uint8Array(),sequence:0xffffffff}],outputs:[{satoshis:300n,script:p2pkhScript(other.publicKey())},{satoshis:690n,script:p2pkhScript(key.publicKey())}],locktime:0});
    const command=id=>({action:'sign-p2pkh',rawTxHex:hex(tx),prevTransactionHexes:[hex(prev)],channelId:'app.pay',paymentId:id,sessionId:'connection'});
    const self=serializeTransaction({...parseTransaction(tx),outputs:[{satoshis:990n,script:p2pkhScript(key.publicKey())}]});
    const own=await wallet.handle({...command('self'),rawTxHex:hex(self),channelId:'own.pay',sessionId:null});
    assert.equal(own.amount,'0');assert.equal(own.fee,'10');
    signs=0; // 后续只统计 App 会话中的签名。
    const first=await wallet.handle(command('one'));
    assert.equal(first.amount,'300');assert.equal(first.fee,'10');assert.equal(signs,1);
    const digest=await p2pkhSighash(parseTransaction(tx),0,parseTransaction(prev).outputs[0]);
    assert.equal(secp256k1.verify(unhex(first.signatures[0].slice(0,-2)),digest,key.publicKey(),{prehash:false,lowS:true,format:'der'}),true);
    const second=wallet.handle(command('two'));
    const review=await pending(wallet);
    assert.deepEqual(review.reasons,['session-limit']);assert.equal(review.used,'300');assert.equal(signs,1);
    await wallet.handle({action:'answer',id:review.id,allow:true});await second;
    // 重复打开同一连接不能重新得到一份 500 聪额度。
    await wallet.handle({action:'session-open',id:'connection',owner:'app'});
    const third=wallet.handle(command('three')), next=await pending(wallet);
    assert.equal(next.used,'600');assert.equal(next.sessionLimit,'500');
    await wallet.handle({action:'answer',id:next.id,allow:true,raiseSessionLimit:'1200'});await third;
    assert.equal((await wallet.handle({action:'list'}))[0].defaultSessionLimit,'500');
    await wallet.handle(command('four')); // 累计恰好等于提高后的额度，自动。
    const denied=wallet.handle(command('denied'));const rejected=assert.rejects(denied,/denied/);
    const denial=await pending(wallet);assert.equal(denial.used,'1200');
    await wallet.handle({action:'answer',id:denial.id,allow:false});await rejected;assert.equal(signs,4);
    const popupClosed=wallet.handle(command('popup-closed'));const dismissed=assert.rejects(popupClosed,/denied|payment-cancelled/);
    const cancelledReview=await pending(wallet);
    await wallet.handle({action:'session-cancel',id:'connection'});await dismissed;
    await assert.rejects(wallet.handle({action:'answer',id:cancelledReview.id,allow:true}),/stale-approval/);
    // 同一 App 连接恢复仍沿用累计额度，不能因关闭 popup 重获预算。
    await wallet.handle({action:'session-open',id:'connection',owner:'app'});
    const resumed=wallet.handle(command('resumed'));const resumedReview=await pending(wallet);
    assert.equal(resumedReview.used,'1200');await wallet.handle({action:'answer',id:resumedReview.id,allow:false});await assert.rejects(resumed,/denied/);
    const locked=wallet.handle(command('locked'));const cancelled=assert.rejects(locked,/denied|policy-unavailable/);
    await pending(wallet);wallet.close();await cancelled;assert.equal(signs,4);
    wallet=await WalletPayments.open(files,hex(key.publicKey()),()=>{},signer);
    await wallet.handle({action:'session-open',id:'connection',owner:'app'});
    const afterRestart=wallet.handle(command('after-restart'));const afterRestartReview=await pending(wallet);
    assert.equal(afterRestartReview.used,'1200');await wallet.handle({action:'answer',id:afterRestartReview.id,allow:false});await assert.rejects(afterRestart,/denied/);
    await wallet.handle({action:'session-close',id:'connection'});
    await assert.rejects(wallet.handle({action:'session-open',id:'connection',owner:'app'}),/invalid-session/);
    await assert.rejects(wallet.handle(command('one')),/request-reuse|invalid-session/);
  } finally {wallet.close();await rm(dir,{recursive:true,force:true});}
});
