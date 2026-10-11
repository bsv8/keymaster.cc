import {nativeSdkSources} from './native-sdk-sources.mjs';
import { DeviceIdentityKey, serializeTransaction, p2pkhScript, sha256d, hex } from "@vaultlink/sdk";
import { expect, test } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { COORDINATOR_RPC_CAPABILITY, CENTRAL_STORAGE_DECLARATIONS, WALLET_CURRENT_SCHEMA_VERSION, WALLET_META_FORMAT, type CoordinatorResponse, type CoordinatorHardwareCommand } from "@keymaster/contracts";
import {createIndexedDbWalletStore, createPlatformRootStore} from "../../../../packages/platform-storage/src/coordinator/index.js";
import {openProtocolStorageRepository} from "../../../../packages/plugin-protocol/src/storage/protocolStorageRepository.js";
import {ProtocolServiceImpl} from "../../../../packages/plugin-protocol/src/protocolService.js";
import {verifyCompactSecp256k1} from "../../../../packages/plugin-protocol/src/protocolCrypto.js";
import {VaultServiceCoordinator, type CoordinatorClientLike} from "../../../../packages/plugin-vault/src/vaultServiceCoordinator.js";
import {SessionStateMirror} from "../../../../packages/plugin-vault/src/sessionStateMirror.js";
import {
  __testResetWalletStore, __testBootstrapWalletStorage, __testSeedWalletLocalRecords,
  __testResetState, __testGetSnapshot, __testAttachPort, __testDispatchStorageMessage,
  __testGetVaultStatus, __testGetActivePublicKeyHex, __testLock, __testColdStart, __testListWalletObjectPaths,
} from "../../../../apps/web/src/keymasterSessionCoordinator.worker.js";

test("USB 控制 RPC 不接收 PIN 或附加字段，配对决定必须为布尔值", () => {
  const request = { kind: "vault.operation", expectedSessionEpoch: "current", operation: { type: "hardware", command: { action: "state" } } };
  expect(() => COORDINATOR_RPC_CAPABILITY.request.parse(request)).not.toThrow();
  expect(() => COORDINATOR_RPC_CAPABILITY.request.parse({ ...request, operation: { type: "hardware", command: { action: "state", pin: "1234" } } })).toThrow();
  expect(() => COORDINATOR_RPC_CAPABILITY.request.parse({ ...request, operation: { type: "hardware", command: { action: "pair", leaseId: crypto.randomUUID(), allow: true } } })).toThrow();
});

