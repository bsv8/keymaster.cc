import { useState } from "react";
import { usePluginCapability } from "webloom-framework/react";
import { navigateTo } from "@keymaster/runtime";
import { Button } from "@keymaster/ui";
import { PROTOCOL_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { AppLaunchModal } from "./AppLaunchModal.js";
import { APP_DIRECTORY_CAPABILITY, useAppDirectory, launchTarget, type AppLaunchTarget } from "./catalog.js";
/** 首页使用相同目录与钱包启动宿主，不另建缓存或连接逻辑。 */
export function AppsHomeWidget(){
 const directory=usePluginCapability(APP_DIRECTORY_CAPABILITY);const protocol=usePluginCapability(PROTOCOL_SERVICE_CAPABILITY);const snapshot=useAppDirectory(directory);const [target,setTarget]=useState<AppLaunchTarget|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
 const open=async()=>{if(!target)return;setBusy(true);setError(null);try{await protocol.launchAppView({appOrigin:new URL(target.url).origin,appUrl:target.url,expectedAppPublicKeyHex:target.expectedAppPublicKeyHex});setTarget(null)}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}};
 return <section className="apps-home-widget"><h3>应用</h3><AppLaunchModal open={target!==null} entry={target} busy={busy} error={error} onClose={()=>{if(!busy)setTarget(null)}} onConfirm={open}/>{snapshot.persistError&&<p role="alert">{snapshot.persistError}</p>}{snapshot.error&&<p role="alert">市场暂时不可用，本地项仍保留。</p>}{snapshot.entries.map(entry=>{const target=launchTarget(entry);return <Button key={entry.appPublicKeyHex} disabled={!target||busy} data-entry-url={target?.url} data-testid={`apps-home-open-${entry.appPublicKeyHex}`} onClick={()=>{setError(null);setTarget(target)}}>{entry.name??entry.appPublicKeyHex}{!entry.urls.length?" · 需使用 CLI":""}</Button>})}{snapshot.pending.map(p=><Button key={p.pendingId} disabled={!p.url||busy} data-entry-url={p.url} data-testid={`apps-home-open-${(p.url??p.pendingId).replace(/[^a-z0-9]+/gi,"-")}`} onClick={()=>{if(p.url){setError(null);setTarget({url:p.url,name:p.name,pendingId:p.pendingId,marketListed:false,local:true,favorite:false})}}}>{p.name??p.url??p.indexseedhashhex} · 待验证</Button>)}<Button onClick={()=>navigateTo("/apps")}>查看所有应用</Button></section>
}
