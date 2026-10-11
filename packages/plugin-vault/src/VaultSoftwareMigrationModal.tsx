import {useCallback,useState} from 'react';
import {Button,Modal} from '@keymaster/ui';
import {usePluginI18n} from '@keymaster/runtime';
import {HardwareConnectionPanel} from '@keymaster/vaultlink-integration/ui';
import type {CoordinatorHardwareCommand} from '@keymaster/contracts';
import type {InternalVaultService} from './internalVaultService.js';
/** Window requests migration of the current unlocked session. Private
 * bytes never leave its Worker; PIN setup stays on device buttons. */
export function VaultSoftwareMigrationModal({vault,onClose,recovery=false,passwordRequired=true}:{vault:InternalVaultService;onClose():void;recovery?:boolean;passwordRequired?:boolean}){
 const {t}=usePluginI18n(),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
 const text=(key:string,fallback:string)=>t(`vault.import.${key}`,{defaultValue:fallback});
 const hardware=useCallback((command:CoordinatorHardwareCommand)=>vault.hardware(command),[vault]);
 const [connected,setConnected]=useState(recovery);
 const connectionChanged=useCallback((state:{status:string})=>setConnected(state.status==='connected'),[]);
 async function submit(){if(busy||!connected)return;setBusy(true);setError(undefined);
  try{await vault.migrateToHardware();onClose();}catch(e){const message=e instanceof Error?e.message:String(e);setError(message==='device-already-has-key'?text('deviceHasKey','RocKey 已有私钥，不能迁入；相同私钥也不允许迁入。'):message==='hardware-provision-required'?text('connectionRequired','请先连接 RocKey，核对两端配对码并在 RocKey 上确认。'):message);}finally{setBusy(false);}}
 return <Modal open title={text('title','迁入 RocKey')} onClose={()=>{if(!busy)onClose();}}
  footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{text('cancel','取消')}</Button><Button loading={busy} disabled={busy||!connected} onClick={()=>void submit()}>{text('start','继续迁移')}</Button></>}>
  <p>{text('instructions','空 RocKey 停留在首页即可连接。核对配对码并在设备上确认，随后继续迁移；设备收到原私钥后提示设置并重复确认 PIN，保存成功后才切换为硬件私钥。RocKey 已有私钥时不能迁入，包括相同私钥。提交前中断或刷新会保留原软件钱包。')}</p>
  <p>{text('preserve','迁移保留身份、网络、业务数据和渠道账本。只有核验硬件保存成功证明后，才移除软件私钥封装并将当前私钥改为硬件私钥，无需再次添加硬件钱包。')}</p>
  {!recovery?<HardwareConnectionPanel provisioning execute={hardware} onStateChange={connectionChanged} text={(key,fallback)=>t(`vault.hardware.${key}`,{defaultValue:fallback})}/>:null}
  {!connected&&!busy?<p role="status">{text('connectionRequired','请先连接 RocKey，核对两端配对码并在 RocKey 上确认。')}</p>:null}
  {busy?<p role="status">{text('pending','正在迁移，请保持 USB 连接并按设备提示确认。')}</p>:null}
  {error?<p role="alert">{error}</p>:null}
 </Modal>;
}
