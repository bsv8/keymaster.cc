/**
 * Signed application identity carried by Connect.
 *
 * The proof is deliberately small and contains no deployment origin.  An app
 * may be hosted at more than one origin while its publisher/app namespace
 * remains stable.
 */
export interface AppIdentityProofV1 {
  version: 1;
  publisherPublicKey: string;
  app: {
    id: string;
    name: string;
  };
  signature: string;
}

/** The immutable identity snapshot stored in a Connect session. */
export interface VerifiedAppIdentity {
  version: 1;
  publisherPublicKeyHex: string;
  appId: string;
  appName: string;
  identityDigestHex: string;
}

export type AppIdentitySnapshot = VerifiedAppIdentity;
