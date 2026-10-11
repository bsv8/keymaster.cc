import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@keymaster/ui';
import {usePluginI18n} from '@keymaster/runtime';
import {HardwareConnectionPanel} from '@keymaster/vaultlink-integration/ui';
import type {CoordinatorVaultOperationResultFor,CoordinatorHardwareCommand} from '@keymaster/contracts';
import {useInternalVault} from './VaultInternalContext.js';
import {VaultSoftwareMigrationModal} from './VaultSoftwareMigrationModal.js';
import {VaultHardwareMigrationModal} from './VaultHardwareMigrationModal.js';
/** Shown only for a validated unfinished journal, alongside the Storage gate.
 * A recovery USB connection never unlocks ordinary wallet capabilities. */
export function VaultMigrationRecovery(){
 const vault=useInternalVault(),{t}=usePluginI18n();
 const [state,setState]=useState<CoordinatorVaultOperationResultFor<{type:'migrationState'}>>(null),[open,setOpen]=useState(false),[erased,setErased]=useState(false);
 const [connected,setConnected]=useState(false);
 const connectionChanged=useCallback((value:{status:string})=>setConnected(value.status==='connected'),[]);
 const preserveConnection=useCallback(()=>vault.walletSnapshot().status==='unlocked',[vault]);
 const opened=useRef(false);opened.current=open;
 const hardware=useCallback((command:CoordinatorHardwareCommand)=>vault.hardware(command),[vault]);
 useEffect(()=>{
  let current=true,reading=false;
  const refresh=async()=>{if(reading||opened.current)return;reading=true;try{const value=await vault.migrationState();if(current)setState(value);}catch{/* Corrupt/unavailable data cannot produce a recovery identity. Keep the existing projection while a migration holds its fence. */}finally{reading=false;}};
  void refresh();const timer=setInterval(()=>void refresh(),1500);return()=>{current=false;clearInterval(timer);};
 },[vault]);
 if(!state)return null;
 return <section aria-label={t('vault.migration.recoveryTitle',{defaultValue:'恢复未完成的迁移'})}>
  <h2>{t('vault.migration.recoveryTitle',{defaultValue:'恢复未完成的迁移'})}</h2>
  <p>{t('vault.migration.recoveryHelp',{defaultValue:'请连接原 RocKey，继续同一身份的迁移。恢复连接期间，其它钱包业务保持锁定。'})}</p>
  <code>{state.publicKeyHex}</code>
  {state.failure?<p role="alert">{t('vault.migration.failure',{defaultValue:'上次迁回失败：'})} {state.failure}</p>:null}
  {state.target!=="hardware"&&!state.passwordRequired?<label><input type="checkbox" checked={erased} onChange={e=>setErased(e.currentTarget.checked)}/>{t("vault.migration.erasedOption",{defaultValue:"原设备已经擦除私钥，仅恢复提交回执"})}</label>:null}
  <HardwareConnectionPanel key={String(erased)} recovery onStateChange={connectionChanged} preserveConnectionOnUnmount={preserveConnection} provisioning={state.target==="hardware"} erasedRecovery={erased&&!state.passwordRequired} execute={hardware} text={(key,fallback)=>t(`vault.hardware.${key}`,{defaultValue:fallback})}/>
  <Button disabled={!connected} onClick={()=>setOpen(true)}>{t('vault.migration.resume',{defaultValue:'继续迁移'})}</Button>
  {open&&state.target==="hardware"?<VaultSoftwareMigrationModal vault={vault} recovery passwordRequired={state.passwordRequired} onClose={()=>setOpen(false)}/>:open?<VaultHardwareMigrationModal vault={vault} connectionReady={connected} passwordRequired={state.passwordRequired} erasedDevice={erased&&!state.passwordRequired} onClose={()=>setOpen(false)}/>:null}
 </section>;
}
