// UI 连接真实钱包核心、磁盘账本与交易解析；测试不返回伪造的批准或签名结果。
import {afterEach, expect, test} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker as NodeWorker} from 'node:worker_threads';
import type {WalletPaymentCommand} from '../src/wallet-payments.js';
import {PaymentNotificationList} from '../src/ui.js';
afterEach(cleanup);
test('over-limit notification displays actual amounts/address and never silently resets session or future defaults',async()=>{
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
    render(<PaymentNotificationList execute={execute} text={(_key,fallback)=>fallback}/>);
    await pay('one');expect(await count()).toBe(1);expect(screen.queryByRole('heading',{name:/^付款超过免确认额度/})).toBeNull();
    const second=pay('two');
    const summary=await screen.findByRole('button',{name:/^付款超过免确认额度/});
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('超过会话累计额度')).toBeNull();
    fireEvent.click(await screen.findByRole('button',{name:/^付款超过免确认额度/}));
    expect(screen.getByRole('button',{name:/^付款超过免确认额度/}).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('超过会话累计额度')).toBeTruthy();
    expect(screen.getByText(/300 \/ 600 \/ 500/)).toBeTruthy();
    expect(screen.getByText(/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH/)).toBeTruthy();
    expect(await count()).toBe(1);
    fireEvent.click(screen.getByRole('button',{name:'批准'}));await second;
    await waitFor(()=>expect(screen.queryByRole('heading',{name:/^付款超过免确认额度/})).toBeNull());
    const third=pay('three');fireEvent.click(await screen.findByRole('button',{name:/^付款超过免确认额度/}));
    expect(screen.getByText(/600 \/ 900 \/ 500/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('提高当前会话累计额度（聪）'),{target:{value:'1200'}});
    fireEvent.click(screen.getByRole('button',{name:'提高本会话额度并批准'}));await third;
    expect(await count()).toBe(3);
    const channels=await execute({action:'list'}) as {defaultSessionLimit:string}[];
    expect(channels[0]!.defaultSessionLimit).toBe('500');
    await waitFor(()=>expect(screen.queryByRole('heading',{name:/^付款超过免确认额度/})).toBeNull());
    await pay('four');expect(await count()).toBe(4);
    const denied=pay('five');const failure=expect(denied).rejects.toThrow('denied');
    fireEvent.click(await screen.findByRole('button',{name:/^付款超过免确认额度/}));fireEvent.click(screen.getByRole('button',{name:'不批准'}));
    await failure;expect(await count()).toBe(4);
    const firstRegistration=invoke({action:'test-sign',operation:'identity.noise-proof'});
    const secondRegistration=invoke({action:'test-sign',operation:'identity.peer-record'});
    const rejectedRegistration=expect(secondRegistration).rejects.toThrow('denied');
    await waitFor(()=>expect(screen.getAllByRole('heading',{name:/^注册签名渠道/})).toHaveLength(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    const requests=screen.getAllByRole('heading',{name:/^注册签名渠道/}).map(h=>h.closest('article')!);
    const approved=requests.find(r=>r.textContent!.includes('identity.noise-proof'))!;
    const rejected=requests.find(r=>r.textContent!.includes('identity.peer-record'))!;
    fireEvent.click(within(approved).getByRole('button',{name:'批准'}));
    await firstRegistration;
    expect(within(rejected).getByRole('button',{name:'不批准'})).toBeTruthy();
    fireEvent.click(within(rejected).getByRole('button',{name:'不批准'}));
    await rejectedRegistration;
    await waitFor(()=>expect(screen.queryByRole('heading',{name:/^注册签名渠道/})).toBeNull());
    const records=await execute({action:'signature-history'}) as {operation:string;state:string}[];
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({operation:'signing.register',state:'completed'}),
      expect.objectContaining({operation:'signing.register',state:'denied'}),
      expect.objectContaining({operation:'payment.register',state:'completed'}),
    ]));
    await waitFor(()=>expect(screen.getAllByRole('heading',{name:/^渠道注册/})).toHaveLength(3));
    const historyRow=screen.getAllByRole('button',{name:/^渠道注册/}).find(b=>b.textContent!.includes('identity.noise-proof'))!;
    expect(historyRow.getAttribute('aria-expanded')).toBe('false');
    await waitFor(()=>expect(historyRow.textContent).toContain('已批准 · 手动'));
    await waitFor(()=>expect(screen.getAllByRole('button',{name:/^渠道注册/}).find(b=>b.textContent!.includes('identity.peer-record'))!.textContent).toContain('已拒绝 · 手动'));
    expect(screen.getAllByRole('button',{name:/^支付请求/}).some(b=>b.textContent!.includes('已批准 · 自动'))).toBe(true);
    expect(historyRow.closest('article')!.querySelector('time')).toBeNull();
    fireEvent.click(historyRow);
    expect(historyRow.closest('article')!.querySelector('time')).toBeTruthy();
    fireEvent.click(historyRow);
    expect(historyRow.closest('article')!.querySelector('time')).toBeNull();
  } finally {cleanup();await worker.terminate();await rm(dir,{recursive:true,force:true});}
});
