# @keymaster/connect

Keymaster Connect V1 的浏览器 SDK。App 可以请求身份、签名、加密、转账、Channel、Storage 和
MSFile 能力，但不会取得用户私钥。

```ts
import { KeymasterConnectClient } from "@keymaster/connect";

const keymaster = new KeymasterConnectClient({
  networkIdentity: { bsvNetwork: "main", publicKeyHex: selectedPublicKeyHex },
  targetOrigin: getRequiredConfig("KEYMASTER_ORIGIN") // 受信任 Keymaster 来源
});

const session = await keymaster.login({ text: "登录示例应用" });

// 先注册支付用途，再在每次付款中携带返回的渠道编号。
const { channelId } = await keymaster.registerPaymentChannel({
  connectSessionId: session.connectSessionId,
  channelName: "checkout",
  paymentType: "p2pkh"
});
await keymaster.p2pkhTransfer({
  connectSessionId: session.connectSessionId,
  channelId,
  recipientAddress: recipient,
  amountSatoshis: 1000
});
```

初始化必须提供钱包的完整 `NetworkIdentity`，公钥是目标钱包公钥。该身份在客户端生命周期内固定；请求、回复、登录/恢复/启动结果及事件均核对网络与公钥。`ready` 只表示传输可用。

SDK 没有默认 Keymaster 地址。直接接入必须提供精确 origin；appView 从启动 URL 获取
Session Window origin。完整中文指南和自动生成的字段说明位于 `apps/connect-docs`。

注册不授予免确认额度。用户在钱包设置单笔及 App 会话累计额度；超过任一额度时，
软件弹窗或硬件实体确认。恢复同一连接不会清零累计。旧付款调用必须补充 channelId，
缺编号会拒绝；没有隐式默认渠道。费用池 prepare/commit 同样必须带编号，并保持一致。
