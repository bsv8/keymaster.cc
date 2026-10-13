import test from 'node:test';
import assert from 'node:assert/strict';
import {VaultLinkHardwareBackend} from '../dist/index.js';
import {sha256,unhex} from '@vaultlink/sdk';
import {openActualMigrationDevice} from './native-migration-device.mjs';
test('actual KeyStore + encrypted product Runtime: physical export, host completion, independent optional erase',async()=>{
 const d=await openActualMigrationDevice(VaultLinkHardwareBackend);
 try{
  assert.equal(await d.backend.migrationStatus(),null);
  const bank=await d.backend.exportPaymentPolicy();
  const binding={id:crypto.randomUUID(),walletGeneration:crypto.randomUUID(),publicKey:unhex(d.pub),
    sourceHash:await sha256(new TextEncoder().encode('public source-record fixture')),policyHash:await sha256(bank),direction:'to-software'};
  const exported=await d.backend.exportMigrationKey(binding);
  try{assert.equal(exported.privateKey.length,32);assert.equal(exported.privateKey[31],1);assert.equal(exported.migration.phase,'device-committed');}
  finally{exported.privateKey.fill(0);}
  assert.deepEqual(await d.backend.migrationStatus(),exported.migration);
  await assert.rejects(d.backend.signNetworkIdentity('noise',{staticKey:new Uint8Array(32).fill(7)}),/migration-pending/);
  const target=await sha256(new TextEncoder().encode('public target-record fixture'));
  await assert.rejects(d.backend.eraseMigrationSource(exported.migration,target),/migration-conflict/);
  const committed=await d.backend.acknowledgeMigration(exported.migration,target);
  assert.equal(committed.phase,'complete');
  const erased=await d.backend.eraseMigrationSource(committed,target);
  assert.equal(erased.phase,'erased');assert.deepEqual(erased.targetHash,target);
  assert.match(d.log(),/host-review:migration.export:pin=0/);assert.match(d.log(),/host-review:migration.erase:pin=0/);
 }finally{await d.close();}
});
