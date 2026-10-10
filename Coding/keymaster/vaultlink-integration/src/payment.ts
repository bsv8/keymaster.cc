import {
  PaymentPolicy,
  type PolicyStore,
  type ChannelConfig,
  type PaymentInspection,
  type Quote,
} from "@vaultlink/sdk";
export type {
  PolicyStore,
  ChannelConfig,
  PaymentInspection,
  Quote,
} from "@vaultlink/sdk";
/** 软件后端配额适配器：使用 SDK 的同一串行/持久规则；仅超额调用用户确认。
 * caller 必须绑定真实 Coordinator owner/会话及从实际交易计算的 amount/commitment。
 * signer 是内部后端执行能力，不暴露给普通 App；不以 broadcast 失败释放已签额度。
 */
export class SoftwarePaymentGate {
  private constructor(
    private policy: PaymentPolicy,
    private assertActive: () => void,
  ) {}
  static async open(
    store: PolicyStore,
    publicKeyHex: string,
    assertActive: () => void,
  ): Promise<SoftwarePaymentGate> {
    assertActive();
    const policy = await PaymentPolicy.open(store, publicKeyHex.toLowerCase());
    assertActive();
    return new SoftwarePaymentGate(policy, assertActive);
  }
  async configure(
    config: ChannelConfig,
    confirm: () => Promise<boolean>,
  ): Promise<void> {
    this.assertActive();
    // confirmed 必须来自设置 UI 的真实用户动作，不让插件传布尔值。
    const accepted = await confirm();
    this.assertActive();
    if (!accepted) throw new Error("denied");
    await this.policy.configure(structuredClone(config), true);
    this.assertActive();
  }
  async startSession(
    id: string,
    owner: string,
    confirm: () => Promise<boolean>,
  ): Promise<void> {
    this.assertActive();
    const accepted = await confirm();
    this.assertActive();
    if (!accepted) throw new Error("denied");
    await this.policy.startSession(id, owner, true);
  }
  async execute<T>(
    inspection: PaymentInspection,
    confirm: (
      request: PaymentInspection,
      quote: Quote,
    ) => Promise<{ allow: boolean; raiseSessionLimit?: bigint }>,
    sign: () => Promise<T>,
    beforeSign: () => void = () => {},
  ): Promise<T> {
    this.assertActive();
    const frozen = structuredClone(inspection);
    const quote = await this.policy.quote(frozen);
    let approval;
    if (quote.reasons.length) {
      const answer = await confirm(
        structuredClone(frozen),
        structuredClone(quote),
      );
      this.assertActive();
      if (!answer.allow) throw new Error("denied");
      approval = {
        requestCommitment: frozen.commitment.slice(),
        configRevision: quote.configRevision,
        sessionRevision: quote.sessionRevision,
        ...(answer.raiseSessionLimit === undefined
          ? {}
          : { raiseSessionLimit: answer.raiseSessionLimit }),
      };
    }
    this.assertActive();
    await this.policy.reserve(frozen, approval);
    let signingStarted = false;
    try {
      this.assertActive();
      await this.policy.assertExecutable(frozen.requestId);
      this.assertActive();
      // 宿主在此同步检查请求撤销；尚未进入密码运算的失败有明确未执行证明。
      beforeSign();
      signingStarted = true;
      const result = await sign();
      await this.policy.markSigned(frozen.requestId);
      this.assertActive();
      return result;
    } catch (error) {
      // sign 抛错时可能已经产生签名；没有明确的未执行证明便保留预算。
      if (!signingStarted)
        await this.policy.releaseUnexecuted(frozen.requestId);
      else await this.policy.markUnknown(frozen.requestId);
      throw error;
    }
  }
  inspectPool(id: string, binding: Uint8Array, paid: bigint) {
    this.assertActive();
    return this.policy.inspectPool(id, binding, paid);
  }
  snapshot() {
    this.assertActive();
    return this.policy.snapshot();
  }
  async closeSession(id: string) {
    this.assertActive();
    await this.policy.closeSession(id);
    this.assertActive();
  }
  lock() {
    this.policy.lock();
  }
}
