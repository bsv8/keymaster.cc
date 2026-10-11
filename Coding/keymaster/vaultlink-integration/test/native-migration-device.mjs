import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {nativeSdkSources} from './native-sdk-sources.mjs';
export async function startActualMigrationDevice(options={}) {
 const dir=await mkdtemp(join(tmpdir(),'rockey-private-migration-'));
 const root=options.rockeyRoot??process.env.ROCKEY_ROOT??join(fileURLToPath(new URL('../../../../../',import.meta.url)),'Rockey');
 const prefix=process.env.VLP_MBEDTLS_PREFIX??'/opt/homebrew/opt/mbedtls@3',exe=join(dir,'device');
 const sources=[options.controller?'Coding/Rockey/vaultlink-integration/tests/controller_native.cpp':options.importing?'Coding/Rockey/vaultlink-integration/tests/import_native.cpp':'Coding/Rockey/vaultlink-integration/tests/migration_native.cpp','tests/host/shim_env.cpp','src/store/keystore.cpp','src/store/vault_fs.cpp','src/store/crc32.cpp','src/crypto/digest.cpp','src/crypto/aead.cpp','src/crypto/rand.cpp','src/crypto/secure.cpp','src/i18n/i18n.cpp','tests/host/shim_esp_aes.cpp',...(options.controller?['src/board/buttons.cpp','src/board/display.cpp','src/ui/font.cpp','src/ui/text.cpp','src/ui/widgets.cpp']:[])];
 const cc=spawnSync('c++',['-std=gnu++17','-Wall','-Wextra','-fsanitize=address,undefined','-DROCKEY_LANG_EN=1',...(options.controller?['-DROCKEY_FONT_TABLE=1']:[]),'-DMBEDTLS_ALLOW_PRIVATE_ACCESS',`-I${root}/src`,`-I${root}/tests/host/stubs`,`-I${prefix}/include`,...nativeSdkSources(root),...sources.map(s=>join(root,s)),`-L${prefix}/lib`,`-Wl,-rpath,${prefix}/lib`,'-lmbedtls','-lmbedx509','-lmbedcrypto','-o',exe],{encoding:'utf8'});
 if(cc.status!==0){await rm(dir,{recursive:true,force:true});throw Error(cc.stderr);}
 const j=options.journal;const args=j?[options.phase,j.migrationId,j.walletGeneration,j.sourceHash,j.policyHash,...(options.importing?[]:[j.targetHash])]:[];
 const child=spawn(exe,args,{env:{...process.env,...(options.manualPair?{ROCKEY_HOST_MANUAL_PAIR:'1'}:{}),...(options.eraseDecision?{ROCKEY_HOST_ERASE_DECISION:options.eraseDecision}:{}),...(options.denyExport?{ROCKEY_HOST_EXPORT_DENY:'1'}:{})}}),exited=once(child,'exit'),reader=child.stdout[Symbol.asyncIterator]();let log='';
 child.stderr.setEncoding('utf8');child.stderr.on('data',s=>log+=s);
 const pub='0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
 const transport={async read(){const v=await reader.next();return v.done?null:new Uint8Array(v.value);},async write(b){if(!child.stdin.write(b))await once(child.stdin,'drain');},async close(){child.stdin.end();}};
 return {transport,pub,approvePair(){child.kill('SIGUSR2');},scrollReview(){child.kill('SIGUSR1');},approveErase(){child.kill('SIGUSR2');},denyErase(){child.kill('SIGUSR1');},log:()=>log,async close(){child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{const [code]=await exited;if(code!==0)throw Error(log);}finally{clearTimeout(timer);await rm(dir,{recursive:true,force:true});}}};
}
export async function openActualMigrationDevice(Backend,options={}) {
 const device=await startActualMigrationDevice(options);let backend;
 try{backend=await Backend.connect(device.transport,
   {bsvNetwork: options.bsvNetwork??"main", ...(options.journal?{journal:options.journal}:{}),publicKeyHex:device.pub,generations:{walletGeneration:1,backendGeneration:1,hostRunGeneration:1},assertActive(){}},async()=>true);
 }catch(e){await device.close();throw Error(String(e)+"\n"+device.log(),{cause:e});}
 return {...device,backend,async close(){await backend.close().catch(()=>{});await device.close();}};
}
