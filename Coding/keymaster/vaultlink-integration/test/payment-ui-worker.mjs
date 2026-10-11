// 产品核心在独立 Node Worker 执行，UI 只走消息端口，保持实际 Window/Worker 分工。
import {parentPort,workerData} from 'node:worker_threads';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {WalletPayments} from '../dist/index.js';
import {DeviceIdentityKey,serializeTransaction,p2pkhScript,sha256d,hex} from '@vaultlink/sdk';
const file=join(workerData,'policy'), rev=b=>createHash('sha256').update(b).digest('hex');
const secret=new Uint8Array(32);secret[31]=1;
const key=new DeviceIdentityKey(secret), peerSecret=new Uint8Array(32);peerSecret[31]=2;
const peer=new DeviceIdentityKey(peerSecret);
let signs=0;
const wallet=await WalletPayments.open({
  async get(){try{const bytes=new Uint8Array(await readFile(file));return {bytes,revision:rev(bytes)};}catch(e){if(e.code==='ENOENT')return;throw e;}},
  async put(_path,bytes,condition){const old=await this.get();if(condition.ifNoneMatch&&old||condition.ifRevision&&condition.ifRevision!==old?.revision)throw Error('revision-conflict');await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);return {revision:rev(bytes)};},
},hex(key.publicKey()),()=>{},async digest=>{signs++;return secp256k1.sign(digest,secret,{prehash:false,lowS:true,format:'der'});}, "main");
await wallet.handle({action:'register',id:'channel',owner:'app',kind:'app',network:'main',paymentType:'p2pkh'});
await wallet.handle({action:'configure',channel:{id:'channel',owner:'app',kind:'app',network:'main',paymentType:'p2pkh',enabled:true,singleLimit:'400',defaultSessionLimit:'500',revision:2}});
await wallet.handle({action:'session-open',id:'connection',owner:'app'});
const prev=serializeTransaction({version:1,inputs:[{txid:new Uint8Array(32),vout:0xffffffff,script:Uint8Array.of(1),sequence:0xffffffff}],outputs:[{satoshis:1000n,script:p2pkhScript(key.publicKey())}],locktime:0});
const tx=serializeTransaction({version:1,inputs:[{txid:await sha256d(prev),vout:0,script:new Uint8Array(),sequence:0xffffffff}],outputs:[{satoshis:300n,script:p2pkhScript(peer.publicKey())},{satoshis:690n,script:p2pkhScript(key.publicKey())}],locktime:0});
parentPort.on('message',async({id,command})=>{
  try {
    const value=command.action==='test-sign-count'?signs:command.action==='test-pay'?
      await wallet.handle({action:'sign-p2pkh',channelId:'channel',paymentId:command.id,sessionId:'connection',rawTxHex:hex(tx),prevTransactionHexes:[hex(prev)]}):await wallet.handle(command);
    parentPort.postMessage({id,value});
  }catch(e){parentPort.postMessage({id,error:e.message});}
});
