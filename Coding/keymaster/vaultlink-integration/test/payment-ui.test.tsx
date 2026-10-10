// UI 连接真实钱包核心、磁盘账本与交易解析；测试不返回伪造的批准或签名结果。
import {afterEach, expect, test} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker as NodeWorker} from 'node:worker_threads';
import type {WalletPaymentCommand} from '../src/wallet-payments.js';
import {PaymentApprovalDialog} from '../src/ui.js';
afterEach(cleanup);
test('over-limit dialog displays actual amounts/address and never silently resets session or future defaults',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'km-payment-ui-'));
  const worker=new NodeWorker(join(process.cwd(),'Coding/keymaster/vaultlink-integration/test/payment-ui-worker.mjs'),{workerData:dir});
  let sequence=0;
  const waiting=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
  worker.on('message',({id,value,error})=>{const call=waiting.get(id);waiting.delete(id);if(call)error?call.reject(Error(error)):call.resolve(value);});
  worker.on('error',error=>{for(const call of waiting.values())call.reject(error);waiting.clear();});
  const invoke=(command:unknown)=>new Promise<unknown>((resolve,reject)=>{const id=++sequence;waiting.set(id,{resolve,reject});worker.postMessage({id,command});});
  const pay=(id:string)=>invoke({action:'test-pay',id});
  const execute=(command:WalletPaymentCommand)=>invoke(command);
  const count=()=>invoke({action:'test-sign-count'});
  try {
    render(<PaymentApprovalDialog execute={execute} text={(_key,fallback)=>fallback}/>);
    await pay('one');expect(await count()).toBe(1);expect(screen.queryByRole('dialog')).toBeNull();
    const second=pay('two');
    await screen.findByRole('dialog');
    expect(screen.getByText('超过会话累计额度')).toBeTruthy();
    expect(screen.getByText(/300 \/ 600 \/ 500/)).toBeTruthy();
    expect(screen.getByText(/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH/)).toBeTruthy();
    expect(await count()).toBe(1);
    fireEvent.click(screen.getByRole('button',{name:'仅批准本次'}));await second;
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    const third=pay('three');await screen.findByRole('dialog');
    expect(screen.getByText(/600 \/ 900 \/ 500/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('提高当前会话累计额度（聪）'),{target:{value:'1200'}});
    fireEvent.click(screen.getByRole('button',{name:'提高本会话额度并批准'}));await third;
    expect(await count()).toBe(3);
    const channels=await execute({action:'list'}) as {defaultSessionLimit:string}[];
    expect(channels[0]!.defaultSessionLimit).toBe('500');
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    await pay('four');expect(await count()).toBe(4);
    const denied=pay('five');const failure=expect(denied).rejects.toThrow('denied');
    await screen.findByRole('dialog');fireEvent.click(screen.getByRole('button',{name:'拒绝'}));
    await failure;expect(await count()).toBe(4);
  } finally {cleanup();await worker.terminate();await rm(dir,{recursive:true,force:true});}
});
