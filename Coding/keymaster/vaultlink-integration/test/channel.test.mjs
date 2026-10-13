import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {nativeSdkSources} from './native-sdk-sources.mjs';
import {VaultLinkHardwareBackend,createHardwareChannelAdapter,HardwareWalletPayments,createBitfsPaymentSigner} from '../dist/index.js';
import {DeviceIdentityKey,hex,canonicalJson,channelSigningObject} from '@vaultlink/sdk';
import {parsePrivateKey,publicKeyFromPrivate,parsePublicKey,newMessageID,inboxChannel,parseSHA256Hash} from 'bsv8-channel-protocol';
import {marshal as marshalPublic,parseAndVerify as verifyPublic} from 'bsv8-channel-protocol/public-message';
import {marshal as marshalHash,parseAndVerify as verifyHash,HASH_REQUEST_CHANNEL,newWebRTCSDPLocator} from 'bsv8-channel-protocol/hash-request';
import {signPrivateMessage,sealSigned,open,marshalEnvelope,verifySignedPrivateMessage,validatePongRelation} from 'bsv8-channel-protocol/inbox';
import {createFileQuote,createContentRequest,createContentDelivery,createContentRetrievalRequest,createContentRetrievalUnavailable,createArbitrationRequest,createArbitrationResponse,verifyWireDocument,wireSignatureDigest,buildArbitrationCandidate,MultisigPoolEngine,prepareSellerPresign,encodeRefundPresignRequest} from 'go-bitfs';
import {sha256,decode,encode,feePoolScript,p2pkhScript,serializeTransaction,sha256d,parseTransaction,decodePaymentPolicy,encodePaymentPolicy} from '@vaultlink/sdk';
import {noiseSigningPayload,peerIdFromPublicKeyBytes,peerRecordUnsigned,sha256Bytes} from '../../../../apps/web/node_modules/bitcoin-libp2p/dist/identity/index.js';
import {secp256k1} from '@noble/curves/secp256k1.js';

