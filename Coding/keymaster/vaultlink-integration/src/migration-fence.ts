/** Worker-local wallet I/O admission. The origin authority lock prevents other
 * Workers; this fence additionally drains THIS Worker's in-flight operations
 * before migration and rejects new business I/O throughout its two commits.
 * A migration caller must not enter nested ordinary I/O leases. */
export class WalletMigrationFence {
  private active=new Set<symbol>();
  private exclusive:symbol|undefined;
  private notify=new Set<()=>void>();
  async acquire(migration=false,signal?:AbortSignal):Promise<{release():void}> {
    if(signal?.aborted)throw Error('migration-session-revoked');
    if(this.exclusive)throw Error('migration-pending');
    const id=Symbol();
    if(migration){
      this.exclusive=id;
      try {
        while(this.active.size){
          await new Promise<void>((resolve,reject)=>{
            const changed=()=>{cleanup();resolve();},aborted=()=>{cleanup();reject(Error('migration-session-revoked'));};
            const cleanup=()=>{this.notify.delete(changed);signal?.removeEventListener('abort',aborted);};
            this.notify.add(changed);signal?.addEventListener('abort',aborted,{once:true});
            if(signal?.aborted)aborted();
          });
        }
        if(signal?.aborted)throw Error('migration-session-revoked');
      }catch(error){if(this.exclusive===id)this.exclusive=undefined;throw error;}
    }
    this.active.add(id);let released=false;
    return {release:()=>{
      if(released)return;released=true;this.active.delete(id);
      if(this.exclusive===id)this.exclusive=undefined;
      for(const changed of [...this.notify])changed();
    }};
  }
}
