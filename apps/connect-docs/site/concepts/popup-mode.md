# Popup 模式

Popup 是独立部署网页的默认模式：

```ts
const keymaster = new KeymasterConnectClient({
  targetOrigin: keymasterDeploymentOrigin, // 受信任 Keymaster 的精确来源
  mode: "popup"
});
```

首次连接会安装监听、打开 `/protocol/v1/popup`、等待 ready，然后开始请求。应从用户点击中
发起首次操作，避免浏览器拦截弹窗。

`close()` 只关闭 SDK 创建的窗口并拒绝本地等待任务，不会自动执行 `connect.logout`。
