import {useState} from 'react';
import {Button,Modal,TextInput} from '@keymaster/ui';
import {usePluginI18n} from '@keymaster/runtime';
import type {InternalVaultService} from './internalVaultService.js';
/** The page collects the NEW software password only. Device PIN and both
 * physical confirmations remain on RocKey; Window never receives key bytes. */
export function VaultHardwareMigrationModal({vault,onClose,passwordRequired=true,erasedDevice=false}:{vault:InternalVaultService;onClose():void;passwordRequired?:boolean;erasedDevice?:boolean}) {
 const {t}=usePluginI18n();const [password,setPassword]=useState(''),[confirm,setConfirm]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>();
 const text=(key:string,fallback:string)=>t(`vault.migration.${key}`,{defaultValue:fallback});
 async function submit(){
  if(busy||(passwordRequired&&(password.length<8||password!==confirm)))return;
  setBusy(true);setError(undefined);const submitted=password;setPassword('');setConfirm('');
  try{await vault.migrateToSoftware(submitted);onClose();}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 }
 return <Modal open title={text('title','迁回软件钱包')} onClose={()=>{if(!busy){setPassword('');setConfirm('');onClose();}}}
  footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{text('cancel','取消')}</Button>
   <Button loading={busy} disabled={busy||(passwordRequired&&(password.length<8||password!==confirm))} onClick={()=>void submit()}>{text('start','开始迁移')}</Button></>}>
  <p>{passwordRequired?text('instructions','先在 RocKey 的设备菜单开启导出。迁移保留当前身份、业务数据和渠道额度。请为软件钱包设置新密码。'):text('saved','浏览器已保存新密码加密的钱包和额度账本。请继续在原设备上单独确认擦除旧私钥。')}</p>
  <p>{erasedDevice?text('erasedInstructions','原设备已无旧私钥。请核对配对码和迁移记录；如仍需清理，请在设备上确认。'):text('confirmations','请在设备上重新输入 PIN 并确认导出。浏览器保存成功后，还需在设备上再次输入 PIN，单独确认擦除旧私钥。')}</p>
  <p>{text('finish','完成后钱包锁定，请使用新密码解锁。处理中请保持 USB 连接。')}</p>
  {!busy&&passwordRequired?<><TextInput type="password" label={text('password','新密码（至少 8 位）')} value={password} onChange={e=>setPassword(e.currentTarget.value)} autoComplete="new-password"/>
   <TextInput type="password" label={text('repeat','再次输入新密码')} value={confirm} onChange={e=>setConfirm(e.currentTarget.value)} autoComplete="new-password"/></>:busy?<p role="status">{text('pending','正在迁移，请按设备屏幕提示完成导出和擦除确认。')}</p>:null}
  {error?<p role="alert">{error}</p>:null}
 </Modal>;
}
