/** 稳定的 App 渠道编号；保留原 owner，不因渠道命名改动而清零会话账本。
 * 核心编号上限 96 字节；用完整 SHA-256 避免把 owner/name/用途拼成长编号。
 */
export async function appPaymentChannelId(owner: string, name: string, paymentType: string, network: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["keymaster.app-payment-channel.v1", owner, name, paymentType, network]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "pay." + Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
