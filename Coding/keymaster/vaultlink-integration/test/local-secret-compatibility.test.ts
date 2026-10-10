import {test,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encode,decode,hex,unhex,type Value} from '@vaultlink/sdk';
import {createWorkerKeySession} from '../../../../packages/plugin-vault/src/workerKeySession.js';
import {executeVaultOperation} from '../../../../packages/plugin-vault/src/vaultOperationExecutor.js';
import type {VaultSealedSecret} from '@keymaster/contracts';
test('existing Keymaster v3 ciphertext opens on actual C++ device; device output opens in existing Worker algorithm',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'km-local-secret-'));
 const root=fileURLToPath(new URL('../../../../../',import.meta.url));
 const prefix=process.env.VLP_MBEDTLS_PREFIX??'/opt/homebrew/opt/mbedtls@3';
 const exe=join(dir,'device');
 const compiled=spawnSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',`-I${join(root,'Rockey/Coding/Rockey/vaultlink-sdk')}`,`-I${prefix}/include`,fileURLToPath(new URL('./local-secret-native.cpp',import.meta.url)),`-L${prefix}/lib`,`-Wl,-rpath,${prefix}/lib`,'-lmbedtls','-lmbedcrypto','-o',exe],{encoding:'utf8'});
 expect(compiled.status,compiled.stderr).toBe(0);
 const privateKey=unhex('00'.repeat(31)+'01'), publicKeyHex='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
 const session=createWorkerKeySession(()=>({unlocked:true,publicKeyHex,sessionEpoch:'compat'}));session.replace(privateKey);
 const deps={assertSecretSession:()=>session.assert(),deriveLocalSecretKey:(scope:string)=>session.deriveLocalSecretKey(scope),lifecycle(){throw Error('not a lifecycle test');},currentKey:()=>undefined,beforePasswordChange:async()=>{},passwordChanged(){},renamed(){}};
 const scope='storage.bucket-password';
 const native=(op:string,body:Value)=>spawnSync(exe,[op,hex(encode(body,32768))],{encoding:'utf8'});
 try{
  for(const n of [1,32,512]){
   const plain=new Uint8Array(n).map((_,i)=>i%251);
   // 密文由现有生产 Worker 的密钥派生和 VaultOperationExecutor 生成。
   const sealed=await executeVaultOperation({type:'sealLocalSecret',scope,plaintext:plain.slice()},deps) as VaultSealedSecret;
   const opened=native('open',{scope,sealed:sealed as unknown as Value});expect(opened.status,opened.stderr).toBe(0);
   expect((decode(unhex(opened.stdout.trim()),32768) as {plaintext:Uint8Array}).plaintext).toEqual(plain);
   const encoded=native('seal',{scope,plaintext:plain});expect(encoded.status,encoded.stderr).toBe(0);
   const deviceSealed=decode(unhex(encoded.stdout.trim()),32768) as unknown as VaultSealedSecret;
   const restored=await executeVaultOperation({type:'openLocalSecret',scope,sealed:deviceSealed},deps);expect(restored).toEqual(plain);
   expect(native('open-other-key',{scope,sealed:sealed as unknown as Value}).status).toBe(1);
   const locked=native('open-locked',{scope,sealed:sealed as unknown as Value});expect(locked.status).toBe(1);expect(locked.stderr).toContain('locked');
   expect(native('open',{scope:'other.scope' ,sealed:sealed as unknown as Value}).status).toBe(1);
   const changed={...sealed,ciphertextHex:(sealed.ciphertextHex.startsWith('00')?'01':'00')+sealed.ciphertextHex.slice(2)};
   expect(native('open',{scope,sealed:changed as unknown as Value}).status).toBe(1);
  }
  expect(native('seal',{scope,plaintext:new Uint8Array(513)}).status).toBe(1);
  expect(native('seal',{scope:'bad\0scope',plaintext:Uint8Array.of(1)}).status).toBe(1);
 }finally{session.clear();await rm(dir,{recursive:true,force:true});}
});
