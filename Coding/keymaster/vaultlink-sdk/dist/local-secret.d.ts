export interface LocalSecretV3 {
    version: 3;
    keySource: "active-key-hkdf-v1";
    saltHex: string;
    nonceHex: string;
    ciphertextHex: string;
}
export declare function validateLocalScope(scope: string): string;
export declare function validateLocalSecret(value: unknown): LocalSecretV3;
