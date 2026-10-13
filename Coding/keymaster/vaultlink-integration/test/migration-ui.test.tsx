import {webcrypto} from 'node:crypto';
import {MessageChannel as NodeMessageChannel} from 'node:worker_threads';
import {resolve} from 'node:path';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {PluginHostProvider} from '../../../../packages/runtime/src/assembly.js';
import {walletStateFixtureAccess} from '../../../../packages/runtime/src/testSupport/walletStateFixture.js';
import {VAULT_SERVICE_CAPABILITY,VAULT_WALLET_STATE_CAPABILITY} from '@keymaster/contracts';
import {bindTestVaultUi,createVaultTestHost} from '../../../../packages/plugin-vault/src/vaultUi.testSupport.js';
import {VaultSoftwareMigrationModal} from '../../../../packages/plugin-vault/src/VaultSoftwareMigrationModal.js';
import {VaultHardwareMigrationModal} from '../../../../packages/plugin-vault/src/VaultHardwareMigrationModal.js';
import {startActualMigrationDevice} from './native-migration-device.mjs';
import {migrationCoordinatorHarness} from './migration-coordinator-harness.js';

// Use Node's byte realm for host WebCrypto/IndexedDB/MessagePort adapters.
// This runs before product imports, so module constants share that realm too.
vi.hoisted(async()=>{
  const {Buffer}=await import('node:buffer');
  const bytes=Object.getPrototypeOf(Buffer.prototype).constructor;
  vi.stubGlobal('Uint8Array',bytes);
  vi.stubGlobal('ArrayBuffer',new bytes(0).buffer.constructor);
});

beforeEach(async()=>{
 const {Buffer}=await import('node:buffer');const bytes=Object.getPrototypeOf(Buffer.prototype).constructor;
 vi.stubGlobal('Uint8Array',bytes);vi.stubGlobal('ArrayBuffer',new bytes(0).buffer.constructor);
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
test('迁入界面：真实 USB 字节桥/Coordinator/C++，配对中禁用继续，设备确认后使用解锁会话迁移完成',async()=>{
  // jsdom has no WebCrypto or Serial device. These are explicit host API
  // adapters: real WebCrypto, MessagePorts and native device byte streams;
  // no replacement pairing, signing or migration success responses.
  vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('MessageChannel',NodeMessageChannel);
  const device=await startActualMigrationDevice({importing:true,manualPair:true,rockeyRoot:resolve(process.cwd(),'../Rockey')});
  const harness=await migrationCoordinatorHarness(device.pub);
  const serial={readable:new ReadableStream<Uint8Array>({async pull(controller){
    const bytes=await device.transport.read();if(bytes===null)controller.close();else controller.enqueue(bytes);
  }}),writable:new WritableStream<Uint8Array>({write:bytes=>device.transport.write(bytes)}),
    async open(){},close:()=>device.transport.close()};
  const serialBefore=Object.getOwnPropertyDescriptor(navigator,'serial');
  const locksBefore=Object.getOwnPropertyDescriptor(navigator,'locks');
  const held=new Set<string>();
  Object.defineProperty(navigator,'locks',{configurable:true,value:{async request(name:string,options:unknown,callback?:(lock:unknown)=>Promise<void>){
    const run=typeof options==='function'?options as (lock:unknown)=>Promise<void>:callback!;
    if(held.has(name))return run(null);held.add(name);
    try{return await run({name,mode:'exclusive'});}finally{held.delete(name);}
  }}});
  Object.defineProperty(navigator,'serial',{configurable:true,value:{requestPort:async()=>serial}});
  const host=createVaultTestHost();
  host.provide(VAULT_SERVICE_CAPABILITY,harness.vault);
  host.provide(VAULT_WALLET_STATE_CAPABILITY,walletStateFixtureAccess({
    snapshot:()=>harness.vault.walletSnapshot(),subscribe:handler=>harness.vault.subscribeWalletState(handler),
  }));
  let closed=false;
  try {
    const Entry=await bindTestVaultUi(host,VaultSoftwareMigrationModal);
    render(<PluginHostProvider host={host}><Entry vault={harness.vault} onClose={()=>{closed=true;}}/></PluginHostProvider>);
    expect(screen.queryByLabelText('当前软件钱包密码')).toBeNull();
    const submit=screen.getByRole('button',{name:'继续迁移'}) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'连接 RocKey'}));
    await screen.findByText('核对两端配对码，在 RocKey 上长按确认：',{exact:false},{timeout:5000});
    expect(screen.queryByRole('button',{name:'配对码相同'})).toBeNull();
    expect(screen.getAllByRole('button',{name:'断开连接'})).toHaveLength(1);
    const code=document.querySelector('strong')?.textContent;
    await expect.poll(()=>device.log()).toContain(`host-pair:${code}`);
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);expect(screen.queryByRole('alert')).toBeNull();
    expect(submit.disabled).toBe(true);
    device.approvePair();
    await waitFor(()=>expect(submit.disabled).toBe(false),{timeout:5000});
    fireEvent.click(submit);
    await waitFor(()=>expect(closed).toBe(true),{timeout:10000});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await harness.coldStart()).toMatchObject({state:'ready',key:{backend:'hardware',publicKeyHex:device.pub}});
  } finally {
    cleanup();if(serialBefore)Object.defineProperty(navigator,'serial',serialBefore);else delete (navigator as {serial?:unknown}).serial;
    if(locksBefore)Object.defineProperty(navigator,'locks',locksBefore);else delete (navigator as {locks?:unknown}).locks;
    await harness.close();await device.close();
  }
},30_000);

