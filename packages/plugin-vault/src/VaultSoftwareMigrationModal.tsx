import {useCallback,useState} from 'react';
import {Button,Modal,TextInput} from '@keymaster/ui';
import {usePluginI18n} from '@keymaster/runtime';
import {HardwareConnectionPanel} from '@keymaster/vaultlink-integration/ui';
import type {CoordinatorHardwareCommand} from '@keymaster/contracts';
import type {InternalVaultService} from './internalVaultService.js';
/** Window sends only the existing software password to the Coordinator. Private
 * bytes never leave its Worker; PIN setup/re-entry stays on device buttons. */
export function VaultSoftwareMigrationModal({vault,onClose,recovery=false,passwordRequired=true}:{vault:InternalVaultService;onClose():void;recovery?:boolean;passwordRequired?:boolean}){
 const {t}=usePluginI18n(),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string>();
 const text=(key:string,fallback:string)=>t(`vault.import.${key}`,{defaultValue:fallback});
 const hardware=useCallback((command:CoordinatorHardwareCommand)=>vault.hardware(command),[vault]);
 async function submit(){if(busy||(passwordRequired&&!password))return;setBusy(true);setError(undefined);const submitted=password;setPassword('');
  try{await vault.migrateToHardware(submitted);onClose();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 return <Modal open title={text('title','迁入 RocKey')} onClose={()=>{if(!busy){setPassword('');onClose();}}}
  footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{text('cancel','取消')}</Button><Button loading={busy} disabled={busy||(passwordRequired&&!password)} onClick={()=>void submit()}>{text('start','继续迁移')}</Button></>}>
  <p>{text('instructions','在空 RocKey 上重复设置 PIN，再选择导入。若设备已有本次导入的私钥，请用原 PIN 解锁。核对配对码，随后在设备上重新输入 PIN 并确认同一身份与账本。')}</p>
  <p>{text('preserve','迁移保留身份、业务数据和额度账本；硬件不保存软件密码封装。完成后钱包锁定，请重新连接并在设备上解锁。')}</p>
  {!recovery?<HardwareConnectionPanel provisioning execute={hardware} text={(key,fallback)=>t(`vault.hardware.${key}`,{defaultValue:fallback})}/>:null}
  {!busy&&passwordRequired?<TextInput type="password" label={text('password','当前软件钱包密码')} value={password} onChange={e=>setPassword(e.currentTarget.value)} autoComplete="current-password"/>:null}
  {busy?<p role="status">{text('pending','正在迁移，请保持 USB 连接并按设备提示确认。')}</p>:null}
  {error?<p role="alert">{error}</p>:null}
 </Modal>;
}
