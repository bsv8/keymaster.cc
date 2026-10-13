export type SigningMode = "automatic" | "manual";
/** 注册建议只在第一次经钱包批准时使用。网络 + 公钥由账本绑定，不能从申请推断身份。 */
export interface SigningChannel {
    id: string;
    owner: string;
    kind: "plugin" | "app";
    operation: string;
    mode: SigningMode;
    revision: number;
}
export declare const signingOperations: readonly string[];
export declare function inspectSigningChannel(value: SigningChannel): SigningChannel;
export declare function sameSigningRegistration(a: SigningChannel, b: SigningChannel): boolean;
