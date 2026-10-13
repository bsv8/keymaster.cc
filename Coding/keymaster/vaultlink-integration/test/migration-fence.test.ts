import {test,expect} from 'vitest';
import {WalletMigrationFence} from '../src/migration-fence.js';
test('migration rejects new admission and waits for every existing read/write, then releases idempotently',async()=>{
 const fence=new WalletMigrationFence(),read=await fence.acquire(),write=await fence.acquire();
 let entered=false;const migration=fence.acquire(true).then(lease=>{entered=true;return lease;});
 await expect(fence.acquire()).rejects.toThrow('migration-pending');
 await expect(fence.acquire(true)).rejects.toThrow('migration-pending');
 read.release();await Promise.resolve();expect(entered).toBe(false);
 write.release();const lease=await migration;expect(entered).toBe(true);
 await expect(fence.acquire()).rejects.toThrow('migration-pending');lease.release();lease.release();
 (await fence.acquire()).release();
});
test('cancellation while draining releases migration reservation without releasing existing business I/O',async()=>{
 const fence=new WalletMigrationFence(),old=await fence.acquire(),cancel=new AbortController();
 const migration=fence.acquire(true,cancel.signal);cancel.abort();
 await expect(migration).rejects.toThrow('migration-session-revoked');
 const newer=await fence.acquire();newer.release();old.release();(await fence.acquire(true)).release();
});
