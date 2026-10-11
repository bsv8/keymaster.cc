import {webcrypto} from 'node:crypto';
import {resolve} from 'node:path';
import {MessageChannel} from 'node:worker_threads';
import {ReadableStream,WritableStream} from 'node:stream/web';
import {JSDOM} from 'jsdom';
import {createElement} from 'react';
import {test,expect} from 'vitest';
import {HardwareConnectionPanel} from '../src/hardware-connection-ui.js';
import {HardwareConnectionOwner} from '../src/hardware-connection.js';
import {startActualMigrationDevice} from './native-migration-device.mjs';
// Host adapters only: actual serial bytes, SDK handshake, source-key proof,
// Controller/GPIO confirmation and React teardown execute production code.
test('欢迎页在初始化状态广播前卸载，已转交的真实硬件连接仍能使用',async()=>{
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
 const saved=new Map<string,PropertyDescriptor|undefined>();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,crypto:webcrypto,MessageChannel})){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,value});
 }
 const {render,fireEvent,screen,waitFor,cleanup}=await import('@testing-library/react/pure');
 const device=await startActualMigrationDevice({controller:true,rockeyRoot:process.env.ROCKEY_ROOT??resolve(process.cwd(),'../Rockey')});
 const owner=new HardwareConnectionOwner(()=>{});
 let closed=false;
 const serial={
  readable:new ReadableStream<Uint8Array>({async pull(controller){const bytes=await device.transport.read();if(closed)return;if(bytes)controller.enqueue(bytes);else controller.close();},cancel(){closed=true;}}),
  writable:new WritableStream<Uint8Array>({write(bytes){return device.transport.write(bytes);}}),
  async open(){},async close(){closed=true;await device.transport.close();},
 };
 Object.defineProperty(navigator,'serial',{configurable:true,value:{requestPort:async()=>serial}});
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:unknown,_options:unknown,run:(lock:unknown)=>Promise<void>)=>run({})}});
 let view:ReturnType<typeof render>|undefined;
 try{
  const execute=async(command:any)=>{
   if(command.action==='state')return owner.state();
   if(command.action==='disconnect'){await owner.disconnect('entry',command.leaseId);return owner.state();}
   const result=await owner.enroll({...command,peerId:'entry',walletGeneration:crypto.randomUUID(),assertRecordLive(){}});
   // Actual page teardown precedes delivery of the new session.state to Vault.
   view!.unmount();return result;
  };
  view=render(createElement(HardwareConnectionPanel,{execute,enrollmentLabel:"RocKey",text:(_key,fallback)=>fallback}));
  fireEvent.click(screen.getByText('连接 RocKey'));
  await waitFor(()=>expect(owner.state().status).toBe('pairing'),{timeout:10000});
  expect(device.log()).toContain('host-ui:pair-visible');
  device.approvePair();
  await waitFor(()=>expect(owner.state().status).toBe('connected'),{timeout:10000});
  await waitFor(()=>expect(screen.queryByText('连接 RocKey')).toBeNull());
  expect(closed).toBe(false);
  expect(await owner.backend().migrationStatus()).toBeNull();
  await owner.close();
  await waitFor(()=>expect(closed).toBe(true));
 }finally{
  cleanup();await owner.close();await device.close();
  for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  dom.window.close();
 }
},30000);