test('迁回页面：密码只输入一次，设备擦除未响应时已解锁并跳到首页',async()=>{
 vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('MessageChannel',NodeMessageChannel);
 const device=await startActualMigrationDevice({eraseDecision:'pending',rockeyRoot:resolve(process.cwd(),'../Rockey')});
 const harness=await migrationCoordinatorHarness(device.pub,'hardware');
 const channel=new NodeMessageChannel(),leaseId=crypto.randomUUID();
 channel.port1.onmessage=async event=>{
  const m=event.data;if(m.lease!==leaseId)return;
  if(m.type==='write'){await device.transport.write(m.bytes);channel.port1.postMessage({type:'written',lease:leaseId,id:m.id,ok:true});}
  else if(m.type==='close'){await device.transport.close();channel.port1.close();}
 };
 const pump=(async()=>{for(;;){const bytes=await device.transport.read();if(bytes===null)break;try{channel.port1.postMessage({type:'data',lease:leaseId,bytes});}catch{break;}}})();
 const host=createVaultTestHost();
 host.provide(VAULT_SERVICE_CAPABILITY,harness.vault);
 host.provide(VAULT_WALLET_STATE_CAPABILITY,walletStateFixtureAccess({snapshot:()=>harness.vault.walletSnapshot(),subscribe:handler=>harness.vault.subscribeWalletState(handler)}));
 let closed=false;
 try{
  await harness.vault.hardware({action:'attach',port:channel.port2 as unknown as MessagePort,leaseId});
  window.history.replaceState({},'','/vault/key');
  const Entry=await bindTestVaultUi(host,VaultHardwareMigrationModal);
  render(<PluginHostProvider host={host}><Entry vault={harness.vault} onClose={()=>{closed=true;}}/></PluginHostProvider>);
  fireEvent.change(screen.getByLabelText('新密码（至少 8 位）'),{target:{value:'new-software-password'}});
  fireEvent.change(screen.getByLabelText('再次输入新密码'),{target:{value:'new-software-password'}});
  const submit=screen.getByRole('button',{name:/开始迁移|继续迁移/}) as HTMLButtonElement;
  await waitFor(()=>expect(submit.disabled).toBe(false));fireEvent.click(submit);
  await waitFor(()=>{expect(closed).toBe(true);expect(window.location.pathname).toBe('/');},{timeout:10000});
  expect(harness.status()).toBe('unlocked');
  expect(harness.vault.walletSnapshot().activeKeyIdentity?.backend).toBe('software');
  await expect.poll(()=>device.log()).toContain('host-review:migration.erase:pin=0');
  expect(await harness.vault.migrationState()).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
 }finally{
  cleanup();window.history.replaceState({},'','/');await harness.close();channel.port1.close();channel.port2.close();await device.close();await pump;
 }
},30_000);
