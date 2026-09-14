---
pageClass: capability-map-page
---

# 能力索引

所有方法都由 [`KeymasterConnectClient`](/api/classes/KeymasterConnectClient) 提供。
除 `connect.login` 和 `connect.launch` 外，请求都必须属于已有 `connectSessionId`。

| 方法 | 中文用途 |
| --- | --- |
| `connect.login` | 用户选择 Owner 后创建持久会话 |
| `connect.resume` | 为已有会话恢复短期解锁环境 |
| `connect.logout` | 撤销会话及其订阅和授权 |
| `connect.launch` | 使用 appView 一次性令牌建立会话 |
| `identity.get` | 返回有有效期、接收方和签名的身份断言 |
| `intent.sign` | 在明确用户意图下签署 App 提供的字节 |
| `cipher.encrypt` / `cipher.decrypt` | 在当前 Owner 和精确 origin 下加解密二进制内容 |
| `p2pkh.transfer` | 请求受控的主网 P2PKH 转账 |
| `feepool.prepare` / `feepool.commit` | 准备并提交两阶段费用池操作 |
| `channel.publish` | 向精确频道发布已签名 JSON |
| `channel.subscription_set` | 替换当前会话贡献的精确订阅集合 |
| `storage.list` | 列出 App 隔离命名空间中的目录和对象 |
| `storage.directory.create/delete` | 创建或删除目录标记 |
| `storage.put/get/delete` | 写入、读取或删除对象 |
| `storage.upload.begin/part/complete/abort` | 管理 multipart（分片）上传 |
| `msfile.stat` | 查询内容所在 Supplier 和报价 |
| `msfile.seed.read` / `msfile.block.read` | 读取并校验 Seed 或 Block |

## 公共调用选项

```ts
const result = await keymaster.identityGet(params, {
  requestId: crypto.randomUUID(), // 本次请求编号
  timeoutMs: 30_000,              // 本地等待上限，毫秒
  signal: abortController.signal  // 取消信号
});
```

精确 Params（参数）、Result（结果）、常量和每个字段的中文解释以
[API 页面](/api/)为准。也可以使用底层 `request(method, params)`；方法字面量会推导正确类型。

## Channel 事件

`channel.message_received` 推送已经验签的频道、发行人公钥、消息编号和 JSON 内容。
成功发布只表示 Keymaster 接受本地操作，不表示远端已经收到。

## 身份要求

Storage 和 MSFile 需要已验证 App 身份及相应 requirement（所需能力声明）。App 不能指定
Supplier、桶、物理路径、凭据、私钥或付款额度。
