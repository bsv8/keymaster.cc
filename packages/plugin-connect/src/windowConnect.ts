import { PROTOCOL_VERSION, type ProtocolClosingMessage } from "keymaster-connect/protocol";
import { PAGE_UI_RENDERER_CAPABILITY, traceDev, type PluginContext, type ApplicationConnections, type ApplicationConnectionsSnapshot, type ApplicationAiTools, type ApplicationView, type ConnectService, type LaunchAppViewInput } from "@keymaster/contracts";
import { CONNECT_PRIVATE_COMMAND, CONNECT_PRIVATE_EVENTS, type ConnectWorkerSnapshot, type ConnectWorkerCommand, type WorkerConnectionView } from "./connectWorkerContract.js";
import type { WindowAppDirectory, AppDirectorySnapshot } from "./catalog.js";
/** A Window has browser handles and read-only projections. Decisions and mutations go to the Worker. */
export function createWindowConnect(ctx: PluginContext) {
 function waitForEndpoints(){return new Promise<{rpc:ReturnType<typeof commandClient>;events:ReturnType<typeof eventClient>}>((resolve,reject)=>{
  let settled=false,off=()=>{};
  const finish=(error?:unknown,value?:{rpc:ReturnType<typeof commandClient>;events:ReturnType<typeof eventClient>})=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(probe);off();ctx.scope.signal.removeEventListener("abort",abort);if(error)reject(error);else resolve(value!)};
  const abort=()=>finish(new Error("Connect page scope revoked"));
  const timer=setTimeout(()=>finish(new Error("Connect Worker private endpoints did not become ready")),30_000);
  const check=()=>{try{if(stopped)throw new Error("Connect page closed");ctx.scope.assertActive();finish(undefined,{rpc:commandClient(),events:eventClient()})}catch(error){if((error as {code?:string}).code!=="capability_unavailable")finish(error)}};
  ctx.scope.signal.addEventListener("abort",abort,{once:true});
  // Private endpoint publication may precede the next public consumer notification after session reopen.
  // Probe only the local catalogue, with a bounded lifetime and no transport calls.
  const probe=setInterval(check,100);
  off=ctx.consumer.subscribe(check);check();if(settled)off();
 });}
 let rpc:ReturnType<typeof commandClient>;
 let subscription:ReturnType<ReturnType<typeof eventClient>["subscribe"]>|undefined;
 function commandClient(){return ctx.privateCapability(CONNECT_PRIVATE_COMMAND)}
 function eventClient(){return ctx.privateCapability(CONNECT_PRIVATE_EVENTS)}
 const renderer=ctx.capability(PAGE_UI_RENDERER_CAPABILITY);
 const listeners=new Set<()=>void>(),directoryListeners=new Set<()=>void>();
 const sources=new Map<string,{source:Window;view?:ApplicationView}>();
 const sourceIds=new Map<Window,string>(), services=new Map<string,ConnectService>();
 let state:ConnectWorkerSnapshot = {revision:-1,applications:{applications:[],connections:[],commands:[],events:[],historyAvailable:false},directory:{entries:[],favoriteKeys:[],deletedKeys:[],loading:false,error:null,persistError:null},opening:null,tools:[]};
 let current:ApplicationConnectionsSnapshot={applications:[],connections:[],commands:[],events:[],historyAvailable:false};
 let stopped=false;
 function apply(next:ConnectWorkerSnapshot) {
  if(stopped||state&&next.revision<state.revision)return;
  state=next;
  current={...next.applications,connections:next.applications.connections.map(c=>({...c,service:service(c.id)}))};
  listeners.forEach(listener=>listener());directoryListeners.forEach(listener=>listener());
 }
 const call=async(command:ConnectWorkerCommand,signal:AbortSignal=ctx.scope.signal)=>{await ready;ctx.scope.assertActive();const response=await rpc.call(command,{signal,timeoutMs:120_000});ctx.scope.assertActive();apply(response.snapshot);return response.value;};
 const fire=(command:ConnectWorkerCommand)=>{void call(command).catch(error=>traceDev("connect.relay","command.failed",()=>({type:command.type,error})));};
 function connection(id:string):WorkerConnectionView {const found=state?.applications.connections.find(c=>c.id===id);if(!found)throw new Error("Connection expired");return found;}
 function service(id:string):ConnectService {
  const known=services.get(id);if(known)return known;
  // This facade contains only UI operations. It never reconstructs execution authority.
  const result={
   feedSnapshot:()=>connection(id).feed,connectAuthSnapshot:()=>connection(id).auth,
   confirmDeadlineMs:(recordId?:string)=>recordId?connection(id).deadlines[recordId]??null:null,
   confirmByUser:(recordId?:string,remember=false)=>call({type:"decide",connectionId:id,recordId:recordId??"",decision:"approve",expectedPhase:"confirming",remember}).then(()=>{}),
   rejectByUser:(recordId?:string,expectedPhase:import("@keymaster/contracts").ProtocolCommandPhase="confirming")=>call({type:"decide",connectionId:id,recordId:recordId??"",decision:"reject",expectedPhase}).then(()=>{}),
   confirmConnectLogin:(recordId:string)=>call({type:"decide",connectionId:id,recordId,decision:"login",expectedPhase:"confirming"}).then(()=>{}),
   rejectConnectRequest:(recordId:string)=>call({type:"decide",connectionId:id,recordId,decision:"reject",expectedPhase:"confirming"}).then(()=>{}),
  } as Pick<ConnectService,"feedSnapshot"|"connectAuthSnapshot"|"confirmDeadlineMs"|"confirmByUser"|"rejectByUser"|"confirmConnectLogin"|"rejectConnectRequest">;
  services.set(id,result as ConnectService);return result as ConnectService;
 }
 function receive(event:import("./connectWorkerContract.js").ConnectWorkerEvent){
  if(stopped)return;
  if(event.type==="state"){apply(event.snapshot);return;}
  const source=sources.get(event.sourceId);if(!source)return;
  if(event.type==="post"){if(!source.source.closed)source.source.postMessage(event.message,event.origin);return;}
  if(event.action==="navigate")source.view?.navigate(event.url!);
  else if(event.action==="focus"){if(source.view)source.view.focus();else source.source.focus();}
  else{source.view?.close();sources.delete(event.sourceId);sourceIds.delete(source.source);}
 }
 function unavailable(error:unknown){if(stopped)return;current={...current,historyAvailable:false,error:"Connect Worker 已断开，请刷新钱包。"};listeners.forEach(listener=>listener());traceDev("connect.relay","stream.failed",()=>({error}))}
 // Never hold Window setup while session.open is waiting for Window setup to finish.
 const ready=Promise.resolve().then(async()=>{
  const endpoints=await waitForEndpoints();if(stopped)throw new Error("Connect page closed");rpc=endpoints.rpc;
  subscription=endpoints.events.subscribe({}, {signal:ctx.scope.signal,onNext:receive});
  void subscription.closed.catch(unavailable);
  await subscription.ready;
  const response=await rpc.call({type:"snapshot"},{signal:ctx.scope.signal});apply(response.snapshot);
 });
 void ready.catch(unavailable);
 function register(source:Window,view?:ApplicationView):string {const id=crypto.randomUUID();sources.set(id,{source,view});sourceIds.set(source,id);return id;}
 const host:ApplicationConnections={
  snapshot:()=>current,subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener)}},
  applicationOpenMode(){if(!state.opening)throw new Error("Application settings unavailable");return state.opening},
  setApplicationOpenMode:mode=>call({type:"opening",mode}).then(()=>{}),
  acceptOpener(source){if(!source||source.closed||sourceIds.has(source))return;if(source!==window.opener)throw new Error("Untrusted wallet opener");const id=register(source);fire({type:"register-opener",sourceId:id});},
  permissions:key=>call({type:"permissions",key}) as Promise<import("@keymaster/contracts").ProtocolMethod[]>,
  revokePermission:(key,method)=>call({type:"revoke-permission",key,method}).then(()=>{}),
  disconnect:key=>call({type:"disconnect",key}).then(()=>{}),
  focus:connectionId=>fire({type:"focus",connectionId}),
 };
 const directory:WindowAppDirectory={
  subscribe(listener){directoryListeners.add(listener);return()=>{directoryListeners.delete(listener)}},getSnapshot:()=>state!.directory,
  list:async()=>{await call({type:"list"});return state!.directory},
  toggleFavorite:(key)=>call({type:"favorite",key}).then(()=>{}),select:(key,selection)=>call({type:"select",key,selection}).then(()=>{}),
  deleteApp:key=>call({type:"delete-app",key}).then(()=>{}),
 };
 let launching=false;
 async function launchAppView(input:LaunchAppViewInput) {
  if(launching)throw new Error("Application is opening");launching=true;
  let id:string|undefined,view:ApplicationView|undefined;
  try {
   const existing=state?.applications.connections.find(c=>!c.closedAt && (input.expectedAppPublicKeyHex ? (c.applicationKey || c.expectedAppPublicKeyHex) === input.expectedAppPublicKeyHex.toLowerCase() : c.launchUrl === new URL(input.appUrl).href));
   if(existing){const reused=await call({type:"focus-launch",input});if(reused)return reused as import("@keymaster/contracts").LaunchAppViewResult;}
   // Reserve in the click stack when no live view is known; RPC never opens a browser window.
   const key=input.expectedAppPublicKeyHex?`app:${input.expectedAppPublicKeyHex.toLowerCase()}`:`url:${new URL(input.appUrl).href}`;
   view=renderer.openApplication({id:key,title:new URL(input.appOrigin).host,origin:input.appOrigin,mode:host.applicationOpenMode(),onClose(){if(id){fire({type:"close-source",sourceId:id});const source=sources.get(id);if(source)sourceIds.delete(source.source);sources.delete(id)}}});
   id=register(view.source,view);
   return await call({type:"launch",sourceId:id,input}) as import("@keymaster/contracts").LaunchAppViewResult;
  }catch(error){view?.close();throw error}finally{launching=false;}
 }
 const connect={launchAppView} as Pick<ConnectService,"launchAppView">;
 const aiTools:ApplicationAiTools={list:()=>state?.tools??[],subscribe:host.subscribe,invoke:(id,args,signal)=>{if(signal?.aborted)return Promise.reject(new Error("Cancelled"));return call({type:"ai-invoke",id,args},signal) as Promise<import("@keymaster/contracts").JSONValue>}};
 const onMessage=(event:MessageEvent)=>{
  if(event.source){const id=sourceIds.get(event.source as Window);if(id)fire({type:"message",sourceId:id,origin:event.origin,data:event.data});}
  else if(event.data?.v===1&&event.data.type==="client_unloaded"&&event.data.bindingId){for(const id of sources.keys())fire({type:"message",sourceId:id,origin:event.origin,data:event.data});}
 };
 const timer=setInterval(()=>{for(const [id,s]of sources)if(s.source.closed){fire({type:"close-source",sourceId:id});sources.delete(id);sourceIds.delete(s.source)}},1000);
 const onRestore=(event:PageTransitionEvent)=>{if(event.persisted)window.location.reload()};
 function dispose(){if(stopped)return;
  // The document cannot await Worker RPC during pagehide. Notify only its own
  // browser channels synchronously; this transport frame grants no authority.
  const closing: ProtocolClosingMessage = { v: PROTOCOL_VERSION, type: "closing" };
  for (const { source } of sources.values()) { try { if (!source.closed) source.postMessage(closing, "*"); } catch { /* best effort during unload */ } }
  stopped=true;clearInterval(timer);window.removeEventListener("message",onMessage);window.removeEventListener("pagehide",dispose);window.removeEventListener("pageshow",onRestore);for(const {view}of sources.values())view?.close();sources.clear();sourceIds.clear();subscription?.cancel("wallet-page-closed");listeners.clear();directoryListeners.clear();}
 window.addEventListener("message",onMessage);window.addEventListener("pagehide",dispose);window.addEventListener("pageshow",onRestore);
 return {host,directory,connect,aiTools,dispose};
}
