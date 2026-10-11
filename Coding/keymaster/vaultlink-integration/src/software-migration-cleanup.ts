import {unhex} from '@vaultlink/sdk';
import type {VaultLinkHardwareBackend} from './hardware-backend.js';
import {verifyDeviceMigrationJournal,type MigrationJournal} from './migration-journal.js';

/** Optional disposal owns no wallet lease, password or private bytes. The
 * caller holds a restricted USB connection and closes it on every outcome.
 * A denial/disconnect is a retained backup, never a failed wallet migration. */
export async function requestMigratedDeviceErase(journal:MigrationJournal,device:Pick<VaultLinkHardwareBackend,
 'migrationStatus'|'acknowledgeMigration'|'eraseMigrationSource'>):Promise<void>{
 if(journal.target!=='software'||journal.phase!=='complete'||!journal.targetHash)throw Error('migration-conflict');
 let state=await device.migrationStatus();
 if(!state)throw Error('migration-device-record-missing');
 verifyDeviceMigrationJournal(journal,state);
 if(state.phase==='device-committed'||state.phase==='host-committed'){
  state=await device.acknowledgeMigration(state,unhex(journal.targetHash));
  verifyDeviceMigrationJournal(journal,state);
 }
 if(state.phase==='complete'||state.phase==='erasing'){
  state=await device.eraseMigrationSource(state,unhex(journal.targetHash));
  verifyDeviceMigrationJournal(journal,state);
  if(state.phase!=='erased')throw Error('migration-conflict');
 }
}
