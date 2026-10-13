import {useEffect,useState} from 'react';
import {Button,Modal,TextInput} from '@keymaster/ui';
import {navigateTo,usePluginI18n} from '@keymaster/runtime';
import type {InternalVaultService} from './internalVaultService.js';
/** Window collects only the new software password. Export and optional erase
 * require separate device holds; verified key bytes stay in the Worker. */
export function VaultHardwareMigrationModal({vault,onClose,passwordRequired=true,erasedDevice=false,connectionReady}:{vault:InternalVaultService;onClose():void;passwordRequired?:boolean;erasedDevice?:boolean;connectionReady?:boolean}) {
 const {t}=usePluginI18n();const [password,setPassword]=useState(''),[confirm,setConfirm]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState<string>(),[connected,setConnected]=useState(false);
 useEffect(()=>{
  if(connectionReady!==undefined){setConnected(connectionReady);return;}
  let live=true,reading=false;
  const refresh=async()=>{if(reading)return;reading=true;try{const state=await vault.hardware({action:'state'});if(live)setConnected(state.status==='connected');}catch{if(live)setConnected(false);}finally{reading=false;}};
  void refresh();const timer=setInterval(()=>void refresh(),750);return()=>{live=false;clearInterval(timer);};
 },[vault,connectionReady]);
 const text=(key:string,fallback:string)=>t(`vault.migration.${key}`,{defaultValue:fallback});
 async function submit(){
  if(busy||!connected||(passwordRequired&&(password.length<8||password!==confirm)))return;
  setBusy(true);setError(undefined);const submitted=password;setPassword('');setConfirm('');
  try{await vault.migrateToSoftware(submitted);onClose();navigateTo('/');}
  catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
 }
 return <Modal open title={text('title','迁回软件钱包')} onClose={()=>{if(!busy){setPassword('');setConfirm('');onClose();}}}
  footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{text('cancel','取消')}</Button>
   <Button loading={busy} disabled={busy||!connected||(passwordRequired&&(password.length<8||password!==confirm))} onClick={()=>void submit()}>{text('start','开始迁移')}</Button></>}>
  <p>{passwordRequired?text('instructions','请为软件钱包设置新密码。网页会向已连接的 RocKey 发起迁回请求，迁移保留当前身份、业务数据和渠道额度。'):text('saved','浏览器已保存加密钱包和额度账本，软件钱包迁移已完成。')}</p>
  <p>{erasedDevice?text('erasedInstructions','原设备已无旧私钥。请核对配对码和迁移记录；如仍需清理，请在设备上确认。'):text('confirmations','请在 RocKey 上长按确认迁回。保存成功后，设备会独立询问是否擦除旧私钥；可以否决，保留设备备份。')}</p>
  <p>{text('finish','保存成功后自动进入软件钱包首页，无需再次输入密码。设备擦除决定不影响钱包使用。')}</p>
  {!busy&&passwordRequired?<><TextInput type="password" label={text('password','新密码（至少 8 位）')} value={password} onChange={e=>setPassword(e.currentTarget.value)} autoComplete="new-password"/>
   <TextInput type="password" label={text('repeat','再次输入新密码')} value={confirm} onChange={e=>setConfirm(e.currentTarget.value)} autoComplete="new-password"/></>:busy?<p role="status">{text('pending','正在迁回，请在 RocKey 上长按授权并保持 USB 连接，等待加密钱包保存。')}</p>:null}
  {error?<p role="alert">{error}</p>:null}
 </Modal>;
}