test('actual RocKey Channel interoperates bidirectionally with Channel SDK 0.6.0, and rejects altered ciphertext and arbitrary scopes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rockey-channel-'));
 const root=process.env.ROCKEY_ROOT??join(fileURLToPath(new URL('../../../../../',import.meta.url)),'Rockey');
 const prefix=process.env.VLP_MBEDTLS_PREFIX??'/opt/homebrew/opt/mbedtls@3',exe=join(dir,'device');
 const cc=spawnSync('c++',['-std=c++17','-Wall','-Wextra','-Werror','-fsanitize=address,undefined',`-I${prefix}/include`,...nativeSdkSources(root),join(root,'Coding/Rockey/vaultlink-integration/tests/native.cpp'),`-L${prefix}/lib`,`-Wl,-rpath,${prefix}/lib`,'-lmbedtls','-lmbedx509','-lmbedcrypto','-o',exe],{encoding:'utf8'});
 assert.equal(cc.status,0,cc.stderr);
 const child=spawn(exe,[join(dir,'policy')]),exited=once(child,'exit');let log='';child.stderr.setEncoding('utf8');child.stderr.on('data',s=>log+=s);
 const iter=child.stdout[Symbol.asyncIterator]();let backend;
 const key=new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),1]));
 const owner=hex(key.publicKey()),peerKey=parsePrivateKey(Uint8Array.from([...new Uint8Array(31),2])),peer=publicKeyFromPrivate(peerKey);
 try{
  backend=await VaultLinkHardwareBackend.connect({async read(){const v=await iter.next();return v.done?null:new Uint8Array(v.value);},async write(b){if(!child.stdin.write(b))await once(child.stdin,'drain');},async close(){child.stdin.end();}},
   {bsvNetwork: "main", publicKeyHex:owner,generations:{walletGeneration:1,backendGeneration:1,hostRunGeneration:1},assertActive(){}},async()=>true);
  // Real libp2p SDK independently verifies every byte reconstructed on device.
  const staticKey=new Uint8Array(32).fill(7);
  const noiseSignature=await backend.signNetworkIdentity('noise',{staticKey});
  assert.equal(secp256k1.verify(noiseSignature,sha256Bytes(noiseSigningPayload(staticKey)),key.publicKey(),{prehash:false,lowS:true,format:"der"}),true);
  const peerId=peerIdFromPublicKeyBytes(key.publicKey());
  for(const sequence of [0n,1n,128n,0xffffffffffffffffn]) {
    const signature=await backend.signNetworkIdentity('peer-record',{sequence:String(sequence)});
    assert.equal(secp256k1.verify(signature,sha256Bytes(peerRecordUnsigned({peerId,addresses:[],sequence},peerId)),key.publicKey(),{prehash:false,lowS:true,format:"der"}),true);
  }
  for(const sequence of ['01','-1','18446744073709551616'])await assert.rejects(backend.signNetworkIdentity('peer-record',{sequence}),/invalid-sequence/);
  await assert.rejects(backend.signNetworkIdentity('noise',{staticKey,digest:new Uint8Array(32)}));
  await assert.rejects(backend.signNetworkIdentity('peer-record',{sequence:'1',addresses:[]}));
  const identityAbort=new AbortController();identityAbort.abort();await assert.rejects(backend.signNetworkIdentity('noise',{staticKey},identityAbort.signal),/identity-cancelled/);
  assert.equal((log.match(/auto-approved:identity.noise-proof/g)??[]).length,1);
  assert.doesNotMatch(log,/review:identity.noise-proof/);assert.match(log,/auto-approved:identity.peer-record/);
  const adapter=createHardwareChannelAdapter(()=>backend,()=>owner),now=Date.now();
  const pub=await adapter.signPublic({channel:'forum.demo',message_id:newMessageID(),issued_at_ms:now,expires_at_ms:now+60000,body:{'😀':1e-7,'漢字':0.000001,large:1e21,negative:-3.141592653589793}});
  assert.deepEqual(canonicalJson(verifyPublic(pub.channel,marshalPublic(pub)).body),canonicalJson(pub.body));
  const hash=await adapter.signHash({message_id:newMessageID(),issued_at_ms:now,expires_at_ms:now+60000,body:{hash:parseSHA256Hash('ab'.repeat(32)),locators:[newWebRTCSDPLocator()]}});
  assert.equal(verifyHash(HASH_REQUEST_CHANNEL,marshalHash(hash)).body.hash,'ab'.repeat(32));
  const signed=await adapter.signPrivate({recipientPublicKeyHex:peer,protocol:'bsv8.message.v1',body:{type:'deliver',content:{text:'実際の通信',amount:0.2}},messageId:newMessageID(),nowMs:now});
  const sealed=await adapter.seal(signed);
  const opened=await open(inboxChannel(peer),marshalEnvelope(sealed),peerKey);assert.equal(opened.to_public_key,peer);assert.deepEqual(canonicalJson(opened.body),canonicalJson(signed.body));
  const inbound=signPrivateMessage({channel:inboxChannel(parsePublicKey(owner)),from_public_key:peer,protocol:'bsv8.ping.v1',message_id:newMessageID(),issued_at_ms:now,expires_at_ms:now+60000,body:{type:'ping'}},peerKey);
  const incoming=await sealSigned(inbound,peerKey),received=await adapter.open(incoming.channel,marshalEnvelope(incoming));
  assert.equal(received.to_public_key,owner);assert.equal(received.from_public_key,peer);assert.equal(received.message_id,inbound.message_id);assert.deepEqual(canonicalJson(received.body),canonicalJson({type:'ping'}));
  const pong=await adapter.signPrivate({recipientPublicKeyHex:peer,protocol:'bsv8.ping.v1',body:{type:'pong',ping_message_id:inbound.message_id},messageId:newMessageID(),nowMs:now});
  validatePongRelation(received,verifySignedPrivateMessage(pong));
  const altered={...incoming,ciphertext:(incoming.ciphertext[0]==='A'?'B':'A')+incoming.ciphertext.slice(1)};
  await assert.rejects(adapter.open(incoming.channel,marshalEnvelope(altered)),/open-failed/);
  await assert.rejects(backend.channelOperation('public',canonicalJson({scope:'arbitrary',channel:'forum.demo',from_public_key:owner,message:{message_id:newMessageID(),issued_at_ms:now,expires_at_ms:now+60000,body:null}})),/invalid-scope/);
  await assert.rejects(backend.channelOperation('private',channelSigningObject({...inbound,from_public_key:owner,protocol:'unknown'},'private')),/unsupported-protocol/);
  const abort=new AbortController();abort.abort();await assert.rejects(adapter.signPublic({...pub,message_id:newMessageID()},abort.signal),/channel-cancelled/);
  assert.match(log,/review:channel.public-message/);assert.match(log,/review:channel.open/);
  // The installed SDK patch must deliver its own exact document, not a digest
  // manufactured by this adapter. Every artifact is parsed by that SDK again.
  const wireSigner={publicKey:()=>key.publicKey(),async sign(request,signal){
    assert.equal(request.purpose,'wire_message');assert.ok(request.documentCBOR instanceof Uint8Array);
    const signature=await backend.signBitfsWire(request.wireKind,request.documentCBOR,signal);
    verifyWireDocument(key.publicKey(),request.wireKind,request.documentCBOR,signature);return signature;
  }};
  const file=Uint8Array.of(1,2,3),quote=await createFileQuote(wireSigner,{seedHash:await sha256(file),buyerPublicKey:key.publicKey(),seedPriceSatoshis:100n,fullBlockPriceSatoshis:200n,fileSizeBytes:3n,quoteExpiresAtUnixSeconds:2000n,supportedArbiterPublicKeys:[],recommendedFilename:'actual.bin'});
  assert.equal(quote.kind,1);const quoteId=await sha256(decode(quote.bytes(),32768)[2]);
  await assert.rejects(createContentRequest(wireSigner,{fileQuoteTermsID:quoteId,refundTemplateTxID:new Uint8Array(32).fill(2),paymentSequence:1,sellerAmountAfterSatoshis:100n,contentHashes:[await sha256(file)],deliveryDeadlineUnixSeconds:2000n}),/Signer 无法完成签名/);
  const authorizationId=await sha256(quote.bytes());assert.equal((await createContentDelivery(wireSigner,authorizationId,[file])).kind,6);
  assert.equal((await createContentRetrievalRequest(wireSigner,new Uint8Array(32).fill(3),new Uint8Array(32).fill(4))).kind,10);
  assert.equal((await createContentRetrievalUnavailable(wireSigner,new Uint8Array(32).fill(5),1)).kind,11);
  const arbiter=new DeviceIdentityKey(Uint8Array.from([...new Uint8Array(31),3]));
  try {
    const roles=[Uint8Array.from(Buffer.from(publicKeyFromPrivate(peerKey),'hex')),key.publicKey(),arbiter.publicKey()];
    const funding=serializeTransaction({version:1,inputs:[{txid:new Uint8Array(32),vout:0xffffffff,script:Uint8Array.of(1),sequence:0xffffffff}],outputs:[{satoshis:1000n,script:feePoolScript(roles)}],locktime:0});
    const openingEngine=new MultisigPoolEngine({buyerPublicKey:roles[0],sellerPublicKey:roles[1],arbiterPublicKey:roles[2]});
    const hardwarePayments=new HardwareWalletPayments(backend,()=>{});
    const sellerPaymentSigner=createBitfsPaymentSigner(wireSigner,{network:'main',role:'seller',assertActive(){key.publicKey();},requestPayment:command=>hardwarePayments.handle(command),previousTransaction:async()=>{throw Error('opening-must-not-fetch-missing-funding');}});
    for(const rate of [...Array(40).fill(0n),1n,1000n]){
      const canonicalRefund=await openingEngine.buildOpeningState(funding,1000,500,Number(rate));
      const buyerSigner={publicKey:()=>roles[0],sign:async request=>secp256k1.sign(request.digest,peerKey,{prehash:false,lowS:true,format:'der'})};
      const buyerSignature=await openingEngine.signRole(buyerSigner,'buyer',canonicalRefund,1000n);
      const openingRequest=encodeRefundPresignRequest({refundTemplateRaw:canonicalRefund,buyerPublicKey:roles[0],sellerPublicKey:roles[1],arbiterPublicKey:roles[2],minerFeeRateSatoshisPerKilobyte:rate,buyerRefundTransactionSignature:buyerSignature});
      const response=await prepareSellerPresign(openingRequest.bytes(),sellerPaymentSigner),signed=decode(response.outbound.bytes(),16384)[3];
      openingEngine.verifyRole('seller',canonicalRefund,1000n,signed);
      const malicious=decode(openingRequest.bytes(),16384);malicious[7]=new Uint8Array(buyerSignature).fill(0);
      await assert.rejects(backend.signFeePool({family:'bitfs',stage:'state',role:'cosigner',rawTx:canonicalRefund,prevTransactions:[],openingRequest:encode(malicious,16384),channelId:'bitfs.seller.main',paymentId:crypto.randomUUID(),sessionId:null,network:'main'}),/invalid-signature/);
    }
    const refund=serializeTransaction({version:1,inputs:[{txid:await sha256d(funding),vout:0,script:new Uint8Array(),sequence:0}],outputs:roles.map((pub,index)=>({satoshis:index===0?990n:0n,script:p2pkhScript(pub)})),locktime:500});
    const claimQuote=await createFileQuote(wireSigner,{seedHash:await sha256(file),buyerPublicKey:roles[0],seedPriceSatoshis:100n,fullBlockPriceSatoshis:200n,fileSizeBytes:3n,quoteExpiresAtUnixSeconds:2000n,supportedArbiterPublicKeys:[arbiter.publicKey()],recommendedFilename:'actual.bin'});
    const doc=encode([await sha256(decode(claimQuote.bytes(),32768)[2]),await sha256d(refund),1,100n,encode([await sha256(file)]),2000],16384);
    const buyerSignature=secp256k1.sign(wireSignatureDigest(5,doc),peerKey,{prehash:false,lowS:true,format:'der'});
    const claim=await createArbitrationRequest(wireSigner,encode([1000n,feePoolScript(roles),refund,doc,buyerSignature],16384),[file]);assert.equal(claim.kind,8);
    await assert.rejects(backend.signBitfsWire(8,encode([1000n,feePoolScript(roles),refund,doc,new Uint8Array(buyerSignature).fill(0)],16384)),/invalid-signature/);
    // An actual device transaction signature is attached to Kind 9, rather than
    // inventing bytes that merely pass a nonempty-signature structural check.
    const arbitrationRoles=[roles[0],arbiter.publicKey(),key.publicKey()];
    const arbitrationFunding=serializeTransaction({...parseTransaction(funding),outputs:[{satoshis:1000n,script:feePoolScript(arbitrationRoles)}]});
    const arbitrationRefund=serializeTransaction({version:1,inputs:[{txid:await sha256d(arbitrationFunding),vout:0,script:new Uint8Array(),sequence:0}],outputs:arbitrationRoles.map((pub,index)=>({satoshis:index===0?990n:0n,script:p2pkhScript(pub)})),locktime:500});
    const sellerSigner={publicKey:()=>arbiter.publicKey(),sign:request=>arbiter.signBitfsWire({kind:request.wireKind,document:request.documentCBOR},new AbortController().signal,async()=>true)};
    const arbitrationQuote=await createFileQuote(sellerSigner,{seedHash:await sha256(file),buyerPublicKey:roles[0],seedPriceSatoshis:100n,fullBlockPriceSatoshis:200n,fileSizeBytes:3n,quoteExpiresAtUnixSeconds:2000n,supportedArbiterPublicKeys:[key.publicKey()],recommendedFilename:'actual.bin'});
    const arbitrationDocument=encode([await sha256(decode(arbitrationQuote.bytes(),32768)[2]),await sha256d(arbitrationRefund),1,100n,encode([await sha256(file)]),2000],16384);
    const arbitrationBuyerSignature=secp256k1.sign(wireSignatureDigest(5,arbitrationDocument),peerKey,{prehash:false,lowS:true,format:'der'});
    const arbitrationClaim=await createArbitrationRequest(sellerSigner,encode([1000n,feePoolScript(arbitrationRoles),arbitrationRefund,arbitrationDocument,arbitrationBuyerSignature],16384),[file]);
    const arbitrationTx=buildArbitrationCandidate({refundTemplateRaw:arbitrationRefund,poolOutputSatoshis:1000n,paymentSequence:1n,sellerAmountSatoshis:100n,arbiterAmountSatoshis:10n});
    await backend.configureChannel({id:'bitfs.arbiter',owner:'msfile',kind:'plugin',network:'main',paymentType:'feepool.bitfs.cosigner',singleLimit:0n,defaultSessionLimit:0n,enabled:true,revision:1});
    const arbitrationSignature=await backend.signFeePool({family:'bitfs',stage:'state',role:'cosigner',rawTx:arbitrationTx,prevTransactions:[arbitrationFunding],channelId:'bitfs.arbiter',paymentId:crypto.randomUUID(),sessionId:null,network:'main'});
    assert.equal((await createArbitrationResponse(wireSigner,encode([await sha256(decode(arbitrationClaim.bytes(),32768)[2]),10n,arbitrationSignature.signatures[0].slice(0,-1)],16384))).kind,9);
  }finally{arbiter.close();}
  const exported=await backend.exportPaymentPolicy();assert.ok(exported.length>8192,'exercise multiple real encrypted chunks');
  const snapshot=decodePaymentPolicy(exported,owner);assert.ok(snapshot.pending.length>=43);
  const disk=new Uint8Array(await readFile(join(dir,'policy')));
  assert.deepEqual(encodePaymentPolicy(decodePaymentPolicy(disk,owner),owner),exported);
  await assert.rejects(backend.signBitfsWire(2,new Uint8Array(32)),/unsupported-kind/);
  assert.equal((log.match(/review:bitfs.wire-sign/g)??[]).length,7);
 }finally{
  key.close();peerKey.fill(0);await backend?.close();child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),3000);const [code]=await exited;clearTimeout(timer);
  await rm(dir,{recursive:true,force:true});assert.equal(code,0,log);
 }
});
