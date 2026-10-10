import { WebSerialTransport, type SerialPortLike, type Transport } from "@vaultlink/sdk";

const MAX_CHUNK = 4096, MAX_BUFFER = 16384;
interface Port {
  postMessage(value: unknown): void;
  addEventListener(type: "message" | "messageerror", fn: (event: MessageEvent) => void): void;
  removeEventListener(type: "message" | "messageerror", fn: (event: MessageEvent) => void): void;
  start(): void;
  close(): void;
}
/** Window 仅转发串口字节。密码、配对/持有权验证和加密会话留在 Worker。
 * 每个桥有独立随机租约；不把其它页面的迟到消息接到新设备上。
 */
export class WorkerUsbTransport implements Transport {
  private stopped = false;
  private queue: Uint8Array[] = [];
  private buffered = 0;
  private readWait?: {resolve(v: Uint8Array | null): void; reject(e: unknown): void};
  private writes = new Map<number, {resolve(): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout>}>();
  private next = 1;
  constructor(private port: Port, private lease: string) {
    if (!/^[0-9a-f-]{36}$/.test(lease)) throw Error("invalid-usb-lease");
    port.addEventListener("message", this.receive);port.addEventListener("messageerror", this.broken);port.start();
  }
  private broken = () => {void this.close();};
  private receive = (event: MessageEvent) => {
    const m = event.data;
    if (this.stopped || !m || m.lease !== this.lease) return;
    if (m.type === "closed") {void this.close();return;}
    if (m.type === "data") {
      if (!(m.bytes instanceof Uint8Array) || !m.bytes.length || m.bytes.length > MAX_CHUNK || this.buffered + m.bytes.length > MAX_BUFFER) {void this.close();return;}
      const b = m.bytes.slice();
      this.port.postMessage({type:"received",lease:this.lease});
      if (this.readWait) {const r=this.readWait;this.readWait=undefined;r.resolve(b);}
      else {this.queue.push(b);this.buffered+=b.length;}
    } else if (m.type === "written") {
      const p=this.writes.get(m.id);if(!p)return;
      clearTimeout(p.timer);this.writes.delete(m.id);
      if(m.ok===true)p.resolve();else {p.reject(Error("usb-write-failed"));void this.close();}
    }
  };
  async read(): Promise<Uint8Array | null> {
    if(this.stopped)return null;
    if(this.readWait)throw Error("concurrent-read");
    const b=this.queue.shift();if(b){this.buffered-=b.length;return b;}
    return new Promise((resolve,reject)=>{this.readWait={resolve,reject};});
  }
  write(bytes: Uint8Array): Promise<void> {
    if(this.stopped || !bytes.length || bytes.length>MAX_CHUNK || this.writes.size>=8)return Promise.reject(Error("usb-unavailable"));
    const id=this.next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{reject(Error("usb-write-timeout"));void this.close();},4000);
      this.writes.set(id,{resolve,reject,timer});
      try{this.port.postMessage({type:"write",lease:this.lease,id,bytes:bytes.slice()});}
      catch(e){void this.close();reject(e);}
    });
  }
  async close(): Promise<void> {
    if(this.stopped)return;this.stopped=true;
    try{this.port.postMessage({type:"close",lease:this.lease});}catch{}
    this.port.removeEventListener("message",this.receive);this.port.removeEventListener("messageerror",this.broken);
    this.port.close();this.readWait?.resolve(null);this.readWait=undefined;
    for(const p of this.writes.values()){clearTimeout(p.timer);p.reject(Error("disconnected"));}this.writes.clear();
    for(const b of this.queue)b.fill(0);this.queue=[];this.buffered=0;
  }
}

/** navigator.locks 的独占锁由调用页面持有整个连接生命周期，覆盖同 Origin 多 Tab。
 * requestPort 必须由设置页的点击调用；本函数不弹 USB 权限、不输入设备 PIN。
 */
export async function openWindowUsbBridge(serial: SerialPortLike, locks: LockManager, channel = new MessageChannel()) {
  const lease=crypto.randomUUID();
  let release!:()=>void, serialTransport: Transport | undefined, stopped=false;
  const held=new Promise<void>(r=>{release=r;});
  let ready!:()=>void, failed!:(e:unknown)=>void;
  const opening=new Promise<void>((resolve,reject)=>{ready=resolve;failed=reject;});
  const notify=(m:Record<string,unknown>)=>{channel.port1.postMessage({...m,lease});};
  const close=async()=>{
    if(stopped)return;stopped=true;
    if(typeof window !== "undefined") window.removeEventListener("pagehide", onPageHide);
    try{notify({type:"closed"});}catch{}
    channel.port1.close();consumed?.();consumed=undefined;await serialTransport?.close().catch(()=>{});release();
  };
  // 串口租约属于当前 Window 连接，而不是会随业务解锁卸载的登录组件。
  const onPageHide=()=>{void close();};
  if(typeof window !== "undefined") window.addEventListener("pagehide",onPageHide);
  let writing=Promise.resolve();
  let consumed:(()=>void)|undefined;
  channel.port1.onmessage=e=>{
    const m=e.data;if(stopped||m?.lease!==lease)return;
    if(m.type==="received"){consumed?.();consumed=undefined;return;}
    if(m.type==="close"){void close();return;}
    if(m.type!=="write" || !Number.isSafeInteger(m.id) || !(m.bytes instanceof Uint8Array) || !m.bytes.length || m.bytes.length>MAX_CHUNK){void close();return;}
    const bytes=m.bytes.slice();
    writing=writing.then(async()=>{if(stopped)return;try{await serialTransport!.write(bytes);notify({type:"written",id:m.id,ok:true});}catch{try{notify({type:"written",id:m.id,ok:false});}finally{await close();}}});
  };
  channel.port1.onmessageerror=()=>{void close();};channel.port1.start();
  void locks.request("keymaster.vault.usb",{mode:"exclusive",ifAvailable:true},async lock=>{
    if(!lock){failed(Error("usb-in-use"));await close();return;}
    try{
      serialTransport=await WebSerialTransport.open(serial);ready();
      void (async()=>{try{while(!stopped){const b=await serialTransport!.read();if(b===null)break;for(let at=0;at<b.length&&!stopped;at+=MAX_CHUNK){await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{reject(Error("usb-reader-stalled"));},4000);consumed=()=>{clearTimeout(timer);resolve();};notify({type:"data",bytes:b.slice(at,at+MAX_CHUNK)});});}}}finally{await close();}})().catch(()=>close());
      await held;
    }catch(e){failed(e);await close();}
  }).catch(e=>{failed(e);void close();});
  try{await opening;}catch(e){await close();throw e;}
  return {port:channel.port2,lease,close};
}
