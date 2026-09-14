# @keymaster/connect

Keymaster Connect V1 的浏览器 SDK。App 可以请求身份、签名、加密、转账、Channel、Storage 和
MSFile 能力，但不会取得用户私钥。

```ts
import { KeymasterConnectClient } from "@keymaster/connect";

const keymaster = new KeymasterConnectClient({
  targetOrigin: getRequiredConfig("KEYMASTER_ORIGIN") // 受信任 Keymaster 来源
});

const session = await keymaster.login({ text: "登录示例应用" });
```

SDK 没有默认 Keymaster 地址。直接接入必须提供精确 origin；appView 从启动 URL 获取
Session Window origin。完整中文指南和自动生成的字段说明位于 `apps/connect-docs`。
