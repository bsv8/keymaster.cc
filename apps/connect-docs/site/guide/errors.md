# 错误与取消

```ts
try {
  await keymaster.resume(sessionId);
} catch (error) {
  if (error instanceof KeymasterProtocolError) console.log(error.code);
  if (error instanceof KeymasterTransportError) console.log(error.code);
}
```

- `KeymasterProtocolError`：Keymaster 已收到请求，但按业务或策略拒绝。应判断 `code`，不要解析英文信息。请求未开启的资产（如未启用 testnet 时的 `bsv-testnet`）会收到 `asset_not_enabled`。
- `KeymasterTransportError`：弹窗拦截、窗口关闭、超时、opener 丢失或客户端关闭；不表示会话已注销。

请求可传 `AbortSignal`。取消会立即拒绝本地 Promise，并尽力发送 cancel；已经执行的外部操作
不保证可以补偿，结果未知时应查询业务状态，不能盲目重试。
