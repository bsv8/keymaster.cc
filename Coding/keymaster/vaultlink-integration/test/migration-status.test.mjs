import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {nativeSdkSources} from './native-sdk-sources.mjs';
import {VaultLinkHardwareBackend} from '../dist/index.js';
import {encodeDeviceMigration,encodePaymentPolicy,sha256,unhex} from '@vaultlink/sdk';

test('actual RocKey encrypted endpoint returns public migration progress and blocks ordinary signatures/configuration until completion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'rockey-migration-status-'));
  const root=process.env.ROCKEY_ROOT??join(fileURLToPath(new URL('../../../../../',import.meta.url)),'Rockey');
  const prefix=process.env.VLP_MBEDTLS_PREFIX??'/opt/homebrew/opt/mbedtls@3',exe=join(dir,'device');
  try {
    const cc=spawnSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',`-I${prefix}/include`,...nativeSdkSources(root),join(root,'Coding/Rockey/vaultlink-integration/tests/native.cpp'),`-L${prefix}/lib`,`-Wl,-rpath,${prefix}/lib`,'-lmbedtls','-lmbedx509','-lmbedcrypto','-o',exe],{encoding:'utf8'});
    assert.equal(cc.status,0,cc.stderr);
    const publicKeyHex='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
    const bank=encodePaymentPolicy({version:2,key:publicKeyHex,channels:[],sessions:[],pending:[],pools:[]},publicKeyHex);
    const path=join(dir,'policy'),marker=path+'.migration';await writeFile(path,bank);
    const initial={version:1,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',walletGeneration:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      publicKey:unhex(publicKeyHex),sourceHash:new Uint8Array(32).fill(1),policyHash:await sha256(bank),direction:'to-hardware',phase:'device-committed',targetHash:null};
    for(const phase of ['device-committed','complete']) {
      const state={...initial,phase,targetHash:phase==='complete'?new Uint8Array(32).fill(3):null};
      const bytes=encodeDeviceMigration(state);await writeFile(marker,bytes);
      const child=spawn(exe,[path]),exited=once(child,'exit'),reader=child.stdout[Symbol.asyncIterator]();
      let log='',backend;child.stderr.setEncoding('utf8');child.stderr.on('data',s=>log+=s);
      try {
        backend=await VaultLinkHardwareBackend.connect({async read(){const v=await reader.next();return v.done?null:new Uint8Array(v.value);},async write(b){if(!child.stdin.write(b))await once(child.stdin,'drain');},async close(){child.stdin.end();}},
          {publicKeyHex,generations:{walletGeneration:1,backendGeneration:1,hostRunGeneration:1},assertActive(){}},async()=>true);
        assert.deepEqual(await backend.migrationStatus(),state);
        assert.deepEqual(await backend.exportPaymentPolicy(),bank);
        if(phase==='device-committed') {
          await assert.rejects(backend.signNetworkIdentity('noise',{staticKey:new Uint8Array(32).fill(7)}),/migration-pending/);
          await assert.rejects(backend.configureChannel({id:'plugin.p2pkh',owner:'p2pkh',kind:'plugin',network:'main',paymentType:'p2pkh',enabled:true,singleLimit:100n,defaultSessionLimit:0n,revision:1}),/migration-pending/);
          assert.deepEqual(await readFile(path),Buffer.from(bank));assert.doesNotMatch(log,/review:/);
        }else {
          assert.ok((await backend.signNetworkIdentity('noise',{staticKey:new Uint8Array(32).fill(7)})).length>0);
          assert.match(log,/review:identity.noise-proof/);
        }
        assert.deepEqual(await readFile(marker),Buffer.from(bytes));
      }finally{
        await backend?.close().catch(()=>{});child.stdin.end();
        const [code]=await exited;assert.equal(code,0,log);
      }
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
