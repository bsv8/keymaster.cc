import {secp256k1} from '@noble/curves/secp256k1.js';
import {sha256} from '@noble/hashes/sha2.js';
import {canonicalOrigin} from '@keymaster/contracts';
import {validatePublicationProof,canonicalPublicationJSON} from './publicationShape';
export class PublicationProofValidationError extends Error {readonly code:'invalid_origin'|'invalid_request';constructor(code:'invalid_origin'|'invalid_request',message:string){super(message);this.code=code}}
export function verifyLoginPublicationProof(value:unknown,eventOrigin:string){
 if(value===undefined||value===null)return null;
 try{const proof=validatePublicationProof(value),p=proof.publication;
 if(!p.url||canonicalOrigin(new URL(p.url.address).origin)!==canonicalOrigin(eventOrigin))throw new PublicationProofValidationError('invalid_origin','publication origin mismatch');
 const bytes=new TextEncoder().encode('keymaster.app-publication.v1\0'+canonicalPublicationJSON(p));
 const hex=(s:string)=>Uint8Array.from(s.match(/../g)!,b=>parseInt(b,16));
 if(!secp256k1.verify(hex(proof.signatureHex),sha256(bytes),hex(p.appPublicKeyHex),{prehash:false,format:'compact',lowS:true}))throw new Error('publication signature mismatch');
 return {appPublicKeyHex:p.appPublicKeyHex,display:{name:p.name,description:p.description,icon:p.url.icon}};
 }catch(error){if(error instanceof PublicationProofValidationError)throw error;throw new PublicationProofValidationError('invalid_request',error instanceof Error?error.message:'invalid publication proof')}
}
