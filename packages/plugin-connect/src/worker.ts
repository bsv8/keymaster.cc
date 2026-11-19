import { defineBuiltinWorkerPlugin, STORAGE_FILE_CLIENTS_CAPABILITY, VAULT_WALLET_STATE_CAPABILITY, VAULT_WORKER_CRYPTO_CAPABILITY, P2PKH_WORKER_TRANSFER_CAPABILITY, MSFILE_SERVICE_CAPABILITY, CONNECT_APP_SOURCE_BATCH_CAPABILITY, traceDev, requireUnlockedWalletIdentity, type ConnectChannelRuntime, type P2pkhProtocolAdapter, type PluginContext, type ApplicationView, type LaunchAppViewInput, type VaultWalletState } from "@keymaster/contracts";
import type { HandlerCallContext } from "webloom-framework";
import { CONNECT_PRIVATE_COMMAND, CONNECT_PRIVATE_EVENTS, type ConnectWorkerSnapshot, type ConnectWorkerEvent, type ConnectWorkerCommand } from "./connectWorkerContract.js";
import { ApplicationConnectionHost } from "./applicationConnectionHost.js";
import { createConnectService, type ConnectServiceDeps, type ConnectExecutionLease } from "./connectService.js";
import { configureConnectStorageRepository } from "./coordinator.js";
import { createAppDirectoryService } from "./catalog.js";
interface Source {
 id: string; owner: string; closed: boolean; origin?: string;
 window: Window; view?: ApplicationView;
}
interface Sink { push(event: ConnectWorkerEvent): void; stop(): void }
export interface ConnectWorkerPorts {
 authorize(call: HandlerCallContext): string;
 walletOrigin(): string;
 channel: ConnectChannelRuntime;
 lock(): Promise<import("@keymaster/contracts").CoordinatorCommandResult>;
}
/** One authority per wallet Worker instance; no business state is owned by a Window relay. */
export function createConnectWorkerPlugin(ports: ConnectWorkerPorts) {
 return defineBuiltinWorkerPlugin("protocol", [CONNECT_PRIVATE_COMMAND, CONNECT_PRIVATE_EVENTS, CONNECT_APP_SOURCE_BATCH_CAPABILITY], async ctx => {
  const wallet = ctx.capability(VAULT_WALLET_STATE_CAPABILITY).bind(ctx.consumer, ctx.scope);
  const cryptoProvider = ctx.capability(VAULT_WORKER_CRYPTO_CAPABILITY);
  const files = ctx.capability(STORAGE_FILE_CLIENTS_CAPABILITY).bind(ctx.consumer, ctx.scope, "");
  const { repository, appDirectory } = configureConnectStorageRepository({ durablePolicy: files, sessions: files, commandHistory: files });
  const sources = new Map<string, Source>(), peers = new Map<string, Sink>(), decisions = new Map<string, Promise<void>>();
  const appCrypto = new Map<string, Awaited<ReturnType<typeof cryptoProvider.createActiveKeyCrypto>>>();
  const vault: ConnectServiceDeps["vault"] = {
   status: () => wallet.snapshot().status,
   getCurrentKey: async () => { const key = wallet.snapshot().activeKeyIdentity; return key ? { ...key, format: "worker" } : undefined; },
   createActiveKeyCrypto: () => cryptoProvider.createActiveKeyCrypto(),
   async createAppViewSession({sessionId}) { const handle = await cryptoProvider.createActiveKeyCrypto(); appCrypto.get(sessionId)?.dispose("replaced"); appCrypto.set(sessionId, handle); return handle; },
   disposeAppViewSession(sessionId, reason) { appCrypto.get(sessionId)?.dispose(reason); appCrypto.delete(sessionId); },
   lock: ports.lock,
  };
  const getTransfer = async () => { const provider = ctx.optionalCapability(P2PKH_WORKER_TRANSFER_CAPABILITY); if (!provider) throw new Error("P2PKH Worker unavailable"); return provider.getService(); };
  const adapter: P2pkhProtocolAdapter = {
   // This local Worker provider returns the actual product preview, never a Window-supplied preview DTO.
   prepareTransfer: async input => await (await getTransfer()).prepareTransfer(input) as Awaited<ReturnType<P2pkhProtocolAdapter["prepareTransfer"]>>,
   submitTransfer: async input => (await getTransfer()).submitTransfer(input),
   getPaymentStatus: async input => (await getTransfer()).getPaymentStatus(input),
  };
  let executionTail: Promise<void> = Promise.resolve();
  const acquireExecution = async () => {
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    const previous = executionTail; executionTail = previous.then(() => slot);
    await previous;
    try { ctx.scope.assertActive(); } catch (error) { release(); throw error; }
    return release;
  };
  const runConnectRequest = async (execute: (lease: ConnectExecutionLease) => Promise<void>) => {
    let release = await acquireExecution(), held = true;
    const lease: ConnectExecutionLease = { async waitForUser<T>(wait: () => Promise<T>): Promise<T> {
      release(); held = false;
      let result: T | undefined, failure: unknown, failed = false;
      try { result = await wait(); } catch (error) { failure = error; failed = true; }
      release = await acquireExecution(); held = true;
      if (failed) throw failure;
      return result as T;
    } };
    try { await execute(lease); } finally { if (held) release(); }
  };
  const deps: ConnectServiceDeps = { vault, walletState: wallet, storageRepository: repository, walletOrigin: ports.walletOrigin(), runConnectRequest, runtimeSignal: ctx.scope.signal, hostedApplication: true, getP2pkhService: () => adapter, getMsfileService: () => ctx.optionalCapability(MSFILE_SERVICE_CAPABILITY), connectChannelRuntime: ports.channel };
  const host = new ApplicationConnectionHost(deps, repository);
  await host.initialize();
  const directory = createAppDirectoryService({ repository: appDirectory, assertActive: () => ctx.scope.assertActive(), hasUsage(key) { const s = host.snapshot(); return !s.historyAvailable || !!s.error || s.applications.some(a => a.key === key) || s.events.some(e => e.applicationKey === key) || s.commands.some(c => c.applicationKey === key); }, forgetApp: (key, commit) => host.forgetApplication(key, commit) });
  // 建连结果只用于连接与使用记录，不写入发布资料。新的已验证连接可恢复管理资格。
  deps.applicationConnected = async (key) => { if (directory.getSnapshot().deletedKeys.includes(key)) await directory.restoreApp(key); };
  // 受限批次写入：仅允许声明依赖并获得授权的来源插件（Market）调用。
  ctx.provide(CONNECT_APP_SOURCE_BATCH_CAPABILITY, { applyChanges: (changes) => directory.applyBatch(changes) });
  let revision = 0, disposed = false;
  function snapshot(): ConnectWorkerSnapshot {
   const state = host.snapshot();
   return { revision, applications: { ...state, connections: state.connections.map(c => ({ id: c.id, applicationKey: c.applicationKey, createdAt: c.createdAt, ...(c.closedAt ? {closedAt:c.closedAt}:{}), launchUrl: (c as {launchUrl?:string}).launchUrl, expectedAppPublicKeyHex: (c as {expectedAppPublicKeyHex?:string}).expectedAppPublicKeyHex, feed: c.service.feedSnapshot(), auth: c.service.connectAuthSnapshot(), deadlines: Object.fromEntries(c.service.feedSnapshot().commands.map(command => [command.id, c.service.confirmDeadlineMs(command.id)])) })) }, directory: directory.getSnapshot(), opening: host.applicationOpenModeSnapshot(), tools: host.aiTools.list() };
  }
  function emit() { if (disposed) return; revision++; const event: ConnectWorkerEvent = {type:"state", snapshot:snapshot()}; for (const sink of peers.values()) sink.push(event); }
  const offHost = host.subscribe(emit), offDirectory = directory.subscribe(emit);
  const send = (owner: string, event: ConnectWorkerEvent) => { const sink = peers.get(owner); if (!sink) throw new Error("App relay is disconnected"); sink.push(event); };
  const sourceKey = (owner:string,id:string) => JSON.stringify([owner,id]);
  function ownSource(owner:string,id:string): Source { const source=sources.get(sourceKey(owner,id)); if(!source||source.closed)throw new Error("App source expired"); return source; }
  function registerSource(owner:string,id:string): Source {
   if (!id || id.length > 160) throw new Error("Invalid App source");
   const key=sourceKey(owner,id); if(sources.has(key))throw new Error("App source already registered");
   const source: Source={id,owner,closed:false,window:undefined!};
   source.window={get closed(){return source.closed},postMessage(message:unknown,origin:string){if(source.closed)throw new Error("App source closed");send(owner,{type:"post",sourceId:id,origin,message})},focus(){send(owner,{type:"view",sourceId:id,action:"focus"})}} as unknown as Window;
   sources.set(key,source);return source;
  }
  function closeSource(source:Source) { if(source.closed)return; source.closed=true; host.closeView(source.window); sources.delete(sourceKey(source.owner,source.id)); }
  function closePeer(owner:string) { peers.get(owner)?.stop(); peers.delete(owner); for(const source of [...sources.values()])if(source.owner===owner)closeSource(source); }
  void directory.list().catch(error=>traceDev("connect.worker","directory.failed",()=>({error})));
  let controlTail:Promise<void>=Promise.resolve();
  const serial=<T>(run:()=>Promise<T>|T):Promise<T>=>{const work=controlTail.then(()=>{ctx.scope.assertActive();return run()});controlTail=work.then(()=>{},()=>{});return work;};
  async function launch(owner:string,id:string,input:LaunchAppViewInput) {
   const source=ownSource(owner,id); source.origin=input.appOrigin;
   const view:ApplicationView={id,source:source.window,origin:input.appOrigin,mode:host.applicationOpenMode(),title:new URL(input.appOrigin).host,get closed(){return source.closed},navigate:url=>send(owner,{type:"view",sourceId:id,action:"navigate",url}),focus:()=>send(owner,{type:"view",sourceId:id,action:"focus"}),close:()=>{send(owner,{type:"view",sourceId:id,action:"close"});closeSource(source)}};
   source.view=view;
   const service=createConnectService({...deps,resolveOpener:()=>null,focusExistingApplication:input=>host.focusExistingApplication(input),getApplicationOpenMode:()=>host.applicationOpenMode(),reserveApplicationView:()=>view,acceptApplicationLaunch:(payload,window,v)=>host.acceptLaunch(payload,window,v),closeApplicationView:window=>host.closeView(window)});
   try { const result=await service.launchAppView(input); if(result.reused){view.close()} return result; } finally { service.dispose(); }
  }
  interface DecisionOutcome { value: { accepted?: true; alreadyProcessed?: true }; work?: Promise<void> }
  function claimDecision(command: Extract<ConnectWorkerCommand, { type: "decide" }>): DecisionOutcome {
   const connection = host.snapshot().connections.find(c => c.id === command.connectionId && !c.closedAt);
   if (!connection) throw new Error("Connection expired");
   const record = connection.service.feedSnapshot().commands.find(c => c.id === command.recordId);
   if (!record) throw new Error("Unknown request");
   const cancellable = record.phase === "confirming" || record.phase === "waiting_unlock_manual";
   const valid = command.decision === "reject" ? cancellable : record.phase === "confirming";
   // Only pending approval accepts a decision; approved requests cannot be cancelled.
   const key = `${record.id}:${record.phase}`;
   const existing = decisions.get(key);
   if (existing || !valid || command.expectedPhase !== record.phase) return { value: { alreadyProcessed: true }, work: existing };
   if (command.decision !== "reject" && wallet.snapshot().screenMasked) throw new Error("Unlock the wallet before approving");
   const work = Promise.resolve().then(() => command.decision === "reject"
    ? connection.service.rejectByUser(record.id, command.expectedPhase)
    : command.decision === "login" ? connection.service.confirmConnectLogin(record.id)
    : connection.service.confirmByUser(record.id, command.remember));
   decisions.set(key, work);
   traceDev("connect.worker", "decision.claimed", () => ({ recordId: record.id, connectionId: connection.id, decision: command.decision }));
   const release = () => { if (decisions.get(key) === work) decisions.delete(key); };
   void work.then(release, error => { release(); traceDev("connect.worker", "decision.failed", () => ({ error })); emit(); });
   return { value: { accepted: true }, work };
  }
  async function execute(owner:string,command:ConnectWorkerCommand,signal:AbortSignal=ctx.scope.signal):Promise<unknown> {
   switch(command.type) {
    case "snapshot": return;
    case "register-opener": { const source=registerSource(owner,command.sourceId);host.acceptOpener(source.window);return; }
    case "message": {const source=ownSource(owner,command.sourceId);void host.handleMessage({source:source.window,origin:command.origin,data:command.data} as MessageEvent).catch(error=>traceDev("connect.worker","message.failed",()=>({error})));return;}
    case "close-source": {const source=sources.get(sourceKey(owner,command.sourceId));if(source)closeSource(source);return;}
    case "focus-launch": {
     const existing=host.focusExistingApplication(command.input);if(!existing)return;
     const key=requireUnlockedWalletIdentity(wallet.snapshot());
     return {appViewOpened:true,reused:true,appUrl:existing.appUrl,networkIdentity:{bsvNetwork:key.bsvNetwork,publicKeyHex:key.publicKeyHex},walletPublicKeyHex:key.publicKeyHex};
    }
    case "launch": {registerSource(owner,command.sourceId);try{return await launch(owner,command.sourceId,command.input)}catch(error){const source=sources.get(sourceKey(owner,command.sourceId));if(source)closeSource(source);throw error}}
    case "decide": return claimDecision(command);
    case "permissions": return host.permissions(command.key);
    case "revoke-permission": return host.revokePermission(command.key,command.method);
    case "disconnect": return host.disconnect(command.key);
    case "focus": return host.focus(command.connectionId);
    case "opening": return host.setApplicationOpenMode(command.mode);
    case "list": await directory.list();return;
    case "favorite": return directory.toggleFavorite(command.key);
    case "select": return directory.select(command.key,command.selection);
    case "delete-app": return directory.deleteApp(command.key);
    case "ai-invoke": return host.aiTools.invoke(command.id,command.args as Record<string, import("@keymaster/contracts").JSONValue>,signal);
    default: throw new Error("Unknown Connect command");
   }
  }
  ctx.handlePrivate(CONNECT_PRIVATE_COMMAND,async(command,call)=>{
   const owner=ports.authorize(call); if(!peers.has(owner))throw new Error("Connect subscription is not ready");
   // Ingress and decisions never hold the control queue while waiting for an App response or user.
   const result = await (command.type === "ai-invoke" ? execute(owner, command, call.signal) : serial(() => execute(owner, command)));
   // Keep the selected promise in the response scope even after its claim is released.
   // Waiting outside controlTail leaves cancellation and other tabs' decisions available.
   let value = result;
   if (command.type === "decide") {
    const outcome = result as DecisionOutcome;
    await outcome.work;
    value = outcome.value;
   }
   return {snapshot:snapshot(),...(value===undefined?{}:{value})};
  });
  ctx.handlePrivate(CONNECT_PRIVATE_EVENTS,(_request,call)=>{
   const owner=ports.authorize(call);closePeer(owner);
   const queue:ConnectWorkerEvent[]=[];let wake:(()=>void)|undefined,closed=false,overflow=false;
   const sink:Sink={push(event){if(closed)return;if(event.type==="state"){const i=queue.findIndex(e=>e.type==="state");if(i>=0)queue.splice(i,1)}if(queue.length>=256){overflow=true;closed=true;wake?.();return}queue.push(event);wake?.()},stop(){closed=true;wake?.()}};
   peers.set(owner,sink);sink.push({type:"state",snapshot:snapshot()});
   const stop=()=>sink.stop();call.signal.addEventListener("abort",stop,{once:true});
   return(async function*(){try{while(!closed){if(queue.length){yield queue.shift()!;continue}await new Promise<void>(resolve=>{wake=resolve});wake=undefined}if(overflow)throw new Error("Connect relay overflow")}finally{call.signal.removeEventListener("abort",stop);if(peers.get(owner)===sink)closePeer(owner)}})();
  });
  traceDev("connect.worker","authority.started",()=>({instanceId:ctx.consumer.instanceId}));
  return()=>{disposed=true;offDirectory();offHost();for(const owner of [...peers.keys()])closePeer(owner);host.dispose();for(const handle of appCrypto.values())handle.dispose("worker-released");appCrypto.clear();};
 });
}

export { createConnectChannelRuntime } from "./channelRuntime.js";
