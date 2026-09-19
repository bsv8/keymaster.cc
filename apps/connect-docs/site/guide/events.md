# 接收事件

```ts
const keymaster = new KeymasterConnectClient({
  targetOrigin: keymasterDeploymentOrigin,
  onEvent(event) {
    if (event.event === "channel.message_received") {
      const { channel, publisherPublicKeyHex, messageId, content } = event.data;
    }
    if (event.event === "price.changed") {
      const { amount, unit, updatedAtMs } = event.data;
    }
  }
});
```

`price.changed` 只推给先调用过 `price.subscribe` 的会话；相同价格不会重复推送。

事件不占用请求编号，只接受配置来源和当前窗口的消息。Transport 断开后停止投递；这是实时
事件而不是历史服务，需要长期保存的数据应由 App 自己持久化，并在重连后恢复精确订阅集合。
