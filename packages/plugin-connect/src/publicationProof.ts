import {secp256k1} from '@noble/curves/secp256k1.js';
import {sha256} from '@noble/hashes/sha2.js';
import {canonicalOrigin} from '@keymaster/contracts';
import {validatePublicationProof,canonicalPublicationJSON} from './publicationShape';
export class PublicationProofValidationError extends Error {readonly code:'invalid_origin'|'invalid_request';constructor(code:'invalid_origin'|'invalid_request',message:string){super(message);this.code=code;this.name='PublicationProofValidationError'}}
/** 解码发布记录字符串：外层格式、无填充且规范的 base64url、UTF-8、规范 JSON 与完整发布字段。 */
function decodePublicationRecord(content:string) {
 const m=/^([A-Za-z0-9_-]+)\.([0-9a-f]{128})$/.exec(content);if(!m||m[1]!.length%4===1)throw new Error('publication encoding invalid');
 const raw=atob(m[1]!.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(m[1]!.length/4)*4,'='));
 if(btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')!==m[1])throw new Error('noncanonical publication encoding');
 const json=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Uint8Array.from(raw,c=>c.charCodeAt(0)));const publication=JSON.parse(json);
 if(canonicalPublicationJSON(publication)!==json)throw new Error('noncanonical publication JSON');
 return validatePublicationProof({publication,signatureHex:m[2]!});
}
export function verifyLoginPublicationProof(value:unknown,eventOrigin:string){
 if(value===undefined||value===null)return null;
 if(typeof value!=='string'||!value)throw new PublicationProofValidationError('invalid_request','publicationProof must be a non-empty record string');
 try{const proof=decodePublicationRecord(value),p=proof.publication;
 if(!p.url||canonicalOrigin(new URL(p.url.address).origin)!==canonicalOrigin(eventOrigin))throw new PublicationProofValidationError('invalid_origin','publication origin mismatch');
 const bytes=new TextEncoder().encode('keymaster.app-publication.v1\0'+canonicalPublicationJSON(p));
 const hex=(s:string)=>Uint8Array.from(s.match(/../g)!,b=>parseInt(b,16));
 if(!secp256k1.verify(hex(proof.signatureHex),sha256(bytes),hex(p.appPublicKeyHex),{prehash:false,format:'compact',lowS:true}))throw new Error('publication signature mismatch');
 return {appPublicKeyHex:p.appPublicKeyHex, publication:{appPublicKeyHex:p.appPublicKeyHex,appVersion:p.appVersion,name:p.name,description:p.description,icon:p.url.icon,urls:[{url:p.url.address,origin:eventOrigin,display:{name:p.name,description:p.description,icon:p.url.icon}}],files:[]},display:{name:p.name,description:p.description,icon:p.url.icon}};
 }catch(error){if(error instanceof PublicationProofValidationError)throw error;throw new PublicationProofValidationError('invalid_request',error instanceof Error?error.message:'invalid publication proof')}
}
