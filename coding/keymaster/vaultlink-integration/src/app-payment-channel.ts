/** 稳定的 App 渠道编号；保留原 owner，不因渠道命名改动而清零会话账本。
 * 核心编号上限 96 字节；用完整 SHA-256 避免把 owner/name/用途拼成长编号。
 */
/** Historical v1 identifier. Never migrate its origin allowance to a publisher. */
export async function appPaymentChannelId(owner: string, name: string, paymentType: string, network: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(["keymaster.app-payment-channel.v1", owner, name, paymentType, network]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "pay." + Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
/** New namespace: verified publisher + type + network, isolated by wallet store.
 * Names/origins/App ids cannot create another allowance for the same publisher.
 * Caller must obtain publisher from its authenticated Connect session.
 */
export function publisherPaymentOwner(publisher: string): string {
  if (!/^0[23][0-9a-f]{64}$/i.test(publisher)) throw Error("invalid-publisher");
  return "publisher." + publisher.toLowerCase();
}
export async function publisherPaymentChannelId(publisher: string, paymentType: string, network: string): Promise<string> {
  if (!["p2pkh", "p2pk"].includes(paymentType) || !["main", "test"].includes(network)) throw Error("unsupported");
  return appPaymentChannelId(publisherPaymentOwner(publisher), "publisher-single.v1", paymentType, network);
}
/** Old sessions and pending liabilities remain untouched. New policy sessions
 * have an explicit namespace instead of rebinding the owner of an old session.
 */
export async function publisherPaymentSessionId(sessionId: string): Promise<string> {
  return appPaymentChannelId("connect-session", sessionId, "publisher-single.v1", "session");
}
