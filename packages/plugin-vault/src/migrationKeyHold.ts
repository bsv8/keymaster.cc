// Private Coordinator Worker helper. It uses the same real KeyHold SDK as
// ordinary creation/unlock, then verifies the new ciphertext before replacing
// key.json. Neither the private key nor a decrypted copy may reach Window.
import {createKeyHoldDocument,decryptKeyHoldDocument,serializeKeyHoldDocument} from './keyholdDocument.js';
export async function createAndVerifyMigrationKeyHold(input:{bsvNetwork:import("@keymaster/contracts").BsvNetwork;privateKey:Uint8Array;publicKeyHex:string;label:string},password:string,options?:{iterations?:number}):Promise<Uint8Array> {
  const document=await createKeyHoldDocument({bsvNetwork:input.bsvNetwork,label:input.label,privateKey:input.privateKey},password,options);
  if(document.publicKeyHex!==input.publicKeyHex)throw Error('migration-conflict');
  const verified=await decryptKeyHoldDocument(document,password);
  try {
    if(verified.publicKeyHex!==input.publicKeyHex||verified.privateKey.length!==input.privateKey.length
      ||verified.privateKey.some((b,i)=>b!==input.privateKey[i]))throw Error('migration-conflict');
    return new TextEncoder().encode(serializeKeyHoldDocument(document));
  }finally{verified.privateKey.fill(0);}
}
