export type SigningMode = "automatic" | "manual";
/** 网络 + 公钥由账本绑定；已知操作静默注册，通用 digest 不属于自动操作。 */
export interface SigningChannel {
    id: string;
    owner: string;
    kind: "plugin" | "app";
    operation: string;
    mode: SigningMode;
    revision: number;
}
export declare const signingOperations: readonly string[];
/** This allowlist is not a digest-signing permission: typed callers still validate
 * the full operation document before entering the signing policy. */
export declare function automaticSigningOperation(operation: string): boolean;
export declare function inspectSigningChannel(value: SigningChannel): SigningChannel;
export declare function sameSigningRegistration(a: SigningChannel, b: SigningChannel): boolean;
