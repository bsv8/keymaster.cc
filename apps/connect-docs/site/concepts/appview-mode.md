# appView 模式

当 Keymaster 主动启动 App 时，App 使用一次性令牌并把 `window.opener` 作为 Session Window。

```ts
const keymaster = new KeymasterConnectClient({
  targetOrigin: sessionWindowOrigin, // Session Window 的精确来源
  mode: "appView"
});

await keymaster.connect();
const session = await keymaster.launch({ launchToken, appIdentity });
```

SDK 会复用已有 opener，监听就绪后发送 ready。opener 缺失或丢失时安全失败，不会改用
`window.open()`。`connect.launch` 不能在 Popup 模式使用，无效令牌也不能降级成登录。
