export function bitfsDownloadLockName(owner: string, seed: string): string {
  return `keymaster.msfile.download:${owner}:${seed}`;
}

/** Try once. Returning from the callback releases the browser's lock. */
export function tryBitfsDownloadLock(name: string): Promise<(() => void) | undefined> {
  if (!navigator.locks) return Promise.reject(new Error("浏览器缺少下载所需的文件锁"));
  return new Promise((resolve, reject) => {
    void navigator.locks.request(name, { ifAvailable: true }, lock => {
      if (!lock) { resolve(undefined); return; }
      return new Promise<void>(release => resolve(release));
    }).catch(reject);
  });
}
