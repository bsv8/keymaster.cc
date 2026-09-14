# 快速开始

```bash
pnpm add @keymaster/connect
```

```ts
import { KeymasterConnectClient } from "@keymaster/connect";

const keymaster = new KeymasterConnectClient({
  targetOrigin: getRequiredConfig("KEYMASTER_ORIGIN") // 受信任钱包来源
});

const session = await keymaster.login({ text: "登录示例应用" });
localStorage.setItem("keymaster.connectSessionId", session.connectSessionId);
```

首次登录应由用户点击触发。App 不能在请求里选择 Owner；用户在 Keymaster 中确认。

所有业务方法都携带会话编号：

```ts
const result = await keymaster.identityGet({
  aud: location.origin,       // 断言接收方，必须是当前来源
  iat: now,                   // 签发时间，Unix 秒
  exp: now + 300,             // 过期时间，Unix 秒
  claims: ["key.label"],      // 请求的身份字段
  connectSessionId: session.connectSessionId
});
```

窗口关闭后调用 `resume(savedSessionId)`；需要撤销授权时调用 `logout(savedSessionId)`。
完整方法见[能力索引](/guide/capabilities)，精确字段见[API](/api/)。
