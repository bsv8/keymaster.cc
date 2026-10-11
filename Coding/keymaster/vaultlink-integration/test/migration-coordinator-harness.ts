import { COORDINATOR_RPC_CAPABILITY, WALLET_META_FORMAT, WALLET_CURRENT_SCHEMA_VERSION,
  type CoordinatorResponse, type CoordinatorVaultOperation, type SessionStateEvent } from '@keymaster/contracts';
import {createAndVerifyMigrationKeyHold} from '../../../../packages/plugin-vault/src/migrationKeyHold.js';
import {VaultServiceCoordinator, type CoordinatorClientLike} from '../../../../packages/plugin-vault/src/vaultServiceCoordinator.js';
import {SessionStateMirror} from '../../../../packages/plugin-vault/src/sessionStateMirror.js';
import {__testResetWalletStore, __testBootstrapWalletStorage, __testSeedWalletLocalRecords,
  __testResetState, __testGetSnapshot, __testAttachPort, __testDispatchStorageMessage,
  __testUnlock, __testColdStart, __testGetVaultStatus} from '../../../../apps/web/src/keymasterSessionCoordinator.worker.js';

/** Explicit peer/IndexedDB host adapter; dispatch, password decryption,
 * lifecycle, migration fence and KeyHold commit are the production Coordinator. */
export async function migrationCoordinatorHarness(publicKeyHex:string) {
  await __testResetWalletStore(); await __testBootstrapWalletStorage();
  const secret=new Uint8Array(32); secret[31]=1;
  const password='software-password';
  const source=await createAndVerifyMigrationKeyHold({bsvNetwork: "main" as const, privateKey:secret,publicKeyHex,label:'same key'},password);
  secret.fill(0);
  const walletGeneration=crypto.randomUUID();
  await __testSeedWalletLocalRecords({keyHold:new TextDecoder().decode(source),meta:JSON.stringify({
    format:WALLET_META_FORMAT,version:1,schemaVersion:WALLET_CURRENT_SCHEMA_VERSION,initialized:true,
    walletGeneration,createdAt:new Date().toISOString(),
  })});
  __testResetState(); await __testBootstrapWalletStorage();
  const unlocked=await __testUnlock(password);
  if(__testGetVaultStatus()!=='unlocked') throw Error(JSON.stringify(unlocked));
  const peer='migration-page',responses=new Map<string,CoordinatorResponse>(),listeners=new Set<(event:SessionStateEvent)=>void>();
  const reconnect=()=>__testAttachPort(peer,value=>{
    if(value&&typeof value==='object'&&'requestId' in value)responses.set((value as CoordinatorResponse).requestId,value as CoordinatorResponse);
    if(value&&typeof value==='object'&&'type' in value&&value.type==='session.state.changed')
      for(const listener of listeners)listener(value as SessionStateEvent);
  });
  reconnect();
  const invoke=async(operation:CoordinatorVaultOperation)=>{
    const requestId=crypto.randomUUID();
    const parsed=COORDINATOR_RPC_CAPABILITY.request.parse({kind:'vault.operation',expectedSessionEpoch:__testGetSnapshot().sessionEpoch,operation});
    const request=structuredClone(parsed,{transfer:[...COORDINATOR_RPC_CAPABILITY.transfer!.request!(parsed)]});
    await __testDispatchStorageMessage(peer,{...request,clientId:peer,requestId} as Parameters<typeof __testDispatchStorageMessage>[1]);
    const response=responses.get(requestId); responses.delete(requestId);
    if(!response)throw Error('Missing Coordinator response');return response;
  };
  const subscribeId=crypto.randomUUID();
  await __testDispatchStorageMessage(peer,{kind:'subscribe',clientId:peer,requestId:subscribeId,topics:['session.state']});
  responses.delete(subscribeId);
  const mirror=new SessionStateMirror({getBootstrapSnapshot:__testGetSnapshot,subscribeTopic:(_topic,listener)=>{
    listeners.add(listener);return()=>{listeners.delete(listener);};
  }});
  const client={getIsConnected:()=>true,vaultOperation:async(operation:CoordinatorVaultOperation)=>{
    const response=await invoke(operation);
    return response.ack.status==='ok'?{...response.ack,value:response.operationResult,sessionEpoch:response.sessionEpoch}:response.ack;
  }} as unknown as CoordinatorClientLike;
  const vault=new VaultServiceCoordinator({coordinatorClient:client,sessionStateMirror:mirror});
  return {vault,invoke,password,walletGeneration,reconnect,coldStart:__testColdStart,status:__testGetVaultStatus,
    async close(){vault.dispose();mirror.dispose();await __testResetWalletStore();}};
}
