// 公开测试 Key + 真实交易、签名、钱包额度执行器及原子磁盘文件。
// 原有转账用例只观察广播适配；此处没有伪造签名或前序 txid。
import {mkdtemp, readFile, writeFile, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {WalletPayments} from '../dist/index.js';
import {secp256k1} from '@noble/curves/secp256k1.js';
import {DeviceIdentityKey, serializeTransaction, p2pkhScript, hex, unhex, sha256d} from '@vaultlink/sdk';
const previous = new Map();
const directories = [];
const activeRequests = new Set();
export async function cleanupPayments() {
  // 自动入队不再由页面 confirmByUser 等待；先等真实磁盘/签名任务收尾再清理宿主目录。
  while (activeRequests.size) await Promise.allSettled([...activeRequests]);
  await Promise.all(directories.splice(0).map(d=>rm(d,{recursive:true,force:true})));
}
export function fundingCoin(publicKeyHex, value, seed='09'.repeat(32), vout=0) {
  const outputs=Array.from({length:vout+1},()=>({satoshis:0n,script:p2pkhScript(unhex(publicKeyHex))}));
  outputs[vout].satoshis=BigInt(value);
  const raw=serializeTransaction({version:1,inputs:[{txid:unhex(seed),vout:0,script:Uint8Array.of(1),sequence:0xffffffff}],outputs,locktime:0});
  // SDK sha256d 是异步；这里只用 Node 的同一真实 SHA256 算 txid，供同步旧 fixture 构造。
  const digest=createHash('sha256').update(createHash('sha256').update(raw).digest()).digest();
  const txid=Buffer.from(digest).reverse().toString('hex');previous.set(txid,hex(raw));
  return {txid,vout,value};
}
export function rememberTransaction(rawHex) {
  const raw=Buffer.from(rawHex,'hex');
  const digest=createHash('sha256').update(createHash('sha256').update(raw).digest()).digest();
  const txid=Buffer.from(digest).reverse().toString('hex');previous.set(txid,rawHex);return txid;
}
export async function previousTransactions(_network, inputs) { return inputs.map(i=>{const raw=previous.get(i.txid);if(!raw)throw Error('missing real transaction fixture');return raw;}); }
export function paymentRequester(privateKeyHex) {
  let opening;
  const execute = async command=>{
    if(!opening)opening=(async()=>{
      const dir=await mkdtemp(join(tmpdir(),'km-transfer-policy-'));directories.push(dir);
      const key=new DeviceIdentityKey(unhex(privateKeyHex));
      const file=join(dir,'payments');
      const files={
        async get(){try{const bytes=new Uint8Array(await readFile(file));return {bytes,revision:createHash('sha256').update(bytes).digest('hex')};}catch(e){if(e.code==='ENOENT')return;throw e;}},
        async put(_path,bytes,condition){const old=await this.get();if(condition.ifNoneMatch&&old||condition.ifRevision&&condition.ifRevision!==old?.revision)throw Error('revision-conflict');await writeFile(file+'.tmp',bytes);await rename(file+'.tmp',file);return {revision:createHash('sha256').update(bytes).digest('hex')};},
      };
      return WalletPayments.open(files,hex(key.publicKey()),()=>{},async digest=>secp256k1.sign(digest,unhex(privateKeyHex),{prehash:false,lowS:true,format:'der'}));
    })();
    const wallet=await opening;
    if (command.action === "session-open") {
      // 转账回归的用户预置渠道。产品请求不能靠这种宿主 fixture 代填编号。
      for (const network of ["main", "test"]) for (const paymentType of ["p2pkh", "feepool.connect"]) {
        const id = "pay." + createHash("sha256").update(JSON.stringify(["keymaster.app-payment-channel.v1", command.owner, "default", paymentType, network])).digest("hex");
        const channel = await wallet.handle({action: "register", id, owner: command.owner, kind: "app", network, paymentType});
        if (channel.revision === 1) await wallet.handle({action: "configure", channel: {...channel, singleLimit: "100000000", defaultSessionLimit: "100000000", revision: 2}});
      }
    }
    const result=await wallet.handle(command);
    if(command.action==='register'&&result.revision===1){
      // 本组旧用例只检查转账/广播；显式预设用户渠道额度，超额行为另有真实执行器测试。
      await wallet.handle({action:'configure',channel:{...result,singleLimit:'100000000',defaultSessionLimit:result.kind==='app'?'100000000':'0',revision:2}});
    }
    return result;
  };
  return command => {
    const pending = execute(command);
    activeRequests.add(pending);
    pending.then(() => activeRequests.delete(pending), () => activeRequests.delete(pending));
    return pending;
  };
}
