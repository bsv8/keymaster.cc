# appView 模式

当 Keymaster 主动启动 App 时，App 使用一次性令牌并把 `window.opener` 作为 Session Window。
初始化同时传入启动上下文中的完整 `networkIdentity`，不能固定 main，也不能用 App 发布者公钥替代钱包公钥。

```ts
const keymaster = new KeymasterConnectClient({
  networkIdentity: networkIdentityFromLaunch, // 启动上下文中的钱包完整身份
  targetOrigin: sessionWindowOrigin, // Session Window 的精确来源
  mode: "appView"
});

await keymaster.connect();
const session = await keymaster.launch({ launchToken, appIdentity });
```

SDK 会复用已有 opener，监听就绪后发送 ready。opener 缺失或丢失时安全失败，不会改用
`window.open()`。`connect.launch` 不能在 Popup 模式使用，无效令牌也不能降级成登录。