test.each(["attach", "enroll", "attach-close"] as const)("正式 Coordinator：%s、真实 C++ 配对、独立控制面、错页面拒绝与全局锁撤销", async mode => {
  // IndexedDB 宿主与端口注册由已有显式测试入口提供；领域/RPC handler 与密码学均为生产实现。
  const dir = await mkdtemp(join(tmpdir(), "km-hardware-coordinator-"));
  const prefix = process.env.VLP_MBEDTLS_PREFIX ?? "/opt/homebrew/opt/mbedtls@3";
  const root = fileURLToPath(new URL("../../../../../", import.meta.url));
  const exe = join(dir, "device");
  const compiled = spawnSync("c++", ["-std=c++17", "-Wall", "-Wextra", "-Werror", "-fsanitize=address,undefined", `-I${prefix}/include`, ...nativeSdkSources(join(root,"Rockey")), join(root, "Rockey/Coding/Rockey/vaultlink-integration/tests/native.cpp"), `-L${prefix}/lib`, `-Wl,-rpath,${prefix}/lib`, "-lmbedtls", "-lmbedx509", "-lmbedcrypto", "-o", exe], { encoding: "utf8" });
  expect(compiled.status, compiled.stderr).toBe(0);
  const child = spawn(exe, [join(dir, "policy")], {env: {...process.env, ...(mode === "attach-close" ? {ROCKEY_HOST_CLOSE_AFTER_PROOF: "1"} : {})}});
  const exited = once(child, "exit"); let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", s => stderr += s);
  const channel = new MessageChannel(), leaseId = crypto.randomUUID();
  const iterator = child.stdout[Symbol.asyncIterator]();
  channel.port1.onmessage = async e => {
    const m = e.data; if (m.lease !== leaseId) return;
    if (m.type === "write") {
      if (!child.stdin.write(m.bytes)) await once(child.stdin, "drain");
      channel.port1.postMessage({ type: "written", lease: leaseId, id: m.id, ok: true });
    } else if (m.type === "close") { child.stdin.end(); channel.port1.close(); }
  };
  void (async () => {
    for (;;) {
      const value = await iterator.next(); if (value.done) break;
      channel.port1.postMessage({ type: "data", lease: leaseId, bytes: new Uint8Array(value.value) });
    }
    try { channel.port1.postMessage({ type: "closed", lease: leaseId }); } catch {}
  })();
  const responses = new Map<string, CoordinatorResponse>();
  const stateListeners = new Set<(event: import("@keymaster/contracts").SessionStateEvent) => void>();
  let appVault: VaultServiceCoordinator | undefined;
  const domainStore = createIndexedDbWalletStore({databaseName: "native-app-channels-" + crypto.randomUUID()});
  const ownedKv: import("@keymaster/contracts").KeyValueStore[] = [];
  let protocol: ProtocolServiceImpl | undefined;
  const appPort = new MessageChannel();
  const invoke = async (command: CoordinatorHardwareCommand, peerId = "hardware-page") => {
    const requestId = crypto.randomUUID();
    const parsed = COORDINATOR_RPC_CAPABILITY.request.parse({ kind: "vault.operation",
      expectedSessionEpoch: __testGetSnapshot().sessionEpoch, operation: { type: "hardware", command } });
    const transferred = structuredClone(parsed, { transfer: [...COORDINATOR_RPC_CAPABILITY.transfer!.request!(parsed)] });
    await __testDispatchStorageMessage(peerId, { ...transferred, clientId: peerId, requestId } as Parameters<typeof __testDispatchStorageMessage>[1]);
    const result = responses.get(requestId); responses.delete(requestId);
    if (!result) throw new Error("Missing Coordinator response");
    return result;
  };
  try {
    await __testResetWalletStore(); await __testBootstrapWalletStorage();
    const walletGeneration = crypto.randomUUID();
    const record = {bsvNetwork: "main" as const,  format: "keymaster.hardware-key", version: 1, backend: "vaultlink", wireVersion: 2, backendGeneration: 1,
      label: "RocKey fixture", publicKeyHex: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", walletGeneration };
    if (mode !== "enroll") await __testSeedWalletLocalRecords({ keyHold: JSON.stringify(record), meta: JSON.stringify({
      format: WALLET_META_FORMAT, version: 1, schemaVersion: WALLET_CURRENT_SCHEMA_VERSION, initialized: true, walletGeneration, createdAt: new Date().toISOString(),
    }) });
    __testResetState(); await __testBootstrapWalletStorage();
    for (const peer of ["hardware-page", "another-page"]) __testAttachPort(peer, value => {
      if (value && typeof value === "object" && "requestId" in value) responses.set((value as CoordinatorResponse).requestId, value as CoordinatorResponse);
      if (value && typeof value === "object" && "type" in value && value.type === "session.state.changed") {
        for (const listener of stateListeners) listener(value as import("@keymaster/contracts").SessionStateEvent);
      }
    });
    const pending = invoke(mode !== "enroll" ? { action: "attach", port: channel.port2, leaseId }
      : {action: "enroll", port: channel.port2, leaseId, label: "RocKey fixture"});
    const attached = await pending;
    if (mode === "attach-close") {
      const deadline = Date.now() + 2000;
      while (__testGetVaultStatus() !== "locked" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      expect(__testGetVaultStatus()).toBe("locked");
      expect(__testGetActivePublicKeyHex()).toBeUndefined();
      expect((await invoke({action: "state"})).operationResult).toEqual({status: "disconnected"});
      expect(await __testColdStart()).toMatchObject({state: "ready", key: {backend: "hardware", publicKeyHex: record.publicKeyHex}});
      return;
    }
    expect(attached.ack,JSON.stringify(attached.ack)).toMatchObject({status:"ok"});
    expect(attached.operationResult).toMatchObject({ status: "connected", leaseId });
    if (mode === "enroll") {
      expect(await __testColdStart()).toMatchObject({state: "ready", key: {backend: "hardware", publicKeyHex: record.publicKeyHex}});
      expect(await __testListWalletObjectPaths()).toEqual(expect.arrayContaining(["key.json", ".keymaster/meta", ".keymaster/system/wallet/initialization/current"]));
      const rejected = new MessageChannel();
      expect((await invoke({action: "enroll", port: rejected.port2, leaseId: crypto.randomUUID(), label: "Another Key"})).ack.status).toBe("error");
      rejected.port1.close();
    }
    expect(__testGetVaultStatus()).toBe("unlocked"); expect(__testGetActivePublicKeyHex()).toBe(record.publicKeyHex);
    expect((await invoke({ action: "disconnect", leaseId }, "another-page")).ack.status).toBe("error");
    expect((await invoke({ action: "state" })).operationResult).toMatchObject({ status: "connected" });
    const vault = async (operation: import("@keymaster/contracts").CoordinatorVaultOperation) => {
      const requestId = crypto.randomUUID();
      const request = COORDINATOR_RPC_CAPABILITY.request.parse({kind:"vault.operation",expectedSessionEpoch:__testGetSnapshot().sessionEpoch,operation});
      await __testDispatchStorageMessage("hardware-page",{...request,clientId:"hardware-page",requestId} as Parameters<typeof __testDispatchStorageMessage>[1]);
      const result = responses.get(requestId); responses.delete(requestId);
      expect(result?.ack.status,JSON.stringify(result?.ack)).toBe("ok"); return result?.operationResult;
    };
    const cryptoOperation = async (operation: import("@keymaster/contracts").CoordinatorCryptoOperation) => {
      const requestId=crypto.randomUUID();
      const request=COORDINATOR_RPC_CAPABILITY.request.parse({kind:"crypto",expectedSessionEpoch:__testGetSnapshot().sessionEpoch,operation});
      await __testDispatchStorageMessage("hardware-page",{...request,clientId:"hardware-page",requestId} as Parameters<typeof __testDispatchStorageMessage>[1]);
      const result=responses.get(requestId);responses.delete(requestId);return result;
    };
    // 页面端只适配真实 Root 的控制/事件消息；密码、身份、撤权和密码学均执行生产代码。
    const subscriptionId = crypto.randomUUID();
    await __testDispatchStorageMessage("hardware-page", {kind: "subscribe", clientId: "hardware-page", requestId: subscriptionId, topics: ["session.state"]});
    expect(responses.get(subscriptionId)?.ack.status).toBe("ok"); responses.delete(subscriptionId);
    const mirror = new SessionStateMirror({getBootstrapSnapshot: __testGetSnapshot, subscribeTopic: (_topic, listener) => {
      stateListeners.add(listener); return () => {stateListeners.delete(listener);};
    }});
    const client = {
      getIsConnected: () => true,
      vaultOperation: async (operation: import("@keymaster/contracts").CoordinatorVaultOperation) => {
        const requestId = crypto.randomUUID();
        const parsed = COORDINATOR_RPC_CAPABILITY.request.parse({kind: "vault.operation", expectedSessionEpoch: __testGetSnapshot().sessionEpoch, operation});
        await __testDispatchStorageMessage("hardware-page", {...parsed, clientId: "hardware-page", requestId} as Parameters<typeof __testDispatchStorageMessage>[1]);
        const response = responses.get(requestId)!; responses.delete(requestId);
        return response.ack.status === "ok" ? {...response.ack, value: response.operationResult, sessionEpoch: response.sessionEpoch} : response.ack;
      },
      crypto: async (operation: import("@keymaster/contracts").CoordinatorCryptoOperation) => {
        const response = await cryptoOperation(operation);
        return {ack: response!.ack, result: response!.cryptoResult};
      },
    } as unknown as CoordinatorClientLike;
    appVault = new VaultServiceCoordinator({coordinatorClient: client, sessionStateMirror: mirror});
    expect(appVault.walletSnapshot().activeKeyIdentity?.backend).toBe("hardware");
    await expect(appVault.verifyPassword("1234")).rejects.toThrow();
    await expect(appVault.createAppViewSession({sessionId: "pin-in-browser", publicKeyHex: record.publicKeyHex, password: "1234"})).rejects.toThrow("PIN must be entered on the device");
    const appCrypto = await appVault.createAppViewSession({sessionId: "device-app", publicKeyHex: record.publicKeyHex, password: ""});
    expect(await appCrypto.deriveP2pkhAddress({publicKeyHex: record.publicKeyHex, network: "main"})).toMatchObject({address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"});
    // 真实 IndexedDB 领域库、正式 Connect 分派及实际 C++ 账本，端口仅适配 Window。
    const domainRoot = createPlatformRootStore({identity: {bsvNetwork:"main",publicKeyHex:"0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"}, store: domainStore, generations: () => {
      const state = __testGetSnapshot();
      return {walletGeneration: state.walletGeneration!, sessionEpoch: state.sessionEpoch, runGeneration: state.runGeneration};
    }});
    for (const declaration of [CENTRAL_STORAGE_DECLARATIONS.protocolDurablePolicy, CENTRAL_STORAGE_DECLARATIONS.protocolSessions, CENTRAL_STORAGE_DECLARATIONS.protocolCommandHistory]) {
      ownedKv.push(await domainRoot.openPlatformStore({declaration}));
    }
    const repository = await openProtocolStorageRepository({durablePolicy: ownedKv[0]!, sessions: ownedKv[1]!, commandHistory: ownedKv[2]!});
    const origin = "https://native-app.example", connectSessionId = crypto.randomUUID();
    await repository.putConnectSession({networkIdentity: { bsvNetwork: "main" as const, publicKeyHex: record.publicKeyHex }, sessionId: connectSessionId, origin, ownerPublicKeyHex: record.publicKeyHex, ownerLabel: "Native App", claimsSnapshot: {}, createdAt: Date.now(), lastUsedAt: Date.now(), revokedAt: null});
    protocol = new ProtocolServiceImpl({vault: appVault, walletState: {snapshot: () => appVault!.walletSnapshot(), subscribe: handler => appVault!.subscribeWalletState(handler)}, storageRepository: repository,
      resolveOpener: () => appPort.port1 as unknown as Window,
      postReady: (_target, value) => appPort.port1.postMessage(value),
      postResult: (_target, _origin, value) => appPort.port1.postMessage(value),
    });
    const appReplies = new Map<string, import("@keymaster/contracts").ProtocolResultMessage>();
    appPort.port2.onmessage = event => {if (event.data.type === "result") appReplies.set(event.data.id, event.data);};
    protocol.startSession();
    const registerAppChannel = async (name: string) => {
      const id = crypto.randomUUID();
      await protocol!.handleMessage({origin, source: appPort.port1, data: { networkIdentity: {bsvNetwork: "main", publicKeyHex: record.publicKeyHex},v: 1, type: "request", id, method: "payment.channel.register", params: {connectSessionId, channelName: name, paymentType: "p2pkh"}}} as unknown as MessageEvent);
      const deadline = Date.now() + 3000;
      while (!appReplies.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      const response = appReplies.get(id);
      expect(response, JSON.stringify(response)).toMatchObject({ok: true});
      return (response as Extract<import("@keymaster/contracts").ProtocolResultMessage, {ok: true}>).result as {channelId: string};
    };
    const first = await registerAppChannel("checkout");
    expect(first.channelId).toMatch(/^pay\.[0-9a-f]{64}$/);
    expect(await registerAppChannel("checkout")).toEqual(first);
    const second = await registerAppChannel("subscription");
    expect(second).not.toEqual(first);
    const appChannels = await vault({type: "payment", command: {action: "list"}}) as import("@keymaster/contracts").WalletPaymentChannel[];
    expect(appChannels.filter(channel => channel.id === first.channelId)).toMatchObject([{kind: "app", singleLimit: "0", defaultSessionLimit: "0"}]);
    // The real Connect dispatcher builds its existing v1 CBOR envelope; C++ parses and signs it.
    const semanticRequest = async (method: "identity.get" | "intent.sign", extra: Record<string,unknown>) => {
      const id=crypto.randomUUID(),iat=Math.floor(Date.now()/1000);
      await protocol!.handleMessage({origin,source:appPort.port1,data:{ networkIdentity: {bsvNetwork: "main", publicKeyHex: record.publicKeyHex},v:1,type:"request",id,method,params:{connectSessionId,aud:origin,iat,exp:iat+600,text:"Native Connect test",...extra}}} as unknown as MessageEvent);
      expect(protocol!.snapshot().phase).toBe("confirming");
      await protocol!.confirmByUser();
      const deadline=Date.now()+3000;
      while(!appReplies.has(id)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
      const response=appReplies.get(id);
      expect(response,JSON.stringify(response)).toMatchObject({ok:true});
      return (response as Extract<import("@keymaster/contracts").ProtocolResultMessage,{ok:true}>).result as Record<string,{bytes:ArrayBuffer}>;
    };
    const identity=await semanticRequest("identity.get",{claims:["key.label"]});
    const intent=await semanticRequest("intent.sign",{contentType:"text/plain",content:{$type:"binary",bytes:new TextEncoder().encode("actual intent").buffer}});
    const publicKey=Uint8Array.from(record.publicKeyHex.match(/../g)!,value=>parseInt(value,16));
    expect(verifyCompactSecp256k1(new Uint8Array(identity.signature!.bytes),new Uint8Array(identity.identityEnvelope!.bytes),publicKey)).toBe(true);
    expect(verifyCompactSecp256k1(new Uint8Array(intent.signature!.bytes),new Uint8Array(intent.signedEnvelope!.bytes),publicKey)).toBe(true);
    expect((stderr.match(/review:connect.identity-sign/g)??[]).length).toBe(1);
    expect((stderr.match(/review:connect.intent-sign/g)??[]).length).toBe(1);
    expect((await cryptoOperation({type:"deriveP2pkhAddress",network:"main"}))?.cryptoResult).toEqual({type:"deriveP2pkhAddress",address:"1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"});
    expect((await cryptoOperation({type:"signDigest",digestHex:"01".repeat(32),format:"der"}))?.ack).toMatchObject({status:"error",message:"hardware-profile-required"});
    // 用正式 Connect 刚注册的两个渠道测试总额；不能换成测试专用 owner/渠道绕过接线。
    const config = appChannels.find(channel => channel.id === first.channelId)!;
    const secondConfig = appChannels.find(channel => channel.id === second.channelId)!;
    expect(secondConfig.owner).toBe(config.owner);
    for (const channel of [config, secondConfig]) {
      // 修改同 owner 的默认会话额度会推进其所有渠道的 revision；下一项重新读真值。
      const currentChannels = await vault({type:"payment",command:{action:"list"}}) as import("@keymaster/contracts").WalletPaymentChannel[];
      const current = currentChannels.find(value => value.id === channel.id)!;
      await vault({type:"payment",command:{action:"configure",channel:{...current,singleLimit:"400",defaultSessionLimit:"500",revision:current.revision + 1}}});
    }
    const sessionId = connectSessionId;
    await vault({type:"payment",command:{action:"session-open",id:sessionId,owner:config.owner}});
    const key = new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),1]));
    const peer = new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),2]));
    try {
      const previous = serializeTransaction({version:1,inputs:[{txid:new Uint8Array(32),vout:0xffffffff,script:Uint8Array.of(1),sequence:0xffffffff}],outputs:[{satoshis:1000n,script:p2pkhScript(key.publicKey())}],locktime:0});
      const raw = serializeTransaction({version:1,inputs:[{txid:await sha256d(previous),vout:0,script:new Uint8Array(),sequence:0xffffffff}],outputs:[{satoshis:300n,script:p2pkhScript(peer.publicKey())},{satoshis:690n,script:p2pkhScript(key.publicKey())}],locktime:0});
      for (const [id, channelId] of [["one", first.channelId], ["two", second.channelId]] as const) {
        // 每次业务调用可以重开同一活动会话，但第一次的 300 聪必须保留。
        await vault({type:"payment",command:{action:"session-open",id:sessionId,owner:config.owner}});
        const result = await vault({type:"payment",command:{action:"sign-p2pkh",rawTxHex:hex(raw),prevTransactionHexes:[hex(previous)],channelId,paymentId:id,sessionId}}) as {amount:string;fee:string;signatures:string[]};
        expect(result).toMatchObject({amount:"300",fee:"10"}); expect(result.signatures[0]).toMatch(/41$/);
      }
      expect((stderr.match(/review:tx.p2pkh-payment/g)??[]).length).toBe(1);
      await expect.poll(()=>(stderr.match(/auto-approved:tx.p2pkh-payment/g)??[]).length).toBe(1);
      expect(await vault({type:"payment",command:{action:"pending"}})).toEqual([]);
      const sealed = await vault({type:"sealLocalSecret",scope:"storage.test",plaintext:new Uint8Array(32).fill(7)}) as Extract<import("@keymaster/contracts").CoordinatorVaultOperation,{type:"openLocalSecret"}>["sealed"];
      expect(await vault({type:"openLocalSecret",scope:"storage.test",sealed})).toEqual(new Uint8Array(32).fill(7));
      await vault({type:"payment",command:{action:"session-close",id:sessionId}});
    } finally { key.close(); peer.close(); }
    // 真正结束 C++ 字节流；设备断线触发连接所有者回调并撤销业务解锁。
    child.stdin.end();
    const closedDeadline = Date.now()+2000;
    while (__testGetVaultStatus() !== "locked" && Date.now()<closedDeadline) await new Promise(r=>setTimeout(r,5));
    expect(__testGetVaultStatus()).toBe("locked");
    expect(appVault.status()).toBe("locked");
    expect(() => appCrypto.getIdentity()).toThrow("revoked");
    await expect(appCrypto.deriveP2pkhAddress({publicKeyHex: record.publicKeyHex, network: "main"})).rejects.toThrow("revoked");
    await __testLock();
    expect((await invoke({ action: "state" })).operationResult).toEqual({ status: "disconnected" });
    expect(__testGetActivePublicKeyHex()).toBeUndefined();
  } finally {
    protocol?.endSession(); appPort.port1.close(); appPort.port2.close();
    for (const kv of ownedKv) kv.close(); domainStore.close();
    appVault?.dispose?.();
    await __testResetWalletStore(); channel.port1.close(); channel.port2.close(); child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    const [code] = await exited; clearTimeout(timer); await rm(dir, { recursive: true, force: true });
    expect(code, stderr).toBe(0);
  }
});
