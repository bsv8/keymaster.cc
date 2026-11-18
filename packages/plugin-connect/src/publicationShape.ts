// Communication shape validation only; no signing, verification or file hashing.
const MAX_FILES_ENTRIES=100000;
function publicationURL(s:unknown):string {if(typeof s!=='string')throw new Error('HTTP(S) URL required');const u=new URL(s);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('HTTP(S) URL required');return u.href}
export function canonicalPublicationJSON(value:unknown):string {if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return '['+value.map(canonicalPublicationJSON).join(',')+']';const o=value as Record<string,unknown>;return '{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canonicalPublicationJSON(o[k])).join(',')+'}'}
export interface AppFileEntry {path:string;mime:string;size:number;seedhashhex:string}
export interface Publication {version:1;appVersion:string;kind:'url'|'files'|'both';appPublicKeyHex:string;name:string;description:string;url?:{address:string;icon:string};files?:{entrySeedhashhex:string;icon:string;files:AppFileEntry[]}}
export interface PublicationProof {publication:Publication;signatureHex:string}
function fields(value:any,keys:string[]):void {if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw new Error('publication fields invalid')}
function text(value:unknown,max:number,required=true):string {if(typeof value!=='string'||value!==value.trim()||(required&&!value)||[...value].length>max||/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value))throw new Error('publication text invalid');return value}
function seedhash(value:unknown):string {if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw new Error('invalid seedhashhex');return value}
export function manifestPath(value:unknown):string {if(typeof value!=='string'||!value||new TextEncoder().encode(value).length>512||value==='index.html'||value.startsWith('/')||value.includes('\\')||/^[a-z][a-z0-9+.-]*:/i.test(value)||/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)||value.split('/').some(s=>!s||s==='.'||s==='..'||new TextEncoder().encode(s).length>255))throw new Error('unsafe manifest path');return value}
export function validatePublication(value:unknown):Publication {
 const p=value as Publication;const kind=p?.kind;
 if(!['url','files','both'].includes(kind))throw new Error('invalid publication kind');
 fields(p,['version','appVersion','kind','appPublicKeyHex','name','description',...(kind!=='files'?['url']:[]),...(kind!=='url'?['files']:[])]);
 validateAppVersion(p.appVersion);if(p.version!==1)throw new Error('invalid publication version');if(typeof p.appPublicKeyHex!=='string'||!/^(02|03)[0-9a-f]{64}$/.test(p.appPublicKeyHex))throw new Error('invalid App public key');text(p.name,120);text(p.description,2000,false);
 if(kind!=='files'){fields(p.url,['address','icon']);for(const v of [p.url!.address,p.url!.icon])if(publicationURL(v)!==v||v.length>8192)throw new Error('noncanonical publication URL')}
 if(kind!=='url'){fields(p.files,['entrySeedhashhex','icon','files']);seedhash(p.files!.entrySeedhashhex);seedhash(p.files!.icon);if(!Array.isArray(p.files!.files)||p.files!.files.length>MAX_FILES_ENTRIES)throw new Error('invalid manifest');let last='';for(const f of p.files!.files){fields(f,['path','mime','size','seedhashhex']);manifestPath(f.path);if(f.path<=last)throw new Error('manifest must be sorted and unique');last=f.path;text(f.mime,256);if(!Number.isSafeInteger(f.size)||f.size<0)throw new Error('invalid file size');seedhash(f.seedhashhex)}if(!p.files!.files.some(f=>f.seedhashhex===p.files!.icon))throw new Error('icon seed absent from manifest')}
 return p;
}

export function validatePublicationProof(value:unknown):PublicationProof {fields(value,['publication','signatureHex']);const p=value as PublicationProof;validatePublication(p.publication);if(typeof p.signatureHex!=='string'||!/^[0-9a-f]{128}$/.test(p.signatureHex))throw new Error('invalid publication signature');return p}

/** 严格三段发布版本；按十进制整数比较，避免字符串排序及浮点精度问题。 */
export function validateAppVersion(value: unknown): string {
 if (typeof value !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value)) throw new Error("Invalid appVersion");
 return value;
}
export function compareAppVersions(a: string, b: string): number {
 const left=validateAppVersion(a).split("."), right=validateAppVersion(b).split(".");
 for(let i=0;i<3;i++){const x=left[i]!,y=right[i]!;if(x.length!==y.length)return x.length<y.length?-1:1;if(x!==y)return x<y?-1:1;}return 0;
}
