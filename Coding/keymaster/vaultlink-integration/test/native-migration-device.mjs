import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {nativeSdkSources} from './native-sdk-sources.mjs';
export async function openActualMigrationDevice(Backend,options={}) {
 const dir=await mkdtemp(join(tmpdir(),'rockey-private-migration-'));
 const root=process.env.ROCKEY_ROOT??join(fileURLToPath(new URL('../../../../../',import.meta.url)),'Rockey');
 const prefix=process.env.VLP_MBEDTLS_PREFIX??'/opt/homebrew/opt/mbedtls@3',exe=join(dir,'device');
 const sources=[options.importing?'Coding/Rockey/vaultlink-integration/tests/import_native.cpp':'Coding/Rockey/vaultlink-integration/tests/migration_native.cpp','tests/host/shim_env.cpp','src/store/keystore.cpp','src/store/vault_fs.cpp','src/store/crc32.cpp','src/crypto/digest.cpp','src/crypto/aead.cpp','src/crypto/rand.cpp','src/crypto/secure.cpp','src/i18n/i18n.cpp','tests/host/shim_esp_aes.cpp'];
 const cc=spawnSync('c++',['-std=gnu++17','-Wall','-Wextra','-fsanitize=address,undefined','-DROCKEY_LANG_EN=1','-DMBEDTLS_ALLOW_PRIVATE_ACCESS',`-I${root}/src`,`-I${root}/tests/host/stubs`,`-I${prefix}/include`,...nativeSdkSources(root),...sources.map(s=>join(root,s)),`-L${prefix}/lib`,`-Wl,-rpath,${prefix}/lib`,'-lmbedtls','-lmbedx509','-lmbedcrypto','-o',exe],{encoding:'utf8'});
 if(cc.status!==0){await rm(dir,{recursive:true,force:true});throw Error(cc.stderr);}
 const j=options.journal;const args=j?[options.phase,j.migrationId,j.walletGeneration,j.sourceHash,j.policyHash,...(options.importing?[]:[j.targetHash])]:[];
 const child=spawn(exe,args),exited=once(child,'exit'),reader=child.stdout[Symbol.asyncIterator]();let log='',backend;
 child.stderr.setEncoding('utf8');child.stderr.on('data',s=>log+=s);
 const pub='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
 try{backend=await Backend.connect({async read(){const v=await reader.next();return v.done?null:new Uint8Array(v.value);},async write(b){if(!child.stdin.write(b))await once(child.stdin,'drain');},async close(){child.stdin.end();}},
   {...(j?{journal:j}:{}),publicKeyHex:pub,generations:{walletGeneration:1,backendGeneration:1,hostRunGeneration:1},assertActive(){}},async()=>true);
 }catch(e){child.kill();await exited.catch(()=>{});await rm(dir,{recursive:true,force:true});throw Error(String(e)+"\n"+log,{cause:e});}
 return {backend,pub,armExport(){child.kill("SIGUSR1");},log:()=>log,async close(){await backend.close().catch(()=>{});child.stdin.end();const [code]=await exited;await rm(dir,{recursive:true,force:true});if(code!==0)throw Error(log);}};
}
