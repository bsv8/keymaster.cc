import {ProvisionMigrationConnection} from "./provision-migration-connection.js";
import {ErasedMigrationConnection} from "./erased-migration-connection.js";
import type {MigrationJournal} from "./migration-journal.js";
import { VaultLinkHardwareBackend, type HardwareOperationActivity } from "./hardware-backend.js";
import { WorkerUsbTransport } from "./usb-bridge.js";
import { validateHardwareKeyDocument, type HardwareKeyDocumentV1 } from "./hardware-key-record.js";

export interface HardwareConnectionState {
  status: "disconnected" | "connecting" | "pairing" | "connected";
  leaseId?: string;
  pairingCode?: string;
  activity?: HardwareOperationActivity;
}

/** Coordinator 的唯一连接所有者。连接不代表钱包业务已解锁。
 * 端口只送字节，配对和当前 Key 的挑战验签由 Worker 内的 SDK 执行。
 */
export class HardwareConnectionOwner {
  private current?: {
    peerId: string; leaseId: string; transport: WorkerUsbTransport;
    erased?:ErasedMigrationConnection;
    provision?:ProvisionMigrationConnection;
    backend?: VaultLinkHardwareBackend; document?: HardwareKeyDocumentV1; state: HardwareConnectionState;
    assertActive(): void;
  };
  private readonly hostRunGeneration = crypto.getRandomValues(new Uint32Array(1))[0]! || 1;
  constructor(private readonly assertAuthority: () => void, private readonly disconnected: () => void = () => {}) {}

  /** 仅钱包 Coordinator 装配付款/秘密能力；页面 RPC 永远只得到 state DTO。 */
  backend(): VaultLinkHardwareBackend {
    const slot = this.current;
    if (!slot?.backend || slot.state.status !== "connected") throw Error("hardware-disconnected");
    slot.assertActive(); return slot.backend;
  }

  provision():ProvisionMigrationConnection{const slot=this.current;if(!slot?.provision||slot.state.status!=="connected")throw Error("hardware-disconnected");slot.assertActive();return slot.provision;}
  isProvisioning():boolean{return this.current?.provision!==undefined;}
  attachProvision(input:{peerId:string;leaseId:string;port:MessagePort;walletGeneration:string;signal?:AbortSignal;assertRecordLive():void}):Promise<HardwareConnectionState>{return this.open({...input,provision:true});}
  erased():ErasedMigrationConnection{const slot=this.current;if(!slot?.erased||slot.state.status!=="connected")throw Error("hardware-disconnected");slot.assertActive();return slot.erased;}
  isErasedRecovery():boolean{return this.current?.erased!==undefined;}
  attachErased(input:{peerId:string;leaseId:string;port:MessagePort;journal:MigrationJournal;signal?:AbortSignal;assertRecordLive():void}):Promise<HardwareConnectionState>{return this.open({...input,erasedJournal:input.journal});}
  state(): HardwareConnectionState { return { ...(this.current?.state ?? { status: "disconnected" }) }; }

