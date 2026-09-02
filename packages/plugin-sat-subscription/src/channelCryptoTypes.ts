// channelCrypto.ts 的局部运行时类型别名，避免把实现细节暴露到 contracts。

export interface CoordinatorChannelSealResult {
  type: "channel.seal";
  channel: string;
  messageIdBase64Url: string;
  envelopeJson: Uint8Array;
  fromPublicKeyHex: string;
  expiresAtMs: number;
}

export interface CoordinatorChannelOpenResult {
  type: "channel.open";
  channel: string;
  messageIdBase64Url: string;
  signedDigestHex: string;
  fromPublicKeyHex: string;
  toPublicKeyHex: string;
  protocol: string;
  bodyType: "deliver" | "ack";
  contentJson?: Uint8Array;
  acknowledgedMessageIdBase64Url?: string;
  issuedAtMs: number;
  expiresAtMs: number;
}
