import { useState } from "react";
import { usePluginCapability } from "webloom-framework/react";
import { usePluginI18n } from "@keymaster/runtime";
import { Button, PageHeader } from "@keymaster/ui";
import { PROTOCOL_SERVICE_CAPABILITY } from "@keymaster/contracts";
import { AppLaunchModal } from "./AppLaunchModal.js";
import { APP_DIRECTORY_CAPABILITY, useAppDirectory, launchTarget, type AppLaunchTarget } from "./catalog.js";

/** 目录只提供启动目标；钱包宿主独立验证页面证明，再与预期公钥比较。 */
export function AppsPage(){
 const {t}=usePluginI18n();
 const directory=usePluginCapability(APP_DIRECTORY_CAPABILITY);const protocol=usePluginCapability(PROTOCOL_SERVICE_CAPABILITY);const snapshot=useAppDirectory(directory);
 const [target,setTarget]=useState<AppLaunchTarget|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);const [showAdd,setShowAdd]=useState(false);const [url,setURL]=useState("");const [name,setName]=useState("");const [channel,setChannel]=useState<"url"|"files">("url");const [seed,setSeed]=useState("");
 const report=(cause:unknown)=>setError(cause instanceof Error?cause.message:String(cause));
 const open=async()=>{if(!target)return;setBusy(true);setError(null);try{await protocol.launchAppView({appOrigin:new URL(target.url).origin,appUrl:target.url,expectedAppPublicKeyHex:target.expectedAppPublicKeyHex});setTarget(null)}catch(cause){report(cause)}finally{setBusy(false)}};
 return <div className="apps-page"><PageHeader title="应用" description="选择应用入口，身份由连接时的真实证明确认。" actions={<Button data-testid="apps-add-toggle" onClick={()=>setShowAdd(!showAdd)}>自添加应用</Button>}/>
 <AppLaunchModal open={target!==null} entry={target} busy={busy} error={error} onClose={()=>{if(!busy)setTarget(null)}} onConfirm={open}/>
 {showAdd&&<div className="apps-card"><label>入口类型<select data-testid="apps-local-channel" value={channel} onChange={e=>setChannel(e.target.value as "url"|"files")}><option value="url">URL</option><option value="files">Files seed</option></select></label>{channel==="url"?<label>应用 URL<input data-testid="apps-local-url" value={url} onChange={e=>setURL(e.target.value)}/></label>:<><label>Files seed<input data-testid="apps-local-seed" value={seed} onChange={e=>setSeed(e.target.value)}/></label><p>仅保存待验证入口，需使用 CLI 验证运行。</p></>}<label>名称<input data-testid="apps-local-name" value={name} onChange={e=>setName(e.target.value)}/></label><Button data-testid="apps-local-submit" onClick={()=>void directory.addLocal({...channel==="url"?{url}:{indexseedhashhex:seed},name}).then(()=>{setError(null);setShowAdd(false);setURL("");setSeed("");setName("")}).catch(report)}>添加</Button></div>}
 {snapshot.loading&&<p>正在读取目录…</p>}{snapshot.error&&<div role="alert" data-testid="apps-market-error">市场读取失败，本地项仍可使用：{snapshot.error}<Button data-testid="apps-market-retry" onClick={()=>void directory.list()}>重试</Button></div>}
 {snapshot.persistError&&<div role="alert" data-testid="apps-persist-error">保存失败，本次更改未生效：{snapshot.persistError}</div>}{error&&!target&&<div role="alert">{error}</div>}
 <div className="apps-list" data-testid="apps-list">{snapshot.entries.map(entry=>{const key=entry.appPublicKeyHex;const selected=entry.selected?.url??(!entry.selected?entry.urls[0]?.url:undefined);const target=launchTarget(entry);return <div className="apps-card" key={key} data-testid={`apps-card-${key}`}><h3>{entry.name||key}</h3><p data-testid={`apps-card-origin-${key}`}>{key}</p><p data-testid={`apps-card-source-${key}`}>{[entry.marketListed&&t("apps.directory.source.market",{defaultValue:"Market"}),entry.local&&t("apps.directory.source.local",{defaultValue:"Local"}),entry.favorite&&t("apps.directory.source.favorite",{defaultValue:"Favorite"})].filter(Boolean).join(" · ")}</p>{entry.description&&<p>{entry.description}</p>}
 {entry.urls.length>0&&<label>URL 入口<select value={selected??""} onChange={e=>void directory.select(key,{url:e.target.value}).catch(report)}><option value="" disabled>请选择入口</option>{entry.urls.map(u=><option key={u.url} value={u.url}>{u.url}</option>)}</select></label>}
 {entry.files.length>0&&<p>Files 版本（需使用 CLI）：{entry.files.map(f=><code key={f.indexseedhashhex}>{f.indexseedhashhex} </code>)}</p>}
 <Button disabled={!target||busy} data-entry-url={target?.url} data-testid={`apps-open-${key}`} onClick={()=>{setError(null);setTarget(target)}}>{entry.urls.length?"打开 App":"需使用 CLI"}</Button>
 <Button data-testid={`apps-favorite-${key}`} onClick={()=>void directory.toggleFavorite(key).catch(report)}>{entry.favorite?"取消收藏":"收藏"}</Button>
 {entry.local&&<Button data-testid={`apps-remove-${key}`} onClick={()=>void directory.removeLocal(key).catch(report)}>删除</Button>}</div>})}
 {snapshot.pending.map(p=>{const slug=(p.url??p.pendingId).replace(/[^a-z0-9]+/gi,"-");return <div className="apps-card" key={p.pendingId} data-testid={`apps-pending-${p.pendingId}`}><h3>{p.name??p.url??p.indexseedhashhex}</h3><p>待验证 · {p.url??p.indexseedhashhex}</p>{p.error&&<p role="alert">{p.error}</p>}<Button disabled={!p.url||busy} data-entry-url={p.url} data-testid={`apps-open-${slug}`} onClick={()=>{if(p.url)setTarget({url:p.url,name:p.name,description:p.description,pendingId:p.pendingId,marketListed:false,local:true,favorite:false})}}>{p.url?"打开并验证":"需使用 CLI 验证运行"}</Button><Button onClick={()=>void directory.removePending(p.pendingId).catch(report)}>删除</Button></div>})}</div></div>
}
