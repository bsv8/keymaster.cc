import {readdirSync} from 'node:fs';
import {join} from 'node:path';
/** Actual pinned converter used by the product firmware's Channel JCS parser. */
export function nativeSdkSources(rockeyRoot) {
 const dir=join(rockeyRoot,'Coding/Rockey/vaultlink-sdk/device/third_party/double-conversion');
 return readdirSync(dir).filter(name=>name.endsWith('.cc')).sort().map(name=>join(dir,name));
}