  verifiedDocument(): HardwareKeyDocumentV1 {
    this.backend(); return {...this.current!.document!};
  }
  enroll(input: {peerId: string; leaseId: string; port: MessagePort; label: string; walletGeneration: string;
    signal?: AbortSignal; assertRecordLive(): void}): Promise<HardwareConnectionState> {
    return this.open(input);
  }
  attach(input: {
    peerId: string; leaseId: string; port: MessagePort; document: HardwareKeyDocumentV1;
    signal?: AbortSignal;
    assertRecordLive(): void;
  }): Promise<HardwareConnectionState> { return this.open(input); }
  private async open(input: {peerId: string; leaseId: string; port: MessagePort; signal?: AbortSignal;
    assertRecordLive(): void} & ({document: HardwareKeyDocumentV1} | {label: string; walletGeneration: string} | {erasedJournal:MigrationJournal} | {provision:true;walletGeneration:string})): Promise<HardwareConnectionState> {
    let transferred = false;
    try {
      this.assertAuthority(); input.assertRecordLive();
      if (this.current) throw new Error("usb-in-use");
      const record = "document" in input ? validateHardwareKeyDocument(input.document) : undefined;
      const transport = new WorkerUsbTransport(input.port, input.leaseId);
      transferred = true;
      const slot = {
        peerId: input.peerId, leaseId: input.leaseId, transport,
        state: { status: "connecting", leaseId: input.leaseId } as HardwareConnectionState,
        assertActive: () => {
          this.assertAuthority(); input.assertRecordLive();
          if (this.current !== slot) throw new Error("usb-lease-revoked");
        },
      } as NonNullable<HardwareConnectionOwner["current"]>;
      this.current = slot;
      const abort = () => { if (this.current === slot) void this.close(); };
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (input.signal?.aborted) throw new Error("usb-lease-revoked");
        // 本地 UUID 身份世代仍完整检查。wire 的 uint32 是其摘要，不能替代本地绑定。
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(record?.walletGeneration ?? ("erasedJournal" in input ? input.erasedJournal.walletGeneration : "walletGeneration" in input ? input.walletGeneration : ""))));
        slot.assertActive();
        const walletGeneration = new DataView(digest.buffer).getUint32(0) || 1;
        const context = {generations: {walletGeneration, backendGeneration: record?.backendGeneration ?? 1, hostRunGeneration: this.hostRunGeneration}, assertActive: slot.assertActive};
        const confirmPairing = async (code: string): Promise<boolean> => {
          slot.assertActive(); slot.state = { status: "pairing", leaseId: slot.leaseId, pairingCode: code };
          // 浏览器只展示核对码。这里继续握手并不完成配对：SDK 仍须等待
          // RocKey 的人工 PAIR_OK 和持有权证明；关闭租约会中断等待。
          return true;
        };
        let backend: VaultLinkHardwareBackend|undefined;
        if("provision" in input)slot.provision=await ProvisionMigrationConnection.connect(transport,context,confirmPairing);
        else if("erasedJournal" in input)slot.erased=await ErasedMigrationConnection.connect(transport,{...context,journal:input.erasedJournal},confirmPairing);
        else if (record) { backend = await VaultLinkHardwareBackend.connect(transport, {...context, publicKeyHex: record.publicKeyHex}, confirmPairing); slot.document = record; }
        else {
          const verified = await VaultLinkHardwareBackend.enroll(transport, context, confirmPairing);
          backend = verified.backend;
          if (!("label" in input)) { await backend.close(); throw Error("invalid-enrollment"); }
          try { slot.document = validateHardwareKeyDocument({format: "keymaster.hardware-key", version: 1, backend: "vaultlink", wireVersion: 2,
            label: input.label, walletGeneration: input.walletGeneration, backendGeneration: 1, publicKeyHex: verified.publicKeyHex}); }
          catch (error) { await backend.close(); throw error; }
        }
        slot.assertActive(); slot.backend = backend;
        slot.state = { status: "connected", leaseId: slot.leaseId };
        void (backend??slot.erased??slot.provision!).disconnected.then(() => { if (this.current === slot) void this.close(); });
        return this.state();
      } catch (error) {
        if (this.current === slot) await this.close(); else await transport.close();
        throw error;
      } finally { input.signal?.removeEventListener("abort", abort); }
    } catch (error) {
      if (!transferred) input.port.close();
      throw error;
    }
  }

  closePeer(peerId: string): Promise<void> { return this.current?.peerId === peerId ? this.close() : Promise.resolve(); }
  disconnect(peerId: string, leaseId: string): Promise<void> {
    if (this.current?.peerId !== peerId || this.current.leaseId !== leaseId) throw new Error("stale-usb-lease");
    return this.close();
  }
  async close(): Promise<void> {
    const slot = this.current;
    if (!slot) return;
    // 先撤销，后停止 I/O；迟到验签结果不能重新装配代理。
    this.current = undefined; this.disconnected();
    await slot.backend?.close().catch(() => {});
    await slot.erased?.close().catch(()=>{});
    await slot.provision?.close().catch(()=>{});
    await slot.transport.close();
  }
}
