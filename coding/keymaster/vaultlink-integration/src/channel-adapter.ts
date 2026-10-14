import {parsePublicKey,inboxChannel,parseMessageID,signatureFromDER} from 'bsv8-channel-protocol';
import {marshal as marshalPublic,parseAndVerify as verifyPublic,type SignedPublicMessage,type UnsignedPublicMessage} from 'bsv8-channel-protocol/public-message';
import {marshal as marshalHash,parseAndVerify as verifyHash,HASH_REQUEST_CHANNEL,type SignedHashRequest,type UnsignedHashRequest} from 'bsv8-channel-protocol/hash-request';
import {marshalEnvelope,parseEnvelope,verifySignedPrivateMessage,privateMessageMaxLifetimeMs,type SignedPrivateMessage,type UnsignedPrivateMessage} from 'bsv8-channel-protocol/inbox';
import {canonicalJson,parseCanonicalJson,channelSigningObject,type JsonValue} from '@vaultlink/sdk';
import type {VaultLinkHardwareBackend} from './hardware-backend.js';

/** Keeps Channel's existing 0.6.0 wire bytes and verified-message branding.
 * Hardware receives the complete object and never a caller-supplied digest. */
export function createHardwareChannelAdapter(backend:()=>VaultLinkHardwareBackend,owner:()=>string) {
  const capture=()=>{const publicKey=parsePublicKey(owner()),device=backend();return {publicKey,device};};
  const guard=(pub:string,device:VaultLinkHardwareBackend)=>{if(owner()!==pub||backend()!==device)throw Error('Channel owner changed');};
  const logical=(value:unknown,kind:'public'|'hash'|'private')=>channelSigningObject(value as {[key:string]:JsonValue},kind);
  return {
    async signPublic(input:Omit<UnsignedPublicMessage,'from_public_key'>,signal?:AbortSignal):Promise<SignedPublicMessage> {
      const {publicKey,device}=capture();const unsigned=structuredClone({...input,from_public_key:publicKey});
      const signature=signatureFromDER(await device.channelOperation('public',logical(unsigned,'public'),signal));guard(publicKey,device);
      const signed={...unsigned,signature};verifyPublic(signed.channel,marshalPublic(signed));return signed;
    },
    async signHash(input:Omit<UnsignedHashRequest,'from_public_key'>,signal?:AbortSignal):Promise<SignedHashRequest> {
      const {publicKey,device}=capture();const unsigned=structuredClone({...input,from_public_key:publicKey});
      const signature=signatureFromDER(await device.channelOperation('hash',logical({...unsigned,channel:HASH_REQUEST_CHANNEL},'hash'),signal));guard(publicKey,device);
      const signed={...unsigned,signature};verifyHash(HASH_REQUEST_CHANNEL,marshalHash(signed));return signed;
    },
    async signPrivate(input:{recipientPublicKeyHex:string;protocol:UnsignedPrivateMessage['protocol'];body:UnsignedPrivateMessage['body'];messageId:string;nowMs:number},signal?:AbortSignal):Promise<SignedPrivateMessage> {
      const {publicKey,device}=capture();const unsigned=structuredClone({channel:inboxChannel(parsePublicKey(input.recipientPublicKeyHex)),from_public_key:publicKey,
        protocol:input.protocol,body:input.body,message_id:parseMessageID(input.messageId),issued_at_ms:input.nowMs,expires_at_ms:input.nowMs+privateMessageMaxLifetimeMs(input.protocol)}) as UnsignedPrivateMessage;
      const signature=signatureFromDER(await device.channelOperation('private',logical(unsigned,'private'),signal));guard(publicKey,device);
      const signed={...unsigned,signature};verifySignedPrivateMessage(signed);return signed;
    },
    async seal(signed:SignedPrivateMessage,signal?:AbortSignal) {
      const {publicKey,device}=capture();if(signed.from_public_key!==publicKey)throw Error('Channel owner changed');verifySignedPrivateMessage(signed);
      const bytes=await device.channelOperation('seal',canonicalJson(signed as unknown as JsonValue),signal);guard(publicKey,device);
      const {channel,...wire}=parseCanonicalJson(bytes) as {[key:string]:JsonValue};
      if(channel!==signed.channel)throw Error('Channel recipient changed');return parseEnvelope(signed.channel,canonicalJson(wire));
    },
    async open(channel:string,envelope:string|Uint8Array,signal?:AbortSignal) {
      const {publicKey,device}=capture();if(channel!==inboxChannel(publicKey))throw Error('Channel recipient changed');
      const parsed=parseEnvelope(channel,envelope);const bytes=await device.channelOperation('open',canonicalJson(parsed as unknown as JsonValue),signal);
      try {guard(publicKey,device);const full=parseCanonicalJson(bytes) as unknown as SignedPrivateMessage;
        if(full.channel!==channel||full.from_public_key!==parsed.from_public_key)throw Error('Channel sender changed');
        return verifySignedPrivateMessage(full);
      }finally{bytes.fill(0);}
    },
  };
}
